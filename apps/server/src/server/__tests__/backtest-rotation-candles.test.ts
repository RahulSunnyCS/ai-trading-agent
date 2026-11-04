/**
 * The candle card's proxy route (`GET /api/backtest/legwise/rotation/candles`): its query is
 * matched to a strict shape, an empty `stop` (no stop) reaches the Python service as such, and
 * access is gated like every other Options Lab route. Same harness as backtest-routes.test.ts.
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
  await server?.close();
});

const URL = '/api/backtest/legwise/rotation/candles';
const UP = 'http://127.0.0.1:8000/legwise/rotation/candles';

describe('GET /api/backtest/legwise/rotation/candles', () => {
  it('forwards the book, window, lots and slippage and drops anything else', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { days: [] }));
    const res = await server.inject({
      method: 'GET',
      url: `${URL}?book=base&from=2025-01-10&to=2026-11-04&lots=2&slippage=0.5&evil=1`,
    });
    expect(res.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      `${UP}?book=base&from=2025-01-10&to=2026-11-04&lots=2&slippage=0.5`,
    );
  });

  it('passes an empty stop through as no stop, and a missing one not at all', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await server.inject({ method: 'GET', url: `${URL}?book=t1&stop=` });
    await server.inject({ method: 'GET', url: `${URL}?stop=12000` });
    await server.inject({ method: 'GET', url: URL });
    const urls = fetchMock.mock.calls.map((c) => (c as [string])[0]);
    expect(urls).toEqual([`${UP}?book=t1&stop=`, `${UP}?stop=12000`, UP]);
  });

  it('passes the warming answer through', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, { status: 'warming' }));
    const res = await server.inject({ method: 'GET', url: `${URL}?book=t1` });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'warming' });
  });

  it('refuses a bad value before it reaches Python', async () => {
    server = await buildTestServer();
    for (const q of [
      'book=ref',
      'lots=0',
      'lots=11',
      'from=19-10-2026',
      'stop=nan',
      'slippage=2',
    ]) {
      const bad = await server.inject({ method: 'GET', url: `${URL}?${q}` });
      expect(bad.statusCode, `${q} -> ${bad.body}`).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is gated by requireAccess', async () => {
    server = await buildTestServer();
    (requireAccess as ReturnType<typeof vi.fn>).mockImplementation(
      async (_req: FastifyRequest, reply: FastifyReply) => {
        await reply.code(402).send({ error: 'payment required' });
      },
    );
    const res = await server.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(402);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
