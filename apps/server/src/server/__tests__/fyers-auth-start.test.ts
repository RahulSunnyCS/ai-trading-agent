import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import Fastify from 'fastify';

import { fyersAuthRoutes } from '../routes/fyers-auth';

describe('Fyers browser login start', () => {
  const original = {
    appId: process.env.FYERS_APP_ID,
    secret: process.env.FYERS_APP_SECRET,
    redirect: process.env.FYERS_REDIRECT_URI,
  };

  beforeEach(() => {
    process.env.FYERS_APP_ID = 'TEST-100';
    process.env.FYERS_APP_SECRET = 'server-only-secret';
    process.env.FYERS_REDIRECT_URI = 'http://localhost:3000/api/auth/fyers/callback';
  });

  afterEach(() => {
    if (original.appId === undefined) delete process.env.FYERS_APP_ID;
    else process.env.FYERS_APP_ID = original.appId;
    if (original.secret === undefined) delete process.env.FYERS_APP_SECRET;
    else process.env.FYERS_APP_SECRET = original.secret;
    if (original.redirect === undefined) delete process.env.FYERS_REDIRECT_URI;
    else process.env.FYERS_REDIRECT_URI = original.redirect;
  });

  it('redirects a clicked browser tab with a short-lived state, without revealing the secret', async () => {
    const server = Fastify();
    await server.register(fyersAuthRoutes);

    const response = await server.inject({ method: 'GET', url: '/api/auth/fyers/start' });
    expect(response.statusCode).toBe(302);
    expect(response.headers['cache-control']).toBe('no-store');
    const destination = new URL(String(response.headers.location));
    expect(destination.hostname).toBe('api-t1.fyers.in');
    expect(destination.searchParams.get('client_id')).toBe('TEST-100');
    expect(destination.searchParams.get('state')).toMatch(/^[a-f0-9]{32}$/);
    expect(destination.toString()).not.toContain('server-only-secret');

    await server.close();
  });

  it('keeps OAuth unavailable when the app secret is not configured', async () => {
    delete process.env.FYERS_APP_SECRET;
    const server = Fastify();
    await server.register(fyersAuthRoutes);

    const response = await server.inject({ method: 'GET', url: '/api/auth/fyers/start' });
    expect(response.statusCode).toBe(503);
    await server.close();
  });

  it('accepts the legacy registered /callback redirect URI', async () => {
    const server = Fastify();
    await server.register(fyersAuthRoutes);
    const response = await server.inject({ method: 'GET', url: '/callback?state=abc&auth_code=xyz' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/api/auth/fyers/callback?state=abc&auth_code=xyz');
    await server.close();
  });
});
