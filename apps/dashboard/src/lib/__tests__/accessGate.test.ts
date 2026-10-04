import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { middleware } from '../../middleware';
import {
  basicAuthPassword,
  checkPassword,
  gateConfig,
  passwordMatches,
  upstreamHeaders,
} from '../accessGate';

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

  it('replaces client copies with the configured token', () => {
    const headers = upstreamHeaders(new Headers({ 'CF-Access-Client-Id': 'evil' }), {
      ...open,
      upstream: { clientId: 'real-id', clientSecret: 'real-secret' },
    });
    expect(headers?.get('cf-access-client-id')).toBe('real-id');
    expect(headers?.get('cf-access-client-secret')).toBe('real-secret');
  });
});

describe('middleware', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const request = (path: string, headers: Record<string, string> = {}) =>
    new NextRequest(`http://dash.test${path}`, { headers });

  it('passes through in local dev with no env set', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DASHBOARD_PASSWORD', '');
    const res = await middleware(request('/momentum'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('returns 503 in production when no password is configured', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DASHBOARD_PASSWORD', '');
    const res = await middleware(request('/momentum'));
    expect(res.status).toBe(503);
  });

  it('returns 503 for half a service token, even with the right password', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DASHBOARD_PASSWORD', 'hunter2');
    vi.stubEnv('UPSTREAM_ACCESS_CLIENT_ID', 'real-id');
    vi.stubEnv('UPSTREAM_ACCESS_CLIENT_SECRET', '');
    const res = await middleware(
      request('/api/momentum/meta', { authorization: basic('u', 'hunter2') }),
    );
    expect(res.status).toBe(503);
    expect(await res.text()).toMatch(/UPSTREAM_ACCESS_CLIENT_SECRET must both be set/);
  });

  it('challenges with Basic auth and then lets the right password through', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DASHBOARD_PASSWORD', 'hunter2');
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
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DASHBOARD_PASSWORD', 'hunter2');
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
});
