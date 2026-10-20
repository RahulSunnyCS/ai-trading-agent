import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { BrokerLoginError } from './brokers/types.js';
import { describe } from './diagnose.js';
import { installOverlayHandlers } from './overlays.js';
import { QuantiplyApi, readToken } from './quantiply-api.js';
import { QUANTIPLY_SITES, type QuantiplyBroker } from './quantiply-rules.js';
import { quantiplyShoonyaLogin } from './quantiply-shoonya.js';
import { quantiplyLogin } from './quantiply.js';
import { registerSecret } from './secrets.js';
import { sha256 } from './strategy-plan.js';

/**
 * One Quantiply API session for the uploader and the deployer (BL-139): the account's `.env`
 * login, the refused-login hold, a browser login only to take the web app's JWT, then the API.
 * The JWT is registered as a secret at once and never logged or written anywhere.
 */

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

/**
 * Log in in a browser, take the JWT, close the browser: an API client for the account. A refused
 * login writes the hold and throws `LoginRefused`.
 */
export async function openQuantiply(
  c: QCredentials,
  stateDir: string,
  opts: { headed?: boolean } = {},
): Promise<QuantiplyApi> {
  const site = QUANTIPLY_SITES[c.broker];
  const browser = await chromium.launch({ headless: !opts.headed });
  let token: string;
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
    token = await readToken(await context.newPage(), site);
  } finally {
    await browser.close().catch(() => undefined);
  }
  registerSecret(token);
  return new QuantiplyApi(token, fetch, site);
}
