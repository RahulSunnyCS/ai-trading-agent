import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { send } from '@trading/notify';
import { type BrowserContext, type Page, chromium } from 'playwright';
import { readTelegramConfig } from './config.js';
import { describe, safeScreenshot, step } from './diagnose.js';
import {
  type FyersConfig,
  type FyersFailure,
  buildAuthUrl,
  classifyFyersError,
  exchangeAuthCode,
  isRedirect,
  loadFyersConfig,
  parseRedirect,
} from './fyers-auth.js';
import { fyersLogin } from './selectors.js';
import { storeFyersToken } from './store-token.js';
import { freshTotp, waitForNextWindow } from './totp.js';

/**
 * Mints a Fyers access token headlessly, for the weekly momentum job's market-data
 * calls: client ID -> TOTP -> PIN on Fyers' own login page, then the auth_code on the
 * redirect is exchanged for a token.
 *
 * The token is written to FYERS_TOKEN_FILE (0600; default in the OS temp dir) and
 * never printed - @trading/notify's registerSecret masks it in Actions logs. The
 * redirect is intercepted, never loaded, so FYERS_REDIRECT_URI can be the localhost
 * URL the app is already registered with.
 *
 * With `--store` (the laptop's morning job) the token also goes into the encrypted
 * `broker_tokens` row, so the dashboard card turns green without anyone clicking Login.
 * Fyers is deliberately its own job, separate from the AlgoTest login that handles
 * Angel One and Finvasia: neither can block the other.
 *
 * What this token can do is whatever the Fyers API app allows. Use a dedicated app
 * for this job, and keep order placement locked to a static IP on the Fyers side -
 * GitHub runners have none, so a leaked token cannot place API orders.
 */

class FyersLoginError extends Error {
  constructor(
    message: string,
    readonly kind: FyersFailure,
  ) {
    super(message);
    this.name = 'FyersLoginError';
  }
}

async function failIfErrorShown(page: Page): Promise<void> {
  const text = (
    await fyersLogin
      .error(page)
      .innerText({ timeout: 1_500 })
      .catch(() => '')
  )
    .trim()
    .slice(0, 200);
  if (text) throw new FyersLoginError(text, classifyFyersError(text));
}

/** The TOTP and PIN rows auto-advance, so type into the first box. */
async function typeDigits(page: Page, digits: string): Promise<void> {
  const box = fyersLogin.firstDigitBox(page);
  await box.waitFor({ state: 'visible', timeout: 20_000 });
  await box.click();
  await page.keyboard.type(digits, { delay: 60 });
}

async function submitIfNeeded(page: Page): Promise<void> {
  const button = fyersLogin.submit(page);
  if (await button.isVisible().catch(() => false)) {
    if (await button.isEnabled().catch(() => false)) await button.click();
  }
}

async function loginOnce(context: BrowserContext, config: FyersConfig): Promise<string> {
  const { url, state } = buildAuthUrl(config);
  let redirected: string | null = null;
  await context.unrouteAll({ behavior: 'ignoreErrors' });
  await context.route(
    (target) => isRedirect(target.href, config.redirectUri),
    async (route) => {
      redirected = route.request().url();
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' });
    },
  );
  const page = await context.newPage();

  await step(page, 'fyers-open', async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  });

  await step(page, 'fyers-client-id', async () => {
    const toggle = fyersLogin.useClientId(page);
    if (await toggle.isVisible({ timeout: 5_000 }).catch(() => false)) await toggle.click();
    const input = fyersLogin.clientId(page);
    await input.waitFor({ state: 'visible', timeout: 20_000 });
    await input.fill(config.clientId);
    await fyersLogin.submit(page).click();
  });
  await failIfErrorShown(page);

  await step(page, 'fyers-totp', async () => {
    await fyersLogin.totpStep(page).waitFor({ state: 'visible', timeout: 20_000 });
    // Generated last so as little of the 30-second window as possible is spent.
    await typeDigits(page, await freshTotp(config.totpSecret));
    await submitIfNeeded(page);
  });
  await page.waitForTimeout(1_500);
  await failIfErrorShown(page);

  await step(page, 'fyers-pin', async () => {
    await fyersLogin.pinStep(page).waitFor({ state: 'visible', timeout: 20_000 });
    await typeDigits(page, config.pin);
    await submitIfNeeded(page);
  });

  const deadline = Date.now() + 45_000;
  while (!redirected && Date.now() < deadline) {
    if (!page.isClosed()) {
      await failIfErrorShown(page);
      const consent = fyersLogin.authorize(page);
      if (await consent.isVisible().catch(() => false)) await consent.click().catch(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!redirected) {
    if (!page.isClosed()) await safeScreenshot(page, 'fyers-no-redirect');
    throw new FyersLoginError('Fyers never redirected back with an auth code', 'UNKNOWN');
  }
  return parseRedirect(redirected, state);
}

async function main(): Promise<number> {
  const store = process.argv.includes('--store');
  const telegram = readTelegramConfig();
  const runUrl =
    process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined;
  const alert = async (detail: string) =>
    send(telegram, {
      source: 'fyers-login',
      severity: 'error',
      title: store
        ? 'Fyers login failed - log in from the dashboard'
        : 'Fyers login failed - weekly job falls back to public data',
      body: detail,
      runUrl,
    });

  let config: FyersConfig;
  try {
    config = loadFyersConfig();
  } catch (error) {
    console.error(describe(error));
    await alert(describe(error));
    return 1;
  }

  const outFile = process.env.FYERS_TOKEN_FILE?.trim() || join(tmpdir(), 'fyers-token.json');
  const browser = await chromium.launch({
    headless: process.env.HEADED !== '1',
    slowMo: Number(process.env.SLOW_MO ?? 0),
  });
  try {
    const context = await browser.newContext({ locale: 'en-IN', timezoneId: 'Asia/Kolkata' });
    let authCode = '';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        authCode = await loginOnce(context, config);
        break;
      } catch (error) {
        const kind = error instanceof FyersLoginError ? error.kind : 'UNKNOWN';
        console.error(`  attempt ${attempt} failed (${kind}): ${describe(error)}`);
        // A wrong PIN or a blocked account must not be retried - it counts toward a lockout.
        if (attempt === 2 || kind === 'PIN_REJECTED' || kind === 'ACCOUNT_BLOCKED') throw error;
        if (kind === 'TOTP_REJECTED') await waitForNextWindow();
        for (const page of context.pages()) await page.close().catch(() => {});
      }
    }
    const token = await exchangeAuthCode(config, authCode);
    await writeFile(
      outFile,
      JSON.stringify({
        app_id: token.appId,
        access_token: token.accessToken,
        expires_at: token.expiresAt,
      }),
      { mode: 0o600 },
    );
    console.log(`ok: Fyers token written to ${outFile} (not shown)`);
    if (store) {
      await storeFyersToken(token);
      console.log(`ok: Fyers token stored in broker_tokens, expires ${token.expiresAt}`);
    }
    return 0;
  } catch (error) {
    const kind = error instanceof FyersLoginError ? ` [${error.kind}]` : '';
    await alert(`${describe(error)}${kind}`);
    return 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

process.exitCode = await main();
