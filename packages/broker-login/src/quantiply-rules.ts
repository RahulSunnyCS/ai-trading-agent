import type { FailureKind } from './brokers/types.js';
import { errorPatterns } from './selectors.js';

/**
 * The browser-free half of the Quantiply login (src/quantiply.ts): where it starts, how a URL
 * tells logged-in from not, how Angel One's error text is classified, and when a failed attempt
 * may be retried. Kept apart so the rules are unit-tested without Playwright.
 */

/** Quantiply's own login screen. `resume` is where it sends the user after the login. */
export const QUANTIPLY_LOGIN_URL = 'https://app.quantiply.angelone.in/auth?resume=/algos';

/** The web app's host. Its API host (api-prod.quantiply.angelone.in) only handles the redirect. */
export const QUANTIPLY_APP_HOST = 'app.quantiply.angelone.in';

/** Angel One's SmartAPI publisher login, where the client code, PIN and TOTP go in. */
export const ANGEL_LOGIN_HOST = 'smartapi.angelone.in';

/** Quantiply runs one copy of its web app per broker (BL-140, captured 2026-10-19). */
export type QuantiplyBroker = 'angelone' | 'finvasia';

export interface QuantiplySite {
  broker: QuantiplyBroker;
  /** Display name in reports and Telegram. */
  name: string;
  appHost: string;
  /** Origin of its API (`api-prod.quantiply.<broker host>`): the same paths on both. */
  apiOrigin: string;
  loginUrl: string;
}

export const QUANTIPLY_SITES: Record<QuantiplyBroker, QuantiplySite> = {
  angelone: {
    broker: 'angelone',
    name: 'Quantiply · Angel One',
    appHost: QUANTIPLY_APP_HOST,
    apiOrigin: 'https://api-prod.quantiply.angelone.in',
    loginUrl: QUANTIPLY_LOGIN_URL,
  },
  finvasia: {
    broker: 'finvasia',
    name: 'Quantiply · Shoonya',
    appHost: 'quantiply.shoonya.com',
    apiOrigin: 'https://api-prod.quantiply.shoonya.com',
    loginUrl: 'https://quantiply.shoonya.com/auth?resume=/algos',
  },
};

export function parseQuantiplyBroker(raw: string | undefined): QuantiplyBroker {
  const value = raw?.trim().toLowerCase() || 'angelone';
  if (value === 'angelone' || value === 'finvasia') return value;
  throw new Error(`Quantiply broker ${raw} is not angelone or finvasia`);
}

/** Shoonya's OAuth login page, where Quantiply · Shoonya sends the user (`route_to=QUANTIPLY`). */
export const SHOONYA_LOGIN_HOST = 'api.shoonya.com';

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Logged in = back on Quantiply's web app and outside its /auth screens (normally on /algos).
 * The API host's /auth/angel/redirect leg and Angel's own page never count.
 */
export function isQuantiplyLoggedInUrl(
  url: string | URL,
  appHost: string = QUANTIPLY_APP_HOST,
): boolean {
  const u = typeof url === 'string' ? parse(url) : url;
  if (!u || u.protocol !== 'https:') return false;
  if (u.hostname !== appHost) return false;
  return !/^\/auth(\/|$)/i.test(u.pathname);
}

/**
 * On Angel One's SmartAPI login page. Deliberately exact: angelone.ts's `angel(one|broking)`
 * host test would also match app.quantiply.angelone.in, so it can't tell the two apart.
 */
export function isAngelLoginUrl(url: string | URL): boolean {
  const u = typeof url === 'string' ? parse(url) : url;
  return u !== null && u.hostname === ANGEL_LOGIN_HOST;
}

/**
 * Angel One's inline error text -> failure kind. Unlike algotest.ts's classifyError there is no
 * login-window case: Angel's login works at any hour, so a window rejection cannot come from here.
 */
export function classifyQuantiplyError(text: string): FailureKind {
  if (!text) return 'UNKNOWN';
  if (errorPatterns.credentialsRejected.test(text)) return 'CREDENTIALS_REJECTED';
  if (errorPatterns.totpRejected.test(text)) return 'TOTP_REJECTED';
  return 'UNKNOWN';
}

export type RetryDecision = 'retry' | 'retry-next-totp-window' | 'stop';

/**
 * Whether a failed attempt may run again.
 * - wrong PIN / client code: never (Angel locks the account after a few bad attempts);
 * - TOTP rejected (stale, or already used this window, e.g. by the laptop's 08:00 REST check):
 *   once more, with a code from the next 30-second window;
 * - anything else before the form was submitted (a selector, a slow page): once more;
 * - anything else after it was submitted: never - resubmitting the credentials can't fix a
 *   redirect that didn't come back, and every extra attempt counts towards a lockout.
 */
export function quantiplyRetryDecision(
  kind: FailureKind,
  submitted: boolean,
  attempt: number,
  maxAttempts: number,
): RetryDecision {
  if (attempt >= maxAttempts) return 'stop';
  if (kind === 'CREDENTIALS_REJECTED' || kind === 'LOGIN_WINDOW_CLOSED') return 'stop';
  if (kind === 'TOTP_REJECTED') return 'retry-next-totp-window';
  return submitted ? 'stop' : 'retry';
}

/** The report's detail for an attempt that will not be retried: says why, and what to check. */
export function quantiplyFailureDetail(
  detail: string,
  kind: FailureKind,
  submitted: boolean,
): string {
  if (kind === 'CREDENTIALS_REJECTED') {
    return `${detail} - NOT retried, check the ANGELONE_* secrets`;
  }
  if (kind === 'TOTP_REJECTED') return `${detail} - TOTP refused twice, check ANGELONE_TOTP_SECRET`;
  if (submitted) return `${detail} - NOT retried (credentials already sent)`;
  return detail;
}

/**
 * QUANTIPLY_LOGIN (a GitHub repository variable, passed through the workflow): on or off.
 * Unset or empty is off, so nothing new runs until the owner switches it on; any other
 * value fails the run loudly rather than silently doing the opposite of what was meant.
 */
export function parseQuantiplyFlag(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase() ?? '';
  if (value === '' || value === 'off' || value === 'false' || value === '0' || value === 'no') {
    return false;
  }
  if (value === 'on' || value === 'true' || value === '1' || value === 'yes') return true;
  throw new Error(`QUANTIPLY_LOGIN=${raw?.trim()} is not on or off`);
}

/** On Shoonya's OAuth login page (the form AlgoTest's Shoonya login fills, `finvasiaForm`). */
export function isShoonyaLoginUrl(url: string | URL): boolean {
  const u = typeof url === 'string' ? parse(url) : url;
  return u !== null && u.hostname === SHOONYA_LOGIN_HOST && /^\/OAuthlogin\//i.test(u.pathname);
}
