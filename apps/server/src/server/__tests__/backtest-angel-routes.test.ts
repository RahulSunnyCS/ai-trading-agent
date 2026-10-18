/**
 * The Angel One connection proxy routes (src/server/routes/backtest.ts, the "angel one
 * connection" block): both behind the access gate, the test POST forwards no client body and
 * keeps the usual timeout (upstream answers 202 at once), and the guard's 409 / 429 pass through. `fetch` is mocked: no
 * network, and no login is ever sent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

vi.mock('../../payment/razorpay', () => ({
  isPaymentEnabled: vi.fn(),
  consumeCredit: vi.fn(),
}));

vi.mock('../middleware/access-gate', () => ({
  requireAccess: vi.fn(),
}));

import { isPaymentEnabled } from '../../payment/razorpay';
import { requireAccess } from '../middleware/access-gate';
import { backtestRoutes } from '../routes/backtest';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function buildTestServer(): Promise<FastifyInstance> {
  const server = Fastify({ logger: false });
  server.decorate('db', { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool);
  await server.register(backtestRoutes);
  return server;
}

let server: FastifyInstance;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BACKTEST_API_URL = 'http://127.0.0.1:8000';
  (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (requireAccess as ReturnType<typeof vi.fn>).mockImplementation(
    async (_req: FastifyRequest, _reply: FastifyReply) => undefined,
  );
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await server?.close();
});

describe('angel one connection routes', () => {
  it('GET status forwards to the angel status path behind the access gate', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { configured: true, credentials: [] }));
    const res = await server.inject({ method: 'GET', url: '/api/backtest/legwise/angel/status' });
    expect(res.statusCode).toBe(200);
    expect(requireAccess).toHaveBeenCalled();
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/angel/status',
    );
  });

  it('POST test forwards an empty body, never the client one, and passes the 202 through', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    server = await buildTestServer();
    const started = { status: 'started', started_at: '2026-10-18T10:00:00+05:30' };
    fetchMock.mockResolvedValueOnce(jsonResponse(202, started));
    const res = await server.inject({
      method: 'POST',
      url: '/api/backtest/legwise/angel/test',
      payload: { client: 'X', pin: '1234' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual(started);
    expect(requireAccess).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8000/legwise/angel/test');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(timeout).toHaveBeenCalledWith(30_000); // the usual timeout: the POST answers at once
  });

  it('refuses before upstream when the access gate refuses', async () => {
    (requireAccess as ReturnType<typeof vi.fn>).mockImplementation(
      async (_req: FastifyRequest, reply: FastifyReply) => {
        await reply.status(402).send({ error: 'payment_required' });
      },
    );
    server = await buildTestServer();
    const res = await server.inject({ method: 'POST', url: '/api/backtest/legwise/angel/test' });
    expect(res.statusCode).toBe(402);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [409, { error: 'An Angel One connection test is already running.' }],
    [429, { error: 'Try again in 42 s', retry_after_s: 42 }],
  ])('passes the upstream guard refusal %i through', async (status, body) => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(status, body));
    const res = await server.inject({ method: 'POST', url: '/api/backtest/legwise/angel/test' });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual(body);
  });

  it('answers 503 when the backtest service is down', async () => {
    server = await buildTestServer();
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await server.inject({ method: 'GET', url: '/api/backtest/legwise/angel/status' });
    expect(res.statusCode).toBe(503);
  });
});
