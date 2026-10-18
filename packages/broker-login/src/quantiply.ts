import type { Browser, BrowserContext, Page } from 'playwright';
import { visibleErrorText } from './algotest.js';
import { BrokerLoginError, type BrokerResult, type FailureKind } from './brokers/types.js';
import { describe, dumpHtml, safeScreenshot } from './diagnose.js';
import { dismissOverlays, installOverlayHandlers } from './overlays.js';
import {
  QUANTIPLY_APP_HOST,
  QUANTIPLY_LOGIN_URL,
  classifyQuantiplyError,
  isAngelLoginUrl,
  isQuantiplyLoggedInUrl,
  quantiplyFailureDetail,
  quantiplyRetryDecision,
} from './quantiply-rules.js';
import { QUANTIPLY_LIMIT_MINUTES } from './run-plan.js';
import { angelOneForm, quantiplyPage } from './selectors.js';
import { angelTotp } from './totp.js';

/** Display name in the Telegram report. */
export const QUANTIPLY_NAME = 'Quantiply · Angel One';

const MAX_ATTEMPTS = 2;

/** The most a whole Quantiply login may take, retries and diagnostics included. */
export const QUANTIPLY_TIME_LIMIT_MS = QUANTIPLY_LIMIT_MINUTES * 60_000;

/** How long Quantiply must stay outside /auth, with no login button, to count as logged in. */
const SETTLE_MS = 4_000;

export interface QuantiplyCredentials {
  clientCode: string;
  mpin: string;
  totpSecret: string;
}

/** Set as the attempt goes, so the caller knows whether the credentials were already sent. */
export interface QuantiplyProgress {
  submitted: boolean;
}

/** Origin + path only: Angel's query carries Quantiply's api_key and the redirect a session code. */
function where(page: Page): string {
  if (page.isClosed()) return '(closed)';
  try {
    const url = new URL(page.url());
    return `${url.origin}${url.pathname}`;
  } catch {
    return page.url().slice(0, 60);
  }
}

/**
 * The repo is public and diagnostics are a downloadable artifact: never capture the owner's
 * logged-in Quantiply pages (their algos), only the login screens and Angel's page.
 */
function capturable(page: Page): boolean {
  return !page.isClosed() && !isQuantiplyLoggedInUrl(page.url());
}

async function shot(page: Page, label: string): Promise<void> {
  if (capturable(page)) await safeScreenshot(page, label);
}

/** diagnose.ts's step(), minus captures of logged-in Quantiply pages. */
async function qstep<T>(page: Page, label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    console.error(`  step failed: ${label} -> ${describe(error)}`);
    if (capturable(page)) {
      await safeScreenshot(page, `fail-${label}`);
      await dumpHtml(page, `fail-${label}`);
    }
    throw error;
  }
}

async function inlineAngelError(page: Page): Promise<string> {
  const error = angelOneForm.error(page);
  if (!(await error.isVisible().catch(() => false))) return '';
  const text = await error.innerText({ timeout: 1_000 }).catch(() => '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Quantiply finishes the session on its side after the redirect, and a rejected one bounces the
 * app back to /auth. Logged in = still outside /auth, with no login button, a few seconds later.
 */
async function staysLoggedIn(page: Page): Promise<boolean> {
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForTimeout(SETTLE_MS).catch(() => undefined);
  if (page.isClosed() || !isQuantiplyLoggedInUrl(page.url())) return false;
  return !(await quantiplyPage
    .loginButton(page)
    .isVisible()
    .catch(() => false));
}

/**
 * Quantiply's /auth screen -> "Login / Sign Up" -> Angel One's SmartAPI login (TOTP mode: client
 * code, PIN, TOTP) -> back to Quantiply, normally on /algos. Returns 'already' when Quantiply
 * skips its login screen and stays logged in (a session it already has), else 'logged_in';
 * throws BrokerLoginError on failure. Angel's page in the same tab or a popup both work.
 */
export async function quantiplyLogin(
  page: Page,
  creds: QuantiplyCredentials,
  progress: QuantiplyProgress,
): Promise<'logged_in' | 'already'> {
  await qstep(page, 'quantiply-open', async () => {
    await page.goto(QUANTIPLY_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  });

  const loginButton = quantiplyPage.loginButton(page);
  const alreadyIn = await qstep(page, 'quantiply-await-login-button', async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      // A logged-in URL counts only if it holds: an auth guard may still send it back to /auth,
      // and then the login button appears and the login goes ahead as usual.
      if (isQuantiplyLoggedInUrl(page.url()) && (await staysLoggedIn(page))) return true;
      if (await loginButton.isVisible().catch(() => false)) return false;
      await dismissOverlays(page);
      await page.waitForTimeout(500);
    }
    // One short wait so a failure carries Playwright's usual message and call log.
    await loginButton.waitFor({ state: 'visible', timeout: 1_000 });
    return false;
  });
  if (alreadyIn) return 'already';

  // Same tab (seen on 2026-10-18) or a popup: whichever happens first after the click.
  const popupPromise = page
    .context()
    .waitForEvent('page', { timeout: 30_000 })
    .catch(() => null);
  const sameTab = page
    .waitForURL(isAngelLoginUrl, { timeout: 30_000 })
    .then(() => null)
    .catch(() => null);

  await qstep(page, 'quantiply-click-login', async () => {
    await loginButton.click();
  });

  const popup = await Promise.race([popupPromise, sameTab]);
  const target = popup ?? page;

  await qstep(target, 'quantiply-await-angel-page', async () => {
    await target.waitForLoadState('domcontentloaded');
    if (!isAngelLoginUrl(target.url())) {
      await target.waitForURL(isAngelLoginUrl, { timeout: 30_000 });
    }
  });
  console.log(`  Quantiply: on ${where(target)}${popup ? ' (popup)' : ''}`);

  await qstep(target, 'quantiply-select-totp-mode', async () => {
    const option = angelOneForm.totpModeOption(target);
    await option.waitFor({ state: 'visible', timeout: 20_000 });
    await option.click();
  });

  await qstep(target, 'quantiply-fill-form', async () => {
    const clientCode = angelOneForm.clientCode(target);
    await clientCode.waitFor({ state: 'visible', timeout: 10_000 });
    await clientCode.fill(creds.clientCode);
    await angelOneForm.mpin(target).fill(creds.mpin);
    // Generated last so as little of the 30-second window as possible is spent, and never from
    // a window this run already used (AlgoTest's Angel One login uses the same seed).
    await angelOneForm.totp(target).fill(await angelTotp(creds.totpSecret));
  });

  await qstep(target, 'quantiply-submit', async () => {
    progress.submitted = true;
    await angelOneForm.submit(target).click();
  });

  // Back on Quantiply (either tab), or Angel's inline error while still on Angel's page. The
  // error is read only on Angel's host: Quantiply's own pages could carry unrelated error words.
  const deadline = Date.now() + 60_000;
  let landed: Page | null = null;
  // When Angel's tab comes back to Quantiply's login screen (button showing) and stays there,
  // Quantiply refused the session - fail now rather than wait out the deadline. Only Angel's
  // own tab is watched: with a popup, the first tab sits on that screen the whole time.
  let loginScreenSince: number | null = null;
  while (Date.now() < deadline) {
    if (isQuantiplyLoggedInUrl(page.url())) landed = page;
    else if (!target.isClosed() && isQuantiplyLoggedInUrl(target.url())) landed = target;
    if (landed) break;

    if (!target.isClosed() && isAngelLoginUrl(target.url())) {
      loginScreenSince = null;
      const error = await inlineAngelError(target);
      if (error) {
        await shot(target, 'quantiply-angel-error');
        throw new BrokerLoginError(error, classifyQuantiplyError(error));
      }
    } else if (
      !target.isClosed() &&
      new URL(target.url()).hostname === QUANTIPLY_APP_HOST &&
      (await quantiplyPage
        .loginButton(target)
        .isVisible()
        .catch(() => false))
    ) {
      loginScreenSince ??= Date.now();
      if (Date.now() - loginScreenSince >= 5_000) {
        await shot(target, 'quantiply-bounced');
        throw new BrokerLoginError(
          `returned to Quantiply but it showed the login screen again (on ${where(target)})`,
          'UNKNOWN',
        );
      }
    } else {
      loginScreenSince = null;
    }
    await page.waitForTimeout(1_000);
  }

  if (!landed) {
    const stuck = target.isClosed() ? page : target;
    await shot(stuck, 'quantiply-no-return');
    const error = isAngelLoginUrl(stuck.url()) ? await visibleErrorText(stuck) : '';
    if (error) throw new BrokerLoginError(error, classifyQuantiplyError(error));
    throw new BrokerLoginError(
      `submitted but never returned to Quantiply (on ${where(stuck)})`,
      'UNKNOWN',
    );
  }

  // A popup that landed and then closed itself hands back to the first tab.
  let held = await staysLoggedIn(landed);
  if (!held && landed.isClosed()) {
    landed = page;
    held = isQuantiplyLoggedInUrl(page.url()) && (await staysLoggedIn(page));
  }
  if (!held) {
    await shot(landed, 'quantiply-bounced');
    throw new BrokerLoginError(
      `returned to Quantiply but it showed the login screen again (on ${where(landed)})`,
      'UNKNOWN',
    );
  }
  // No screenshot here: the logged-in page is the owner's algos (see capturable()).
  console.log(`  Quantiply: landed on ${where(landed)}`);

  if (popup && !popup.isClosed()) await popup.close().catch(() => undefined);
  return 'logged_in';
}

/**
 * One Quantiply login with its own retry rules (quantiplyRetryDecision). Never throws: every
 * outcome is a result line, so a Quantiply failure can't stop or hide the AlgoTest logins.
 * `context` should be Quantiply's own browser context, so Angel's session cookies from this
 * login can't change what AlgoTest's Angel One login sees.
 */
export async function runQuantiply(
  context: BrowserContext,
  creds: QuantiplyCredentials,
): Promise<BrokerResult> {
  const started = Date.now();
  const result = (status: BrokerResult['status'], detail: string): BrokerResult => ({
    name: QUANTIPLY_NAME,
    status,
    detail,
  });

  let page: Page;
  try {
    page = await context.newPage();
  } catch (error) {
    return result('FAIL', `could not open a page: ${describe(error)}`);
  }
  page.setDefaultTimeout(15_000);

  let lastDetail = 'unknown failure';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    console.log(`\n${QUANTIPLY_NAME}: attempt ${attempt}/${MAX_ATTEMPTS}`);
    const progress: QuantiplyProgress = { submitted: false };
    let kind: FailureKind = 'UNKNOWN';
    try {
      const outcome = await quantiplyLogin(page, creds, progress);
      if (outcome === 'already') return result('SKIPPED', 'already logged in');
      const seconds = Math.round((Date.now() - started) / 1000);
      return result('OK', `logged in (${seconds}s)`);
    } catch (error) {
      kind = error instanceof BrokerLoginError ? error.kind : 'UNKNOWN';
      lastDetail = describe(error);
      console.error(`  ${QUANTIPLY_NAME} failed (${kind}): ${lastDetail}`);
    }

    const decision = quantiplyRetryDecision(kind, progress.submitted, attempt, MAX_ATTEMPTS);
    if (decision === 'stop') {
      return result('FAIL', quantiplyFailureDetail(lastDetail, kind, progress.submitted));
    }
    // A popup left by the failed attempt would otherwise sit there while the next one opens.
    for (const other of context.pages()) {
      if (other !== page) await other.close().catch(() => undefined);
    }
    // 'retry-next-totp-window' needs no explicit wait: angelTotp never reuses this run's window.
    console.log(`  retrying (${decision})`);
  }
  return result('FAIL', lastDetail);
}

/**
 * runQuantiply in a browser context of its own, never traced (a trace would hold the PIN typed
 * into Angel's page and the redirect's session code) and closed afterwards, so Angel's cookies
 * can't change what AlgoTest's Angel One login sees on the same page. Bounded by `timeLimitMs`
 * whatever a hung page does: on the limit the context is closed, which ends anything in flight.
 * Never throws.
 */
export async function runQuantiplyIsolated(
  browser: Browser,
  creds: QuantiplyCredentials,
  options: {
    timeLimitMs?: number;
    /** Tests only: set up the fresh context (stand-in routes) before the login starts. */
    onContext?: (context: BrowserContext) => Promise<void>;
  } = {},
): Promise<BrokerResult> {
  const timeLimitMs = options.timeLimitMs ?? QUANTIPLY_TIME_LIMIT_MS;
  let context: BrowserContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fail = (detail: string): BrokerResult => ({ name: QUANTIPLY_NAME, status: 'FAIL', detail });
  try {
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    });
    installOverlayHandlers(context);
    await options.onContext?.(context);
    const limit = new Promise<BrokerResult>((resolve) => {
      timer = setTimeout(
        () => resolve(fail(`timed out after ${Math.round(timeLimitMs / 1000)}s - NOT retried`)),
        timeLimitMs,
      );
    });
    return await Promise.race([runQuantiply(context, creds), limit]);
  } catch (error) {
    return fail(describe(error));
  } finally {
    clearTimeout(timer);
    if (context) await context.close().catch(() => undefined);
  }
}
