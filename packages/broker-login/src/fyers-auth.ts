import { createHash, randomBytes } from 'node:crypto';
import { fyersTokenExpiry } from '@trading/broker-identity';
import { registerSecret } from './secrets.js';

/**
 * The browser-free half of the Fyers login: building the OAuth URL, reading the
 * auth_code off the redirect, and swapping it for an access token. Kept apart from
 * the Playwright flow so it can be tested without a browser.
 *
 * Same API calls as packages/momentum-backtesting/src/momentum_backtesting/fyers.py
 * and apps/server/src/server/services/fyers-auth.ts.
 */

export const AUTH_URL = 'https://api-t1.fyers.in/api/v3/generate-authcode';
export const TOKEN_URL = 'https://api-t1.fyers.in/api/v3/validate-authcode';

export interface FyersConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  clientId: string;
  pin: string;
  totpSecret: string;
}

const REQUIRED = [
  'FYERS_APP_ID',
  'FYERS_APP_SECRET',
  'FYERS_REDIRECT_URI',
  'FYERS_CLIENT_ID',
  'FYERS_PIN',
  'FYERS_TOTP_SECRET',
] as const;

export function loadFyersConfig(env: NodeJS.ProcessEnv = process.env): FyersConfig {
  const missing = REQUIRED.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  const read = (key: (typeof REQUIRED)[number]): string => {
    const value = env[key]!.trim();
    // The app id and redirect are not secret, but masking them costs nothing and
    // keeps them out of screenshots' page titles and logs alike.
    registerSecret(value);
    return value;
  };
  const pin = read('FYERS_PIN');
  if (!/^\d{4}$/.test(pin)) throw new Error('FYERS_PIN should be the 4-digit Fyers PIN');
  return {
    appId: read('FYERS_APP_ID'),
    appSecret: read('FYERS_APP_SECRET'),
    redirectUri: read('FYERS_REDIRECT_URI'),
    clientId: read('FYERS_CLIENT_ID'),
    pin,
    totpSecret: read('FYERS_TOTP_SECRET'),
  };
}

export function buildAuthUrl(config: FyersConfig, state = randomBytes(16).toString('hex')) {
  const query = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    state,
  });
  return { url: `${AUTH_URL}?${query.toString()}`, state };
}

/** True for the request Fyers makes to our redirect URI once login succeeds. */
export function isRedirect(url: string, redirectUri: string): boolean {
  const target = new URL(redirectUri);
  const seen = new URL(url);
  return seen.origin === target.origin && seen.pathname === target.pathname;
}

/** auth_code from the redirect URL, after checking the state we sent came back. */
export function parseRedirect(url: string, expectedState: string): string {
  const params = new URL(url).searchParams;
  const state = params.get('state');
  if (state !== expectedState) throw new Error('Fyers login state mismatch');
  if (params.get('s') && params.get('s') !== 'ok') {
    throw new Error(`Fyers login redirect reported s=${params.get('s')}`);
  }
  const code = params.get('auth_code') ?? params.get('code');
  // `code` is also Fyers' numeric status (e.g. 200) - a real auth code is a long token.
  if (!code || /^\d{1,4}$/.test(code)) throw new Error('No auth_code on the Fyers redirect');
  registerSecret(code);
  return code;
}

export function appIdHash(appId: string, appSecret: string): string {
  return createHash('sha256').update(`${appId}:${appSecret}`).digest('hex');
}

export interface FyersToken {
  appId: string;
  accessToken: string;
  expiresAt: string;
}

export async function exchangeAuthCode(
  config: FyersConfig,
  authCode: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FyersToken> {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (broker-login)' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      appIdHash: appIdHash(config.appId, config.appSecret),
      code: authCode,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = { s: 'error', message: `HTTP ${response.status} from Fyers` };
  }
  const token = typeof body.access_token === 'string' ? body.access_token : '';
  if (token) registerSecret(token);
  if (typeof body.refresh_token === 'string') registerSecret(body.refresh_token);
  if (body.s !== 'ok' || !token) {
    // Never echo the body: a partial success could carry a token.
    const detail = typeof body.message === 'string' ? body.message : `s=${String(body.s)}`;
    throw new Error(`Fyers token exchange failed: ${detail}`);
  }
  // Fyers tokens die at the next 06:00 IST whatever expires_in says.
  const expiresAt = fyersTokenExpiry(
    new Date(),
    typeof body.expires_in === 'number' ? body.expires_in : null,
  ).toISOString();
  return { appId: config.appId, accessToken: token, expiresAt };
}

export type FyersFailure = 'TOTP_REJECTED' | 'PIN_REJECTED' | 'ACCOUNT_BLOCKED' | 'UNKNOWN';

/** Only a stale/wrong TOTP is worth one retry; a wrong PIN counts towards a lockout. */
export function classifyFyersError(text: string): FyersFailure {
  if (/block|lock|suspend|too many/i.test(text)) return 'ACCOUNT_BLOCKED';
  if (/pin/i.test(text) && /invalid|incorrect|wrong/i.test(text)) return 'PIN_REJECTED';
  if (/otp|totp|code/i.test(text) && /invalid|incorrect|wrong|expired/i.test(text)) {
    return 'TOTP_REJECTED';
  }
  return 'UNKNOWN';
}
