import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  loadStoredToken,
  probeFyersToken,
  resolveFyersCredentials,
  saveToken,
} from '../services/fyers-auth.js';

function tokenPool(row: Record<string, unknown> | null): Pool {
  return {
    query: async () => ({ rows: row ? [row] : [] }),
  } as unknown as Pool;
}

describe('Fyers credential precedence', () => {
  const fallback = { appId: 'dashboard-app', accessToken: 'env-token' };

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

  it('rejects a non-expired token minted for a different configured app', async () => {
    const result = await resolveFyersCredentials(
      tokenPool({
        app_id: 'old-app',
        access_token: 'old-token',
        refresh_token: null,
        expires_at: new Date(Date.now() + 3_600_000),
      }),
      fallback,
    );

    expect(result.source).toBe('env');
    expect(result.credentials).toEqual(fallback);
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

describe('Fyers token persistence', () => {
  it('encrypts access and refresh tokens in PostgreSQL using the server-only app secret', async () => {
    const previous = process.env.FYERS_APP_SECRET;
    process.env.FYERS_APP_SECRET = 'server-only-secret';
    const query = vi.fn(async (_sql: string, _params: unknown[]) => ({ rows: [] }));
    const db = { query } as unknown as Pool;

    await saveToken(db, {
      appId: 'APP-100',
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      expiresAt: new Date('2026-10-02T00:00:00Z'),
    });

    const call = query.mock.calls[0];
    expect(call).toBeDefined();
    const sql = String(call?.[0]);
    const params = call?.[1] as unknown[];
    expect(sql).toContain('pgp_sym_encrypt');
    expect(sql).toContain('token_encrypted');
    expect(params).toEqual([
      'APP-100',
      'access-secret',
      'refresh-secret',
      new Date('2026-10-02T00:00:00Z'),
      'server-only-secret',
    ]);
    if (previous === undefined) delete process.env.FYERS_APP_SECRET;
    else process.env.FYERS_APP_SECRET = previous;
  });
});

describe('Fyers token expiry', () => {
  it('caps a stored 24h expiry at the 06:00 IST reset that follows the login', async () => {
    // Logged in 15:00 IST on 6 Oct; the old code stored now+24h (15:00 IST on 7 Oct).
    const stored = await loadStoredToken(
      tokenPool({
        app_id: 'APP-100',
        access_token: 'tok',
        refresh_token: null,
        expires_at: new Date('2026-10-07T09:30:00Z'),
        updated_at: new Date('2026-10-06T09:30:00Z'),
      }),
    );
    expect(stored?.expiresAt.toISOString()).toBe('2026-10-07T00:30:00.000Z');
  });

  it('keeps the stored expiry when no issue time is known', async () => {
    const stored = await loadStoredToken(
      tokenPool({
        app_id: 'APP-100',
        access_token: 'tok',
        refresh_token: null,
        expires_at: new Date('2026-10-07T09:30:00Z'),
      }),
    );
    expect(stored?.expiresAt.toISOString()).toBe('2026-10-07T09:30:00.000Z');
  });
});

describe('probeFyersToken', () => {
  const respond = (status: number, body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('reports a token Fyers refuses as rejected', async () => {
    const result = await probeFyersToken(
      'APP-1',
      'dead-token-aaaaaaaaaaaa',
      respond(401, { s: 'error', code: -16, message: 'Could not authenticate the user' }),
    );
    expect(result).toBe('rejected');
  });

  it('does not log a token out because the gateway answered 403', async () => {
    expect(
      await probeFyersToken('APP-1', 'gateway-token-dddddddddd', respond(403, { s: 'error' })),
    ).toBe('unknown');
  });

  it('reports an accepted token as valid', async () => {
    expect(
      await probeFyersToken('APP-1', 'good-token-bbbbbbbbbbbb', respond(200, { s: 'ok' })),
    ).toBe('valid');
  });

  it('never reads an outage as a logout', async () => {
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await probeFyersToken('APP-1', 'unknown-token-cccccccccc', down)).toBe('unknown');
  });
});
