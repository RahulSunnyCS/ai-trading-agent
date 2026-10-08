import { NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { middleware } from '../../middleware';
import {
  type AccessConfig,
  type FetchKeys,
  parseTeamDomain,
  resetAccessKeyCache,
  verifyAccessJwt,
} from '../cfAccess';

const TEAM = 'my-team.cloudflareaccess.com';
const AUD = 'aud-tag-123';
const config: AccessConfig = { teamDomain: TEAM, aud: AUD };
const NOW = 1_800_000_000_000;
const seconds = NOW / 1000;

const b64url = (input: string | Uint8Array) =>
  Buffer.from(input as Uint8Array).toString('base64url');

interface Pair {
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string };
}

async function keyPair(kid: string): Promise<Pair> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return { privateKey: pair.privateKey, jwk: { ...jwk, kid } };
}

async function sign(
  pair: Pair,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
): Promise<string> {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid: pair.jwk.kid, ...header }));
  const body = b64url(
    JSON.stringify({
      aud: [AUD],
      iss: `https://${TEAM}`,
      exp: seconds + 3600,
      iat: seconds,
      ...claims,
    }),
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    pair.privateKey,
    new TextEncoder().encode(`${head}.${body}`),
  );
  return `${head}.${body}.${b64url(new Uint8Array(signature))}`;
}

let good: Pair;
let other: Pair;
let fetchKeys: ReturnType<typeof vi.fn<FetchKeys>>;

beforeAll(async () => {
  good = await keyPair('good');
  other = await keyPair('good'); // same kid, different key: a forged signature
});

beforeEach(() => {
  resetAccessKeyCache();
  fetchKeys = vi.fn<FetchKeys>(async () => [good.jwk]);
});

describe('parseTeamDomain', () => {
  it('accepts a team hostname, with or without the scheme', () => {
    expect(parseTeamDomain(TEAM)).toBe(TEAM);
    expect(parseTeamDomain(`https://${TEAM}/`)).toBe(TEAM);
  });

  it.each(['example.com', 'x.cloudflareaccess.com.evil.test', 'http://x.cloudflareaccess.com', ''])(
    'rejects %j',
    (value) => {
      expect(parseTeamDomain(value)).toBeNull();
    },
  );
});

describe('verifyAccessJwt', () => {
  it('accepts a token signed by the team key for this application', async () => {
    expect(await verifyAccessJwt(await sign(good), config, NOW, fetchKeys)).toBe(true);
  });

  it('accepts an aud given as a string', async () => {
    expect(await verifyAccessJwt(await sign(good, { aud: AUD }), config, NOW, fetchKeys)).toBe(
      true,
    );
  });

  it.each([
    ['missing', null],
    ['empty', ''],
    ['not a jwt', 'abc'],
    ['garbage parts', 'a.b.c'],
  ])('rejects a token that is %s', async (_name, token) => {
    expect(await verifyAccessJwt(token, config, NOW, fetchKeys)).toBe(false);
  });

  it('rejects a signature made with a different key', async () => {
    expect(await verifyAccessJwt(await sign(other), config, NOW, fetchKeys)).toBe(false);
  });

  it('rejects a payload changed after signing', async () => {
    const [head, , sig] = (await sign(good)).split('.') as [string, string, string];
    const forged = b64url(
      JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, exp: seconds + 99999 }),
    );
    expect(await verifyAccessJwt(`${head}.${forged}.${sig}`, config, NOW, fetchKeys)).toBe(false);
  });

  it('rejects another application, another issuer and an expired token', async () => {
    expect(await verifyAccessJwt(await sign(good, { aud: ['x'] }), config, NOW, fetchKeys)).toBe(
      false,
    );
    expect(
      await verifyAccessJwt(
        await sign(good, { iss: 'https://evil.cloudflareaccess.com' }),
        config,
        NOW,
        fetchKeys,
      ),
    ).toBe(false);
    expect(
      await verifyAccessJwt(await sign(good, { exp: seconds - 600 }), config, NOW, fetchKeys),
    ).toBe(false);
    expect(
      await verifyAccessJwt(await sign(good, { nbf: seconds + 600 }), config, NOW, fetchKeys),
    ).toBe(false);
  });

  it('rejects other algorithms, including alg none', async () => {
    expect(
      await verifyAccessJwt(await sign(good, {}, { alg: 'HS256' }), config, NOW, fetchKeys),
    ).toBe(false);
    const none = `${b64url(JSON.stringify({ alg: 'none', kid: 'good' }))}.${b64url('{}')}.`;
    expect(await verifyAccessJwt(none, config, NOW, fetchKeys)).toBe(false);
  });

  it('refuses when the keys cannot be fetched', async () => {
    const failing = vi.fn<FetchKeys>(async () => {
      throw new Error('offline');
    });
    expect(await verifyAccessJwt(await sign(good), config, NOW, failing)).toBe(false);
  });

  it('keeps using the cached keys when a refresh fails after the TTL', async () => {
    const token = await sign(good);
    expect(await verifyAccessJwt(token, config, NOW, fetchKeys)).toBe(true);
    const failing = vi.fn<FetchKeys>(async () => {
      throw new Error('offline');
    });
    const later = NOW + 2 * 60 * 60_000;
    const fresh = await sign(good, { exp: later / 1000 + 3600 });
    expect(await verifyAccessJwt(fresh, config, later, failing)).toBe(true);
    expect(await verifyAccessJwt(fresh, config, later + 1000, failing)).toBe(true);
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('rate limits retries after a failed first fetch', async () => {
    const failing = vi.fn<FetchKeys>(async () => {
      throw new Error('offline');
    });
    const token = await sign(good);
    expect(await verifyAccessJwt(token, config, NOW, failing)).toBe(false);
    expect(await verifyAccessJwt(token, config, NOW + 1000, failing)).toBe(false);
    expect(failing).toHaveBeenCalledTimes(1);
    expect(await verifyAccessJwt(token, config, NOW + 61_000, fetchKeys)).toBe(true);
  });

  it('shares one key fetch between concurrent requests', async () => {
    const token = await sign(good);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => verifyAccessJwt(token, config, NOW, fetchKeys)),
    );
    expect(results).toEqual([true, true, true, true, true]);
    expect(fetchKeys).toHaveBeenCalledTimes(1);
  });

  it('caches keys, and does not refetch for an unknown key id within a minute', async () => {
    const token = await sign(good);
    await verifyAccessJwt(token, config, NOW, fetchKeys);
    await verifyAccessJwt(token, config, NOW + 1000, fetchKeys);
    expect(fetchKeys).toHaveBeenCalledTimes(1);
    const unknown = await sign({ ...good, jwk: { ...good.jwk, kid: 'rotated' } });
    expect(await verifyAccessJwt(unknown, config, NOW + 2000, fetchKeys)).toBe(false);
    expect(fetchKeys).toHaveBeenCalledTimes(1);
  });
});

describe('middleware in Cloudflare Access mode', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DASHBOARD_PASSWORD', '');
    vi.stubEnv('ACCESS_TEAM_DOMAIN', TEAM);
    vi.stubEnv('ACCESS_AUD', AUD);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ keys: [good.jwk] })),
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const request = (path: string, headers: Record<string, string> = {}) =>
    new NextRequest(`http://dash.test${path}`, { headers });

  it('refuses a request with no Access token, even with no password configured', async () => {
    const res = await middleware(request('/', { accept: 'text/html' }));
    expect(res.status).toBe(403);
  });

  it('refuses a forged token', async () => {
    const res = await middleware(
      request('/api/momentum/meta', { 'cf-access-jwt-assertion': await sign(other) }),
    );
    expect(res.status).toBe(403);
  });

  it('lets a valid token through and needs no password', async () => {
    const token = await sign(good);
    const res = await middleware(request('/', { 'cf-access-jwt-assertion': token }));
    expect(res.status).toBe(200);
  });

  it('sends /login to the app and /logout to Access', async () => {
    const token = await sign(good);
    const login = await middleware(
      request('/login?next=/momentum', { 'cf-access-jwt-assertion': token }),
    );
    expect(login.status).toBe(302);
    expect(new URL(login.headers.get('location') ?? '').pathname).toBe('/momentum');
    const logout = await middleware(request('/logout', { 'cf-access-jwt-assertion': token }));
    expect(new URL(logout.headers.get('location') ?? '').pathname).toBe('/cdn-cgi/access/logout');
  });

  it('on API paths adds the service token and blanks the Access token and cookie', async () => {
    vi.stubEnv('UPSTREAM_ACCESS_CLIENT_ID', 'real-id');
    vi.stubEnv('UPSTREAM_ACCESS_CLIENT_SECRET', 'real-secret');
    const token = await sign(good);
    const res = await middleware(
      request('/api/momentum/meta', {
        'cf-access-jwt-assertion': token,
        cookie: `theme=dark; CF_Authorization=${token}`,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-request-cf-access-client-id')).toBe('real-id');
    expect(res.headers.get('x-middleware-request-cf-access-jwt-assertion')).toBe('');
    expect(res.headers.get('x-middleware-request-cookie')).toBe('theme=dark');
  });

  it('503s on a half-configured Access setup', async () => {
    vi.stubEnv('ACCESS_AUD', '');
    const res = await middleware(request('/'));
    expect(res.status).toBe(503);
  });
});
