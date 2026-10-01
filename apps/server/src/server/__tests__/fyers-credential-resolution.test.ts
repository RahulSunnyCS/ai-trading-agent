import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { resolveFyersCredentials } from '../services/fyers-auth.js';

function tokenPool(row: Record<string, unknown> | null): Pool {
  return {
    query: async () => ({ rows: row ? [row] : [] }),
  } as unknown as Pool;
}

describe('Fyers credential precedence', () => {
  const fallback = { appId: 'env-app', accessToken: 'env-token' };

  it('uses a valid dashboard token and its app ID before env credentials', async () => {
    const result = await resolveFyersCredentials(
      tokenPool({
        app_id: 'dashboard-app',
        access_token: 'dashboard-token',
        refresh_token: null,
        expires_at: new Date(Date.now() + 3_600_000),
      }),
      fallback,
    );

    expect(result).toEqual({
      credentials: { appId: 'dashboard-app', accessToken: 'dashboard-token' },
      source: 'broker_tokens',
      databaseUnavailable: false,
    });
  });

  it('falls back to env when the stored token is expired or missing', async () => {
    const expired = await resolveFyersCredentials(
      tokenPool({
        app_id: 'dashboard-app',
        access_token: 'expired-token',
        refresh_token: null,
        expires_at: new Date(Date.now() - 3_600_000),
      }),
      fallback,
    );
    const missing = await resolveFyersCredentials(tokenPool(null), fallback);

    expect(expired.source).toBe('env');
    expect(expired.credentials).toEqual(fallback);
    expect(missing.source).toBe('env');
    expect(missing.credentials).toEqual(fallback);
  });

  it('falls back to env if the token database cannot be read', async () => {
    const db = {
      query: async () => {
        throw new Error('database unavailable');
      },
    } as unknown as Pool;
    const result = await resolveFyersCredentials(db, fallback);

    expect(result.credentials).toEqual(fallback);
    expect(result.source).toBe('env');
    expect(result.databaseUnavailable).toBe(true);
  });

  it('returns no credentials when neither source is usable', async () => {
    const result = await resolveFyersCredentials(tokenPool(null), {
      appId: undefined,
      accessToken: undefined,
    });
    expect(result).toEqual({
      credentials: null,
      source: null,
      databaseUnavailable: false,
    });
  });

  it('does not reuse an expired database token copied into process.env', async () => {
    const result = await resolveFyersCredentials(
      tokenPool({
        app_id: 'dashboard-app',
        access_token: 'expired-token',
        refresh_token: null,
        expires_at: new Date(Date.now() - 3_600_000),
      }),
      { appId: 'dashboard-app', accessToken: 'expired-token' },
    );

    expect(result.credentials).toBeNull();
  });
});
