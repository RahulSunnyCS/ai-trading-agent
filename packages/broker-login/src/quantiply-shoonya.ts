import type { Browser, Page } from 'playwright';
import { classifyError, visibleErrorText } from './algotest.js';
import { BrokerLoginError, type BrokerResult } from './brokers/types.js';
import { describe, dumpHtml, safeScreenshot } from './diagnose.js';
import { dismissOverlays, waitVisibleDismissing } from './overlays.js';
import { QUANTIPLY_SITES, isQuantiplyLoggedInUrl, isShoonyaLoginUrl } from './quantiply-rules.js';
import { finvasiaForm, quantiplyPage } from './selectors.js';
import { shoonyaTotp } from './totp.js';

/**
 * The Quantiply login through Shoonya (BL-140, captured 2026-10-19): quantiply.shoonya.com/auth →
 * "Login / Sign Up" → Shoonya's OAuth page (`api.shoonya.com/OAuthlogin/...&route_to=QUANTIPLY`),
 * the very form AlgoTest's Shoonya login fills (`finvasiaForm`: user id, password, TOTP, or the
 * "Authorize" consent screen when the browser already holds a Shoonya session) → back on
 * quantiply.shoonya.com outside /auth. Kept apart from `quantiply.ts` (Angel One), which the
 * 08:00 run uses, so this route cannot change that one.
 *
 * Never screenshots a logged-in Quantiply page: the repo is public and its pages are the owner's
 * algos. Throws BrokerLoginError on failure; returns 'already' when Quantiply skips its login.
 */

export interface ShoonyaCredentials {
  userId: string;
  password: string;
  totpSecret: string;
}

const SITE = QUANTIPLY_SITES.finvasia;
const SETTLE_MS = 4_000;

const loggedIn = (page: Page) =>
  !page.isClosed() && isQuantiplyLoggedInUrl(page.url(), SITE.appHost);

/** Diagnostics only for pages that are not the owner's logged-in Quantiply. */
async function capture(page: Page, label: string): Promise<void> {
  if (page.isClosed() || loggedIn(page)) return;
  await safeScreenshot(page, label);
  await dumpHtml(page, label);
}

async function stays(page: Page): Promise<boolean> {
  await page.waitForTimeout(SETTLE_MS).catch(() => undefined);
  if (!loggedIn(page)) return false;
  return !(await quantiplyPage
    .loginButton(page)
    .isVisible()
    .catch(() => false));
}

export async function quantiplyShoonyaLogin(
  page: Page,
  creds: ShoonyaCredentials,
): Promise<'logged_in' | 'already'> {
  await page.goto(SITE.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });

  const loginButton = quantiplyPage.loginButton(page);
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (loggedIn(page) && (await stays(page))) return 'already';
    if (await loginButton.isVisible().catch(() => false)) break;
    if (Date.now() > deadline) {
      await capture(page, 'quantiply-shoonya-no-login-button');
      throw new BrokerLoginError('Quantiply · Shoonya: no "Login / Sign Up" button', 'UNKNOWN');
    }
    await dismissOverlays(page);
    await page.waitForTimeout(500);
  }

  const popupPromise = page
    .context()
    .waitForEvent('page', { timeout: 30_000 })
    .catch(() => null);
  const sameTab = page
    .waitForURL(isShoonyaLoginUrl, { timeout: 30_000 })
    .then(() => null)
    .catch(() => null);
  await loginButton.click();
  const target = (await Promise.race([popupPromise, sameTab])) ?? page;

  try {
    await target.waitForLoadState('domcontentloaded');
    if (!isShoonyaLoginUrl(target.url()))
      await target.waitForURL(isShoonyaLoginUrl, { timeout: 30_000 });
    await waitVisibleDismissing(
      target,
      finvasiaForm.userId(target).or(finvasiaForm.authorize(target)).first(),
      30_000,
    );
  } catch (error) {
    await capture(target, 'quantiply-shoonya-no-form');
    throw new BrokerLoginError(`Shoonya's login page did not show: ${describe(error)}`, 'UNKNOWN');
  }

  if (
    await finvasiaForm
      .authorize(target)
      .isVisible()
      .catch(() => false)
  ) {
    await finvasiaForm.authorize(target).click();
  } else {
    await finvasiaForm.userId(target).fill(creds.userId);
    await finvasiaForm.password(target).fill(creds.password);
    // Generated last so as little of the 30-second window as possible is spent.
    await finvasiaForm.totp(target).fill(await shoonyaTotp(creds.totpSecret));
    await finvasiaForm.submit(target).click();
  }

  // Back on Quantiply (either tab), the consent screen, or Shoonya's error while still on its form.
  const until = Date.now() + 60_000;
  let landed: Page | null = null;
  while (Date.now() < until) {
    if (loggedIn(page)) landed = page;
    else if (loggedIn(target)) landed = target;
    if (landed) break;
    if (!target.isClosed() && isShoonyaLoginUrl(target.url())) {
      if (
        await finvasiaForm
          .authorize(target)
          .isVisible()
          .catch(() => false)
      ) {
        await finvasiaForm.authorize(target).click();
      } else if (
        (await finvasiaForm
          .userId(target)
          .count()
          .catch(() => 0)) > 0
      ) {
        const error = await visibleErrorText(target);
        if (error) {
          await capture(target, 'quantiply-shoonya-error');
          throw new BrokerLoginError(error, classifyError(error));
        }
      }
    }
    await page.waitForTimeout(1_000);
  }
  if (!landed) {
    await capture(target.isClosed() ? page : target, 'quantiply-shoonya-no-return');
    throw new BrokerLoginError('submitted but never returned to Quantiply · Shoonya', 'UNKNOWN');
  }
  if (!(await stays(landed))) {
    throw new BrokerLoginError(
      'returned to Quantiply · Shoonya but it asked to log in again',
      'UNKNOWN',
    );
  }
  if (target !== page && !target.isClosed()) await target.close().catch(() => undefined);
  return 'logged_in';
}

/**
 * One Quantiply · Shoonya login in a browser context of its own (never traced: a trace would hold
 * the password), closed afterwards, bounded by `timeLimitMs`. One attempt only: a wrong password
 * must never be sent twice. Never throws.
 */
export async function runQuantiplyShoonyaIsolated(
  browser: Browser,
  creds: ShoonyaCredentials,
  timeLimitMs = 5 * 60_000,
): Promise<BrokerResult> {
  const name = SITE.name;
  const started = Date.now();
  const context = await browser
    .newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    })
    .catch(() => null);
  if (!context) return { name, status: 'FAIL', detail: 'could not open a browser context' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const limit = new Promise<BrokerResult>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            name,
            status: 'FAIL',
            detail: `timed out after ${Math.round(timeLimitMs / 1000)}s - NOT retried`,
          }),
        timeLimitMs,
      );
    });
    const login = quantiplyShoonyaLogin(page, creds).then(
      (outcome): BrokerResult =>
        outcome === 'already'
          ? { name, status: 'SKIPPED', detail: 'already logged in' }
          : {
              name,
              status: 'OK',
              detail: `logged in (${Math.round((Date.now() - started) / 1000)}s)`,
            },
      (error): BrokerResult => ({
        name,
        status: 'FAIL',
        detail: `${describe(error)} - NOT retried`,
      }),
    );
    return await Promise.race([login, limit]);
  } catch (error) {
    return { name, status: 'FAIL', detail: describe(error) };
  } finally {
    clearTimeout(timer);
    await context.close().catch(() => undefined);
  }
}
