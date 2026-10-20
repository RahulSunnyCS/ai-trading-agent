import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

/**
 * The deployer's ledger, beside the uploader's (`stateDir` is that ledger's folder). The enabler,
 * the 15:40 disable and the stop button all read and write it: one name rule for all.
 */
export function quantiplyDeployLedgerPath(stateDir: string, broker: QuantiplyBroker): string {
  return join(
    stateDir,
    broker === 'angelone' ? 'deploy-ledger.jsonl' : `deploy-ledger-${broker}.jsonl`,
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
 * When this account last typed a code (any Quantiply run: the stamp below), as the start of that
 * window in ms; null when no stamp. BL-143's monitor does not replace a lost session while it is
 * recent (re-review of #276, B).
 */
export async function lastTotpLoginAt(
  stateDir: string,
  broker: QuantiplyBroker,
): Promise<number | null> {
  type Stamp = { window?: number };
  const stamp = await readJson<Stamp>(windowPath(stateDir, broker)).catch((): Stamp => ({}));
  return typeof stamp.window === 'number' ? stamp.window * 30_000 : null;
}

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

/**
 * Claim a window (BL-143): written BEFORE the code is typed, and again after the attempt, under the
 * login lock, so no other process reads an old stamp while this one types. A code may come from the
 * next window when this one is about to end (`freshTotp`), so near the boundary the claim is the
 * next window.
 */
export function claimedWindow(atMs: number = Date.now()): number {
  const w = totpWindow(atMs);
  return atMs % 30_000 > 25_000 ? w + 1 : w;
}

async function stampTotpWindow(
  stateDir: string,
  broker: QuantiplyBroker,
  window: number = totpWindow(),
): Promise<void> {
  await mkdir(stateDir, { recursive: true }).catch(() => undefined);
  const path = windowPath(stateDir, broker);
  type Stamp = { window?: number };
  const old = await readJson<Stamp>(path).catch((): Stamp => ({}));
  // never move the stamp back (the claim may already be a window ahead)
  const at = typeof old.window === 'number' ? Math.max(old.window, window) : window;
  await writeFile(path, `${JSON.stringify({ window: at })}\n`).catch(() => undefined);
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
  opts: LoginOptions = {},
): Promise<QuantiplyApp> {
  const app = await openWithRetry(c, stateDir, { ...opts, keep: true });
  if (!app.browser || !app.page) throw new Error('internal: the app was not kept open');
  return { api: app.api, browser: app.browser, page: app.page };
}

export interface LoginOptions {
  headed?: boolean;
  retryTotpOnce?: boolean;
  onPage?: (page: Page) => void;
  /**
   * Called before each code is typed (BL-143: the monitor counts codes against its daily cap and
   * may refuse by throwing). A retry in the next window is a second call.
   */
  beforeAttempt?: () => Promise<void>;
}

async function openWithRetry(
  c: QCredentials,
  stateDir: string,
  opts: LoginOptions & { keep: boolean },
): Promise<{ api: QuantiplyApi; browser?: Browser; page?: Page }> {
  // One Quantiply login per account at a time across processes (the uploader, the deployer, the
  // monitor, the stop button): the window stamp below is read and claimed under this lock.
  const release = await takeLoginLock(stateDir, c.broker);
  try {
    for (let attempt = 1; ; attempt += 1) {
      await opts.beforeAttempt?.();
      await waitOutTotpWindow(stateDir, c.broker);
      await stampTotpWindow(stateDir, c.broker, claimedWindow());
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
  } finally {
    await release();
  }
}

// The per-account login lock, shared with the stop button (PR #275): taken once per login, in
// `openWithRetry`, for every attempt and the TOTP window stamp it claims.
const lockPath = (stateDir: string, broker: QuantiplyBroker) =>
  join(stateDir, `login-lock-${broker}`);

/** A lock older than this is a crashed run's: taken over. */
const LOCK_STALE_MS = 6 * 60_000;
/** A takeover marker older than this is a crashed takeover's: removed. */
const TAKEOVER_STALE_MS = 30_000;

/** The lock file as it is now: its text and its time, or null when there is none. */
async function lockState(path: string): Promise<{ text: string; mtime: number } | null> {
  try {
    const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return { text, mtime: info.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Across processes: one Quantiply login per account at a time (the uploader, the deployer, the
 * 15:40 disable, the stop button). The TOTP stamp alone is read-then-wait, so two runs starting
 * together could both type a code from one window and get the account's login refused (and held).
 *
 * - Taken with an exclusive create (`wx`); the content carries a random token.
 * - A lock whose process is dead, or older than 6 minutes, is taken over under a second
 *   exclusive marker (`<lock>.takeover`): only the marker's holder removes it, and only if it is
 *   still the very lock judged stale, so two waiters never both get in.
 * - The release removes the lock only while it is still this run's own (same token).
 * - Waits up to `waitMs` for another run's login; after that it goes ahead anyway, because a
 *   stuck lock must never be what keeps the stop button from logging in.
 */
export async function takeLoginLock(
  stateDir: string,
  broker: QuantiplyBroker,
  opts: { waitMs?: number; pollMs?: number } = {},
): Promise<() => Promise<void>> {
  const path = lockPath(stateDir, broker);
  const marker = `${path}.takeover`;
  const deadline = Date.now() + (opts.waitMs ?? 150_000);
  const mine = `${JSON.stringify({ pid: process.pid, at: Date.now(), token: randomBytes(8).toString('hex') })}\n`;
  const pause = () => new Promise((r) => setTimeout(r, opts.pollMs ?? 1_000));
  await mkdir(stateDir, { recursive: true }).catch(() => undefined);
  for (;;) {
    try {
      await writeFile(path, mine, { flag: 'wx' });
      return async () => {
        if ((await lockState(path))?.text === mine)
          await rm(path, { force: true }).catch(() => undefined);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return async () => undefined;
    }
    const seen = await lockState(path);
    if (!seen) continue; // released meanwhile
    type Lock = { pid?: number; at?: number };
    let held: Lock;
    try {
      held = JSON.parse(seen.text) as Lock;
    } catch {
      held = { at: seen.mtime }; // just created and not yet written, or torn: judged by its age
    }
    const alive = typeof held.pid === 'number' ? pidAlive(held.pid) : true;
    const fresh = typeof held.at === 'number' && Date.now() - held.at < LOCK_STALE_MS;
    if (!alive || !fresh) {
      try {
        await writeFile(marker, `${process.pid}\n`, { flag: 'wx' });
        try {
          const now = await lockState(path);
          if (now && now.text === seen.text && now.mtime === seen.mtime)
            await rm(path, { force: true });
        } finally {
          await rm(marker, { force: true }).catch(() => undefined);
        }
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return async () => undefined;
        const m = await lockState(marker);
        if (m && Date.now() - m.mtime > TAKEOVER_STALE_MS)
          await rm(marker, { force: true }).catch(() => undefined);
      }
    }
    if (Date.now() >= deadline) {
      console.log(
        `  another Quantiply login (pid ${held.pid ?? '?'}) still holds ${path}: going ahead`,
      );
      return async () => undefined;
    }
    await pause();
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
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
    const detachOverlays = installOverlayHandlers(context);
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
    // The kept page gets no overlay handler: nothing on it is ever clicked.
    if (opts.keep) detachOverlays();
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
