import pg from 'pg';

import type { FyersToken } from './fyers-auth.js';

/**
 * Writes the Fyers token where the dashboard, the server and `mbt` read it: the encrypted
 * `broker_tokens` row (same SQL as apps/server's saveToken). Needs DATABASE_URL and
 * FYERS_APP_SECRET (the pgcrypto passphrase), so this runs on the laptop, not a GitHub runner.
 */
export async function storeFyersToken(
  token: FyersToken,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const databaseUrl = env.DATABASE_URL?.trim();
  const passphrase = env.FYERS_APP_SECRET?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required to store the Fyers token');
  if (!passphrase) throw new Error('FYERS_APP_SECRET is required to encrypt the Fyers token');
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO broker_tokens
         (broker, app_id, access_token, refresh_token, expires_at, updated_at, token_encrypted)
       VALUES ('fyers', $1, armor(pgp_sym_encrypt($2, $3, 'cipher-algo=aes256')), NULL, $4, NOW(), TRUE)
       ON CONFLICT (broker) DO UPDATE
         SET app_id = EXCLUDED.app_id,
             access_token = EXCLUDED.access_token,
             refresh_token = NULL,
             expires_at = EXCLUDED.expires_at,
             token_encrypted = TRUE,
             updated_at = NOW()`,
      [token.appId, token.accessToken, passphrase, token.expiresAt],
    );
  } finally {
    await client.end().catch(() => {});
  }
}
