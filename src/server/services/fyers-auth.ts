/**
 * Fyers OAuth helpers.
 *
 * Fyers v3 auth code flow:
 *   1. Redirect user to the auth URL with client_id (app_id) and redirect_uri.
 *   2. Fyers redirects back with ?auth_code=...&state=...
 *   3. POST the auth_code + SHA256(app_id:secret_key) to validate-authcode to
 *      receive { access_token, refresh_token, expires_in }.
 *
 * Tokens are stored in the broker_tokens table (one row per broker). The
 * ingestion process reads from this table at startup when FYERS_ACCESS_TOKEN
 * is not set in the env.
 */

import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Token / secret redaction helper
// ---------------------------------------------------------------------------
// Used wherever we must include token-like values in log output. We never
// log the full token, refresh token, app secret, or auth code — only a
// prefix long enough to correlate with a known value during debugging.
// ---------------------------------------------------------------------------

/**
 * Returns a redacted version of a token/secret suitable for log output.
 * Shows only the first 4 characters followed by "..." so sensitive material
 * is never written to log storage.
 *
 * Safe to call with null/undefined — returns "<empty>" so callers don't need
 * to guard.
 */
export function redactToken(value: string | null | undefined): string {
  if (!value) return '<empty>';
  if (value.length <= 4) return '****';
  return `${value.slice(0, 4)}...`;
}

const FYERS_AUTH_URL = 'https://api-t1.fyers.in/api/v3/generate-authcode';
const FYERS_TOKEN_URL = 'https://api-t1.fyers.in/api/v3/validate-authcode';

export interface FyersOAuthConfig {
  appId: string;
  secretKey: string;
  redirectUri: string;
}

export interface StoredToken {
  appId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date;
}

export function loadFyersOAuthConfig(): FyersOAuthConfig | null {
  const appId = process.env.FYERS_APP_ID;
  const secretKey = process.env.FYERS_APP_SECRET;
  const redirectUri =
    process.env.FYERS_REDIRECT_URI ??
    `http://localhost:${process.env.PORT ?? '3000'}/api/auth/fyers/callback`;

  if (!appId || !secretKey) return null;
  return { appId, secretKey, redirectUri };
}

export function buildAuthUrl(cfg: FyersOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: cfg.appId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    state,
  });
  return `${FYERS_AUTH_URL}?${params.toString()}`;
}

interface ValidateAuthCodeResponse {
  s: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  message?: string;
  code?: number;
}

export async function exchangeAuthCode(
  cfg: FyersOAuthConfig,
  authCode: string,
): Promise<StoredToken> {
  const appIdHash = createHash('sha256').update(`${cfg.appId}:${cfg.secretKey}`).digest('hex');

  const res = await fetch(FYERS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      appIdHash,
      code: authCode,
    }),
  });

  const body = (await res.json()) as ValidateAuthCodeResponse;
  if (body.s !== 'ok' || !body.access_token) {
    // Redact the body before embedding in the error message — a partial
    // success response from Fyers could contain access_token/refresh_token
    // fields, which must never appear in exception messages or logs.
    const safeDetail = body.message ?? `s=${body.s ?? 'unknown'} code=${body.code ?? '-'}`;
    throw new Error(`Fyers token exchange failed: ${safeDetail}`);
  }

  // Fyers v3 access tokens expire ~24h; expires_in is seconds. Fall back to 24h
  // if the field is missing so we still write a sensible expires_at.
  const expiresInSec = body.expires_in ?? 24 * 60 * 60;
  const expiresAt = new Date(Date.now() + expiresInSec * 1000);

  return {
    appId: cfg.appId,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt,
  };
}

export async function saveToken(db: Pool, token: StoredToken): Promise<void> {
  await db.query(
    `INSERT INTO broker_tokens (broker, app_id, access_token, refresh_token, expires_at, updated_at)
     VALUES ('fyers', $1, $2, $3, $4, NOW())
     ON CONFLICT (broker) DO UPDATE
       SET app_id = EXCLUDED.app_id,
           access_token = EXCLUDED.access_token,
           refresh_token = EXCLUDED.refresh_token,
           expires_at = EXCLUDED.expires_at,
           updated_at = NOW()`,
    [token.appId, token.accessToken, token.refreshToken, token.expiresAt],
  );
}

export async function loadStoredToken(db: Pool): Promise<StoredToken | null> {
  const result = await db.query<{
    app_id: string;
    access_token: string;
    refresh_token: string | null;
    expires_at: Date;
  }>(
    `SELECT app_id, access_token, refresh_token, expires_at
       FROM broker_tokens
      WHERE broker = 'fyers'
      LIMIT 1`,
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    appId: row.app_id,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    expiresAt: new Date(row.expires_at),
  };
}
