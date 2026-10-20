import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { waitForNextWindow } from '@trading/broker-identity';
import { type Browser, type Page, chromium } from 'playwright';
import { BrokerLoginError } from './brokers/types.js';
import { describe } from './diagnose.js';
import { installOverlayHandlers } from './overlays.js';
import { QuantiplyApi, readToken } from './quantiply-api.js';
import { QUANTIPLY_SITES, type QuantiplyBroker } from './quantiply-rules.js';
import { quantiplyShoonyaLogin } from './quantiply-shoonya.js';
import { quantiplyLogin } from './quantiply.js';
import { registerSecret } from './secrets.js';
import { sha256 } from './strategy-plan.js';
import { totpWindow } from './totp.js';

/**
 * One Quantiply API session for the uploader and the deployer (BL-139): the account's `.env`
 * login, the refused-login hold, a browser login only to take the web app's JWT, then the API.
 * The JWT is registered as a secret at once and never logged or written anywhere.
 */

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/**
 * Where an account's uploader ledger lives (`TRADING_DATA_ROOT/rotation/quantiply/`): Angel One's
 * keeps its original name, each other account has its own. The deployer reads the same file, so
 * this is the one place the name is decided.
 */
export function quantiplyLedgerPath(dataRoot: string, broker: QuantiplyBroker): string {
  return join(
    dataRoot,
    'rotation',
    'quantiply',
    broker === 'angelone' ? 'ledger.jsonl' : `ledger-${broker}.jsonl`,
  );
}

export interface QCredentials {
  broker: QuantiplyBroker;
  /** the `.env` names, for messages */
  names: string[];
  user: string;
  secret: string;
  totpSecret: string;
}

/** The account's login from the environment, secrets registered; throws naming what is missing. */
export function quantiplyCredentials(
  broker: QuantiplyBroker,
  env: NodeJS.ProcessEnv = process.env,
): QCredentials {
  const names =
    broker === 'angelone'
      ? ['ANGELONE_CLIENT_CODE', 'ANGELONE_MPIN', 'ANGELONE_TOTP_SECRET']
      : ['SHOONYA_CLIENT_ID', 'SHOONYA_PASSWORD', 'SHOONYA_TOTP_SECRET'];
  const [user = '', secret = '', totpSecret = ''] = names.map((n) => env[n]?.trim() ?? '');
  if (!user || !secret || !totpSecret) throw new Error(`${names.join(' / ')} missing from .env`);
  registerSecret(secret);
  registerSecret(totpSecret);
  return { broker, names, user, secret, totpSecret };
}

/** A refused login holds the account until its credentials in .env change. */
export class LoginHeld extends Error {}
/** The broker refused the login: never sent again with the same credentials. */
export class LoginRefused extends Error {}

const holdPath = (stateDir: string, broker: QuantiplyBroker) =>
  join(stateDir, `login-hold-${broker}.json`);
const fingerprintOf = (c: QCredentials) => sha256(`${c.user}\n${c.secret}`);

/** Throws `LoginHeld` while a refused login holds this account with these credentials. */
export async function checkLoginHold(c: QCredentials, stateDir: string): Promise<void> {
  const path = holdPath(stateDir, c.broker);
  if (!existsSync(path)) return;
  type Hold = { fingerprint?: string; at?: string; detail?: string };
  const hold = await readFile(path, 'utf8')
    .then((t) => JSON.parse(t) as Hold)
    .catch((): Hold => ({}));
  if (hold.fingerprint === fingerprintOf(c)) {
    throw new LoginHeld(
      `${QUANTIPLY_SITES[c.broker].name}: login held since ${hold.at ?? '?'} after a refused login (${hold.detail ?? ''}); fix ${c.names[1]} in .env, then it clears by itself`,
    );
  }
}

const windowPath = (stateDir: string, broker: QuantiplyBroker) =>
  join(stateDir, `totp-window-${broker}.json`);

/**
 * Across processes: never type a code from a 30-second TOTP window another Quantiply run (the
 * uploader, the deployer) already typed one from for this account. `angelTotp` / `shoonyaTotp`
 * guard this within one process only; this file stamp covers back-to-back jobs.
 */
export async function waitOutTotpWindow(stateDir: string, broker: QuantiplyBroker): Promise<void> {
  type Stamp = { window?: number };
  const stamp = await readJson<Stamp>(windowPath(stateDir, broker)).catch((): Stamp => ({}));
  const last = typeof stamp.window === 'number' ? stamp.window : null;
  // at most two windows: a stamp further ahead is a clock problem, not a reason to stall
  for (let n = 0; last !== null && totpWindow() <= last && n < 2; n += 1) await waitForNextWindow();
}

/** Record the window a login typed its code in (written after the attempt, success or not). */
async function stampTotpWindow(stateDir: string, broker: QuantiplyBroker): Promise<void> {
  await mkdir(stateDir, { recursive: true }).catch(() => undefined);
  await writeFile(
    windowPath(stateDir, broker),
    `${JSON.stringify({ window: totpWindow() })}\n`,
  ).catch(() => undefined);
}

/**
 * Log in in a browser, take the JWT, close the browser: an API client for the account. A refused
 * login writes the hold and throws `LoginRefused`. With `retryTotpOnce`, a login whose TOTP code
 * was refused (nothing on Quantiply changed yet) is tried once more, in the next window.
 */
export async function openQuantiply(
  c: QCredentials,
  stateDir: string,
  opts: { headed?: boolean; retryTotpOnce?: boolean } = {},
): Promise<QuantiplyApi> {
  return (await openWithRetry(c, stateDir, { ...opts, keep: false })).api;
}

/** A logged-in Quantiply web app kept open (BL-143's monitor reads its live MTM), plus the API. */
export interface QuantiplyApp {
  api: QuantiplyApi;
  browser: Browser;
  page: Page;
}

/**
 * `openQuantiply`, but the browser stays open on the logged-in app (BL-143's loss monitor reads
 * the MTM the app's socket pushes to it; nothing is clicked). The caller closes `browser`. Never
 * screenshot or save this page: it is the owner's live account.
 */
export async function openQuantiplyApp(
  c: QCredentials,
  stateDir: string,
  opts: { headed?: boolean; retryTotpOnce?: boolean; onPage?: (page: Page) => void } = {},
): Promise<QuantiplyApp> {
  const app = await openWithRetry(c, stateDir, { ...opts, keep: true });
  if (!app.browser || !app.page) throw new Error('internal: the app was not kept open');
  return { api: app.api, browser: app.browser, page: app.page };
}

async function openWithRetry(
  c: QCredentials,
  stateDir: string,
  opts: { headed?: boolean; retryTotpOnce?: boolean; keep: boolean; onPage?: (page: Page) => void },
): Promise<{ api: QuantiplyApi; browser?: Browser; page?: Page }> {
  for (let attempt = 1; ; attempt += 1) {
    await waitOutTotpWindow(stateDir, c.broker);
    try {
      return await loginOnce(c, stateDir, opts);
    } catch (error) {
      const totp = error instanceof BrokerLoginError && error.kind === 'TOTP_REJECTED';
      if (!totp || !opts.retryTotpOnce || attempt >= 2) throw error;
      console.log('  TOTP code refused: one more login in the next window');
    } finally {
      await stampTotpWindow(stateDir, c.broker);
    }
  }
}

async function loginOnce(
  c: QCredentials,
  stateDir: string,
  opts: { headed?: boolean; keep?: boolean; onPage?: (page: Page) => void },
): Promise<{ api: QuantiplyApi; browser?: Browser; page?: Page }> {
  const site = QUANTIPLY_SITES[c.broker];
  const browser = await chromium.launch({ headless: !opts.headed });
  let token: string;
  let kept: Page | undefined;
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    });
    installOverlayHandlers(context);
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    try {
      if (c.broker === 'angelone') {
        await quantiplyLogin(
          page,
          { clientCode: c.user, mpin: c.secret, totpSecret: c.totpSecret },
          { submitted: false },
        );
      } else {
        await quantiplyShoonyaLogin(page, {
          userId: c.user,
          password: c.secret,
          totpSecret: c.totpSecret,
        });
      }
    } catch (error) {
      if (error instanceof BrokerLoginError && error.kind === 'CREDENTIALS_REJECTED') {
        await mkdir(stateDir, { recursive: true });
        await writeFile(
          holdPath(stateDir, c.broker),
          `${JSON.stringify({ at: new Date().toISOString(), fingerprint: fingerprintOf(c), detail: describe(error) })}\n`,
        ).catch(() => undefined);
        throw new LoginRefused(describe(error));
      }
      throw error;
    }
    const tokenPage = await context.newPage();
    // The listener goes on before the app loads, so the socket it opens is seen from the start.
    if (opts.keep && opts.onPage) opts.onPage(tokenPage);
    token = await readToken(tokenPage, site);
    if (opts.keep) {
      kept = tokenPage;
      await page.close().catch(() => undefined);
    }
  } finally {
    if (!kept) await browser.close().catch(() => undefined);
  }
  registerSecret(token);
  const api = new QuantiplyApi(token, fetch, site);
  return kept ? { api, browser, page: kept } : { api };
}
