/**
 * The live board proxy routes (src/server/routes/backtest.ts, the "rotation live board" block,
 * BL-203): both behind the access gate, the refresh POST forwards no client body, and the Angel
 * One guard's 409 / 429 pass through. `fetch` is mocked: no network, and no login is ever sent.
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

describe('rotation live board routes', () => {
  it('GET forwards to the live-board path behind the access gate', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { today: '2026-11-03', snapshot: null }));
    const res = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/live-board',
    });
    expect(res.statusCode).toBe(200);
    expect(requireAccess).toHaveBeenCalled();
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/live-board',
    );
  });

  it('POST refresh forwards an empty body, never the client one, and passes the 202 through', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, { status: 'requested' }));
    const res = await server.inject({
      method: 'POST',
      url: '/api/backtest/legwise/rotation/live-board/refresh',
      payload: { pin: '1234' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'requested' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8000/legwise/rotation/live-board/refresh');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
  });

  it.each([
    [409, { error: 'The live board is reading Angel One right now.' }],
    [429, { error: 'Try again in 42 s', retry_after_s: 42 }],
  ])('passes the upstream guard refusal %i through', async (status, body) => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(status, body));
    const res = await server.inject({
      method: 'POST',
      url: '/api/backtest/legwise/rotation/live-board/refresh',
    });
    expect(res.statusCode).toBe(status);
    expect(res.json()).toEqual(body);
  });
});
