import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { middleware } from '../../middleware';
import {
  type AttemptStore,
  BACKOFF,
  basicAuthPassword,
  checkPassword,
  clearFailures,
  clientIp,
  gateConfig,
  isPageRequest,
  lockoutSeconds,
  passwordMatches,
  recordFailure,
  safeNextPath,
  upstreamHeaders,
} from '../accessGate';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, signSession } from '../session';

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;

describe('gateConfig', () => {
  it('treats plain local dev with nothing set as open', () => {
    expect(gateConfig({ NODE_ENV: 'development' })).toEqual({
      password: null,
      passwordRequired: false,
      upstream: null,
      configError: null,
    });
  });

  it('requires a password in production', () => {
    expect(gateConfig({ NODE_ENV: 'production' }).passwordRequired).toBe(true);
  });

  it('requires a password in dev once any upstream token var is set', () => {
    expect(gateConfig({ NODE_ENV: 'development', UPSTREAM_ACCESS_CLIENT_ID: 'id' })).toMatchObject({
      passwordRequired: true,
      upstream: null,
    });
  });

  it('needs both halves of the service token', () => {
    const config = gateConfig({
      UPSTREAM_ACCESS_CLIENT_ID: 'id',
      UPSTREAM_ACCESS_CLIENT_SECRET: 'sec',
    });
    expect(config.upstream).toEqual({ clientId: 'id', clientSecret: 'sec' });
    expect(config.configError).toBeNull();
  });

  it.each([
    { UPSTREAM_ACCESS_CLIENT_ID: 'id' },
    { UPSTREAM_ACCESS_CLIENT_SECRET: 'sec' },
    { UPSTREAM_ACCESS_CLIENT_ID: 'id', UPSTREAM_ACCESS_CLIENT_SECRET: '  ' },
  ])('reports half a service token as a config error: %o', (env) => {
    const config = gateConfig({ NODE_ENV: 'production', DASHBOARD_PASSWORD: 'pw', ...env });
    expect(config.upstream).toBeNull();
    expect(config.configError).toMatch(/must both be set/);
  });
});

describe('basicAuthPassword', () => {
  it('ignores the username and keeps colons in the password', () => {
    expect(basicAuthPassword(basic('anyone', 'a:b:c'))).toBe('a:b:c');
  });

  it('decodes UTF-8 passwords', () => {
    expect(basicAuthPassword(basic('', 'pässwörd₹'))).toBe('pässwörd₹');
  });

  it.each([null, '', 'Bearer abc', 'Basic !!!', `Basic ${btoa('nocolon')}`])(
    'rejects %s',
    (header) => {
      expect(basicAuthPassword(header)).toBeNull();
    },
  );
});

describe('passwordMatches', () => {
  it('matches only the exact password', async () => {
    expect(await passwordMatches('secret', 'secret')).toBe(true);
    expect(await passwordMatches('secret ', 'secret')).toBe(false);
    expect(await passwordMatches('', 'secret')).toBe(false);
  });
});

describe('checkPassword', () => {
  const required = { password: null, passwordRequired: true, upstream: null, configError: null };

  it('fails closed when required and unset', async () => {
    expect(await checkPassword(basic('u', 'x'), required)).toEqual({ kind: 'misconfigured' });
  });

  it('allows everything when not required and unset', async () => {
    expect(await checkPassword(null, { ...required, passwordRequired: false })).toEqual({
      kind: 'allow',
    });
  });

  it('challenges missing or wrong passwords and allows the right one', async () => {
    const config = { ...required, password: 'hunter2' };
    expect(await checkPassword(null, config)).toEqual({ kind: 'challenge' });
    expect(await checkPassword(basic('u', 'nope'), config)).toEqual({ kind: 'challenge' });
    expect(await checkPassword(basic('u', 'hunter2'), config)).toEqual({ kind: 'allow' });
  });
});

describe('upstreamHeaders', () => {
  const open = { password: null, passwordRequired: false, upstream: null, configError: null };

  it('leaves untouched requests alone', () => {
    expect(upstreamHeaders(new Headers({ accept: 'application/json' }), open)).toBeNull();
  });

  it('strips client-supplied Access credentials and Authorization', () => {
    const headers = upstreamHeaders(
      new Headers({
        'CF-Access-Client-Id': 'evil',
        'CF-Access-Client-Secret': 'evil',
        Authorization: 'Basic abc',
        accept: 'application/json',
      }),
      open,
    );
    expect(headers?.has('cf-access-client-id')).toBe(false);
    expect(headers?.has('cf-access-client-secret')).toBe(false);
    expect(headers?.has('authorization')).toBe(false);
    expect(headers?.get('accept')).toBe('application/json');
  });

  it('strips the session cookie but keeps other cookies', () => {
    const headers = upstreamHeaders(
      new Headers({ cookie: `theme=dark; ${SESSION_COOKIE}=v1.1.2.sig; other=1` }),
      open,
    );
    expect(headers?.get('cookie')).toBe('theme=dark; other=1');
    const only = upstreamHeaders(new Headers({ cookie: `${SESSION_COOKIE}=v1.1.2.sig` }), open);
    expect(only?.has('cookie')).toBe(false);
    expect(upstreamHeaders(new Headers({ cookie: 'theme=dark' }), open)).toBeNull();
  });

  it('replaces client copies with the configured token', () => {
    const headers = upstreamHeaders(new Headers({ 'CF-Access-Client-Id': 'evil' }), {
      ...open,
      upstream: { clientId: 'real-id', clientSecret: 'real-secret' },
    });
    expect(headers?.get('cf-access-client-id')).toBe('real-id');
    expect(headers?.get('cf-access-client-secret')).toBe('real-secret');
  });
});

describe('isPageRequest', () => {
  it('is true only for a GET/HEAD of a non-API path that accepts HTML', () => {
    expect(isPageRequest('GET', '/momentum', 'text/html,application/xhtml+xml')).toBe(true);
    expect(isPageRequest('HEAD', '/', 'text/html')).toBe(true);
    expect(isPageRequest('POST', '/momentum', 'text/html')).toBe(false);
    expect(isPageRequest('GET', '/api/meta', 'text/html')).toBe(false);
    expect(isPageRequest('GET', '/retrospection/x', 'text/html')).toBe(false);
    expect(isPageRequest('GET', '/momentum', '*/*')).toBe(false);
    expect(isPageRequest('GET', '/momentum', null)).toBe(false);
  });
});

describe('safeNextPath', () => {
  it.each([
    ['/momentum', '/momentum'],
    ['/momentum/scores?tab=a&b=1#top', '/momentum/scores?tab=a&b=1#top'],
    ['/a/../b', '/b'],
    ['/', '/'],
  ])('keeps the same-origin path %s', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  it.each([
    null,
    undefined,
    '',
    'momentum',
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    '/\\/evil.example',
    '\\\\evil.example',
    '/.//evil.example',
    '/a/..//evil.example',
    '/foo\\bar',
    '/\t/evil.example',
    '/\n/evil.example',
    ' /momentum',
    'https://evil.example/',
    'http:evil.example',
    'javascript:alert(1)',
    '//',
    '/login',
    '/login?next=/x',
    '/logout',
    `/${'a'.repeat(3000)}`,
  ])('falls back to / for %j', (input) => {
    expect(safeNextPath(input)).toBe('/');
  });
});

describe('clientIp', () => {
  it('uses the first forwarded hop, else one shared bucket', () => {
    expect(clientIp('203.0.113.7, 10.0.0.1')).toBe('203.0.113.7');
    expect(clientIp(null)).toBe('unknown');
    expect(clientIp('  ,10.0.0.1')).toBe('unknown');
    expect(clientIp('x'.repeat(500))).toHaveLength(64);
  });
});

describe('wrong-password backoff', () => {
  const ip = '203.0.113.7';

  it('locks after the fifth failure and not before', () => {
    const store: AttemptStore = new Map();
    for (let i = 0; i < BACKOFF.threshold - 1; i += 1) {
      expect(recordFailure(store, ip, 1000)).toBe(0);
    }
    expect(lockoutSeconds(store, ip, 1000)).toBe(0);
    expect(recordFailure(store, ip, 1000)).toBe(60);
    expect(lockoutSeconds(store, ip, 1000)).toBe(60);
    expect(lockoutSeconds(store, ip, 1000 + 59_000)).toBe(1);
    expect(lockoutSeconds(store, ip, 1000 + 60_000)).toBe(0);
    expect(lockoutSeconds(store, 'someone-else', 1000)).toBe(0);
  });

  it('doubles the lockout on each further failure, up to 15 minutes', () => {
    const store: AttemptStore = new Map();
    let now = 0;
    for (let i = 0; i < BACKOFF.threshold - 1; i += 1) recordFailure(store, ip, now);
    const lockouts: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const seconds = recordFailure(store, ip, now);
      lockouts.push(seconds);
      now += seconds * 1000;
    }
    expect(lockouts).toEqual([60, 120, 240, 480, 900, 900, 900]);
  });

  it('clears on success and forgets a stale record', () => {
    const store: AttemptStore = new Map();
    for (let i = 0; i < BACKOFF.threshold; i += 1) recordFailure(store, ip, 0);
    clearFailures(store, ip);
    expect(lockoutSeconds(store, ip, 0)).toBe(0);
    expect(recordFailure(store, ip, 0)).toBe(0);

    for (let i = 0; i < BACKOFF.threshold - 2; i += 1) recordFailure(store, ip, 0);
    // One short of the threshold, then silence for longer than forgetAfterMs: counting restarts.
    expect(recordFailure(store, ip, BACKOFF.forgetAfterMs + 1)).toBe(0);
    expect(store.get(ip)?.failures).toBe(1);
  });

  it('never tracks more than maxEntries addresses, evicting the oldest', () => {
    const store: AttemptStore = new Map();
    for (let i = 0; i < BACKOFF.maxEntries + 50; i += 1) recordFailure(store, `ip-${i}`, i);
    expect(store.size).toBe(BACKOFF.maxEntries);
    expect(store.has('ip-0')).toBe(false);
    expect(store.has(`ip-${BACKOFF.maxEntries + 49}`)).toBe(true);
  });
});

describe('middleware', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const request = (path: string, headers: Record<string, string> = {}) =>
    new NextRequest(`http://dash.test${path}`, { headers });

  const loginPost = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
    new NextRequest('http://dash.test/login', {
      method: 'POST',
      body: new URLSearchParams(fields).toString(),
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    });

  const production = (password = 'hunter2') => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DASHBOARD_PASSWORD', password);
  };

  const html = { accept: 'text/html,application/xhtml+xml' };
  const location = (res: Response) => {
    const value = res.headers.get('location');
    if (!value) return null;
    const url = new URL(value);
    expect(url.origin).toBe('http://dash.test');
    return `${url.pathname}${url.search}`;
  };

  it('passes through in local dev with no env set', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DASHBOARD_PASSWORD', '');
    const res = await middleware(request('/momentum'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('returns a generic 503 in production when no password is configured', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DASHBOARD_PASSWORD', '');
    for (const req of [
      request('/momentum', html),
      request('/login', html),
      request('/logout'),
      request('/api/momentum/meta'),
      loginPost({ password: 'anything' }),
    ]) {
      const res = await middleware(req);
      expect(res.status).toBe(503);
      const body = await res.text();
      expect(body).toBe('The dashboard is not available right now.');
      expect(body).not.toMatch(/DASHBOARD|PASSWORD|UPSTREAM/);
    }
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('DASHBOARD_PASSWORD not configured'),
    );
  });

  it('returns a generic 503 for half a service token, even with the right password', async () => {
    production();
    vi.stubEnv('UPSTREAM_ACCESS_CLIENT_ID', 'real-id');
    vi.stubEnv('UPSTREAM_ACCESS_CLIENT_SECRET', '');
    const res = await middleware(
      request('/api/momentum/meta', { authorization: basic('u', 'hunter2') }),
    );
    expect(res.status).toBe(503);
    // The browser gets no configuration detail; the operator finds the reason in the log.
    expect(await res.text()).toBe('The dashboard is not available right now.');
    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/UPSTREAM_ACCESS_CLIENT_SECRET must both be set/),
    );
    expect((await middleware(loginPost({ password: 'hunter2' }))).status).toBe(503);
  });

  it('challenges with Basic auth and then lets the right password through', async () => {
    production();
    const denied = await middleware(request('/api/momentum/meta'));
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toMatch(/^Basic realm=/);

    const wrong = await middleware(
      request('/api/momentum/meta', { authorization: basic('u', 'x') }),
    );
    expect(wrong.status).toBe(401);

    const ok = await middleware(
      request('/api/momentum/meta', { authorization: basic('u', 'hunter2') }),
    );
    expect(ok.status).toBe(200);
  });

  it('adds the service token to API requests', async () => {
    production();
    vi.stubEnv('UPSTREAM_ACCESS_CLIENT_ID', 'real-id');
    vi.stubEnv('UPSTREAM_ACCESS_CLIENT_SECRET', 'real-secret');
    const res = await middleware(
      request('/api/momentum/meta', {
        authorization: basic('u', 'hunter2'),
        'cf-access-client-id': 'evil',
      }),
    );
    expect(res.headers.get('x-middleware-request-cf-access-client-id')).toBe('real-id');
    expect(res.headers.get('x-middleware-request-cf-access-client-secret')).toBe('real-secret');
    expect(res.headers.get('x-middleware-override-headers')).not.toContain('authorization');
  });

  it('redirects an unauthenticated page request to /login with the path as next', async () => {
    production();
    const res = await middleware(request('/momentum/scores?tab=a', html));
    expect(res.status).toBe(302);
    expect(res.headers.has('www-authenticate')).toBe(false);
    expect(location(res)).toBe('/login?next=%2Fmomentum%2Fscores%3Ftab%3Da');
    expect(location(await middleware(request('/', html)))).toBe('/login');
  });

  it('never redirects an API request to the login page, whatever it accepts', async () => {
    production();
    for (const path of ['/api/momentum/meta', '/retrospection/latest']) {
      const res = await middleware(request(path, html));
      expect(res.status).toBe(401);
      expect(res.headers.has('location')).toBe(false);
      expect(res.headers.get('www-authenticate')).toMatch(/^Basic realm=/);
    }
  });

  it("omits the Basic challenge on a browser's own fetch so no native prompt appears", async () => {
    production();
    const res = await middleware(request('/api/momentum/meta', { 'sec-fetch-mode': 'cors' }));
    expect(res.status).toBe(401);
    expect(res.headers.has('www-authenticate')).toBe(false);
  });

  it('gives a non-page, non-API request a 401 rather than content', async () => {
    production();
    for (const req of [
      request('/favicon.ico'),
      request('/momentum'),
      request('/_next/image?url=%2Fx.png&w=64&q=75'),
      new NextRequest('http://dash.test/momentum', { method: 'POST', headers: html }),
    ]) {
      expect((await middleware(req)).status).toBe(401);
    }
  });

  it('serves the login page without a session', async () => {
    production();
    const res = await middleware(request('/login?next=%2Fmomentum', html));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('logs in with the right password: session cookie, then redirect to next', async () => {
    production();
    const res = await middleware(loginPost({ password: 'hunter2', next: '/momentum?x=1' }));
    expect(res.status).toBe(303);
    expect(location(res)).toBe('/momentum?x=1');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=v1\\.\\d+\\.\\d+\\.[A-Za-z0-9_-]{43};`));
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
    expect(cookie).not.toContain('Secure');
    expect(cookie).not.toContain('hunter2');

    const session = cookie.split(';')[0] ?? '';
    const page = await middleware(request('/momentum', { ...html, cookie: session }));
    expect(page.status).toBe(200);
    expect(page.headers.get('x-middleware-next')).toBe('1');
    // A logged-in visit to /login goes straight on.
    expect(location(await middleware(request('/login?next=%2Ftrades', { cookie: session })))).toBe(
      '/trades',
    );
  });

  it('marks the cookie Secure behind an https proxy', async () => {
    production();
    const res = await middleware(
      loginPost({ password: 'hunter2' }, { 'x-forwarded-proto': 'https' }),
    );
    expect(res.headers.get('set-cookie')).toContain('; Secure');
    const direct = await middleware(
      new NextRequest('https://dash.test/login', {
        method: 'POST',
        body: 'password=hunter2',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    );
    expect(direct.headers.get('set-cookie')).toContain('; Secure');
  });

  it.each(['//evil.example', '/\\evil.example', 'https://evil.example/', '/.//evil.example'])(
    'does not redirect off-site after login: next=%s',
    async (next) => {
      production();
      const res = await middleware(loginPost({ password: 'hunter2', next }));
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('http://dash.test/');
    },
  );

  it('sends a wrong password back to the login page with an error and no cookie', async () => {
    production();
    const res = await middleware(
      loginPost({ password: 'nope', next: '/momentum' }, { 'x-forwarded-for': '198.51.100.1' }),
    );
    expect(res.status).toBe(303);
    expect(location(res)).toBe('/login?error=invalid&next=%2Fmomentum');
    expect(res.headers.has('set-cookie')).toBe(false);
  });

  it('passes API requests with a session cookie and keeps the cookie from the upstream', async () => {
    production();
    vi.stubEnv('UPSTREAM_ACCESS_CLIENT_ID', 'real-id');
    vi.stubEnv('UPSTREAM_ACCESS_CLIENT_SECRET', 'real-secret');
    const token = await signSession('hunter2', Date.now());
    const res = await middleware(
      request('/api/momentum/meta', { cookie: `${SESSION_COOKIE}=${token}; theme=dark` }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-request-cf-access-client-id')).toBe('real-id');
    expect(res.headers.get('x-middleware-request-cookie')).toBe('theme=dark');
  });

  it('rejects an expired session, a forged one, and one from before a password change', async () => {
    production();
    const expired = await signSession('hunter2', Date.now() - (SESSION_TTL_SECONDS + 5) * 1000);
    const oldPassword = await signSession('previous', Date.now());
    for (const token of [expired, oldPassword, 'v1.1.9999999999.AAAA', 'garbage']) {
      const res = await middleware(
        request('/momentum', { ...html, cookie: `${SESSION_COOKIE}=${token}` }),
      );
      expect(res.status).toBe(302);
    }
  });

  it('logs out: clears the cookie and redirects to /login', async () => {
    production();
    const res = await middleware(request('/logout', { 'x-forwarded-proto': 'https' }));
    expect(res.status).toBe(303);
    expect(location(res)).toBe('/login');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE}=;`));
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Secure');
  });

  it('locks an address out after five wrong passwords, on the form and on Basic auth', async () => {
    production();
    const from = { 'x-forwarded-for': '198.51.100.20' };
    for (let i = 0; i < 4; i += 1) {
      expect((await middleware(loginPost({ password: 'nope' }, from))).status).toBe(303);
    }
    const fifth = await middleware(loginPost({ password: 'nope', next: '/momentum' }, from));
    expect(fifth.status).toBe(429);
    expect(fifth.headers.get('retry-after')).toBe('60');
    const body = await fifth.text();
    expect(body).toContain('Too many attempts. Try again in a few minutes.');
    expect(body).toContain('url=/login?error=locked&amp;next=%2Fmomentum');

    // Even the right password is refused while locked, by either route, and no cookie is issued.
    const right = await middleware(loginPost({ password: 'hunter2' }, from));
    expect(right.status).toBe(429);
    expect(right.headers.has('set-cookie')).toBe(false);
    const viaBasic = await middleware(
      request('/api/momentum/meta', { ...from, authorization: basic('u', 'hunter2') }),
    );
    expect(viaBasic.status).toBe(429);
    expect(Number(viaBasic.headers.get('retry-after'))).toBeGreaterThan(0);

    // Another address is unaffected, and so is an existing session from the locked one.
    const other = await middleware(
      loginPost({ password: 'hunter2' }, { 'x-forwarded-for': '198.51.100.21' }),
    );
    expect(other.status).toBe(303);
    const token = await signSession('hunter2', Date.now());
    const withSession = await middleware(
      request('/api/momentum/meta', { ...from, cookie: `${SESSION_COOKIE}=${token}` }),
    );
    expect(withSession.status).toBe(200);
  });

  it('counts wrong Basic passwords too, and a success clears the count', async () => {
    production();
    const from = { 'x-forwarded-for': '198.51.100.30' };
    const wrong = () =>
      middleware(request('/api/momentum/meta', { ...from, authorization: basic('u', 'x') }));
    for (let i = 0; i < 4; i += 1) expect((await wrong()).status).toBe(401);
    const ok = await middleware(
      request('/api/momentum/meta', { ...from, authorization: basic('u', 'hunter2') }),
    );
    expect(ok.status).toBe(200);
    for (let i = 0; i < 4; i += 1) expect((await wrong()).status).toBe(401);
    expect((await wrong()).status).toBe(429);
  });

  it('in open local dev, /login renders and submitting or logging out just redirects', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DASHBOARD_PASSWORD', '');
    expect((await middleware(request('/login?next=%2Fmomentum', html))).status).toBe(200);
    const posted = await middleware(loginPost({ password: 'x', next: '/trades' }));
    expect(location(posted)).toBe('/trades');
    expect(posted.headers.has('set-cookie')).toBe(false);
    expect(location(await middleware(request('/logout')))).toBe('/login');
  });
});
