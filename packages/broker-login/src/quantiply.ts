import type { BrowserContext, Page } from 'playwright';
import { visibleErrorText } from './algotest.js';
import { BrokerLoginError, type BrokerResult, type FailureKind } from './brokers/types.js';
import { describe, safeScreenshot, step } from './diagnose.js';
import { dismissOverlays } from './overlays.js';
import {
  QUANTIPLY_APP_HOST,
  QUANTIPLY_LOGIN_URL,
  classifyQuantiplyError,
  isAngelLoginUrl,
  isQuantiplyLoggedInUrl,
  quantiplyFailureDetail,
  quantiplyRetryDecision,
} from './quantiply-rules.js';
import { angelOneForm, quantiplyPage } from './selectors.js';
import { angelTotp } from './totp.js';

/** Display name in the Telegram report. */
export const QUANTIPLY_NAME = 'Quantiply · Angel One';

const MAX_ATTEMPTS = 2;

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

async function inlineAngelError(page: Page): Promise<string> {
  const error = angelOneForm.error(page);
  if (!(await error.isVisible().catch(() => false))) return '';
  const text = await error.innerText({ timeout: 1_000 }).catch(() => '');
  return text.replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Quantiply's /auth screen -> "Login / Sign Up" -> Angel One's SmartAPI login (TOTP mode: client
 * code, PIN, TOTP) -> back to Quantiply, normally on /algos. Returns 'already' when Quantiply
 * skips its login screen (a session it already has), else 'logged_in'; throws BrokerLoginError
 * on failure. Whether Angel's page opens in the same tab or a popup is handled either way.
 */
export async function quantiplyLogin(
  page: Page,
  creds: QuantiplyCredentials,
  progress: QuantiplyProgress,
): Promise<'logged_in' | 'already'> {
  await step(page, 'quantiply-open', async () => {
    await page.goto(QUANTIPLY_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  });

  const loginButton = quantiplyPage.loginButton(page);
  const alreadyIn = await step(page, 'quantiply-await-login-button', async () => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (isQuantiplyLoggedInUrl(page.url())) return true;
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

  await step(page, 'quantiply-click-login', async () => {
    await loginButton.click();
  });

  const popup = await Promise.race([popupPromise, sameTab]);
  const target = popup ?? page;

  await step(target, 'quantiply-await-angel-page', async () => {
    await target.waitForLoadState('domcontentloaded');
    if (!isAngelLoginUrl(target.url())) {
      await target.waitForURL(isAngelLoginUrl, { timeout: 30_000 });
    }
  });
  console.log(`  Quantiply: on ${where(target)}${popup ? ' (popup)' : ''}`);

  await step(target, 'quantiply-select-totp-mode', async () => {
    const option = angelOneForm.totpModeOption(target);
    await option.waitFor({ state: 'visible', timeout: 20_000 });
    await option.click();
  });

  await step(target, 'quantiply-fill-form', async () => {
    const clientCode = angelOneForm.clientCode(target);
    await clientCode.waitFor({ state: 'visible', timeout: 10_000 });
    await clientCode.fill(creds.clientCode);
    await angelOneForm.mpin(target).fill(creds.mpin);
    // Generated last so as little of the 30-second window as possible is spent, and never from
    // a window this run already used (AlgoTest's Angel One login uses the same seed).
    await angelOneForm.totp(target).fill(await angelTotp(creds.totpSecret));
  });

  await step(target, 'quantiply-submit', async () => {
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
        await safeScreenshot(target, 'quantiply-angel-error');
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
        await safeScreenshot(target, 'quantiply-bounced');
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
    await safeScreenshot(stuck, 'quantiply-no-return');
    const error = isAngelLoginUrl(stuck.url()) ? await visibleErrorText(stuck) : '';
    if (error) throw new BrokerLoginError(error, classifyQuantiplyError(error));
    throw new BrokerLoginError(
      `submitted but never returned to Quantiply (on ${where(stuck)})`,
      'UNKNOWN',
    );
  }

  // Quantiply finishes the session on its side after the redirect; a rejected one bounces the
  // app back to /auth. Give it a moment, then check it stayed outside /auth with no login button.
  await landed.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForTimeout(4_000);
  // A popup that landed and then closed itself hands back to the first tab.
  if (landed.isClosed()) landed = page;
  const stillIn =
    isQuantiplyLoggedInUrl(landed.url()) &&
    !(await quantiplyPage
      .loginButton(landed)
      .isVisible()
      .catch(() => false));
  await safeScreenshot(landed, stillIn ? 'quantiply-logged-in' : 'quantiply-bounced');
  if (!stillIn) {
    throw new BrokerLoginError(
      `returned to Quantiply but it showed the login screen again (on ${where(landed)})`,
      'UNKNOWN',
    );
  }
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
    // 'retry-next-totp-window' needs no explicit wait: angelTotp never reuses this run's window.
    console.log(`  retrying (${decision})`);
  }
  return result('FAIL', lastDetail);
}
