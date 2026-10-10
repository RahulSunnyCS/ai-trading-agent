/**
 * The Correlation tab's "Today's basket" proxy route (`GET /api/backtest/legwise/rotation/basket`):
 * the list and window are enums, the three dates are validated, anything else is refused before it
 * reaches the Python service, and access is gated like every other Options Lab route. Same harness
 * as backtest-routes.test.ts.
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

describe('GET /api/backtest/legwise/rotation/basket', () => {
  it('reaches the upstream route with no query when none is given', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { list: 'A' }));
    const res = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/basket',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ list: 'A' });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/basket',
    );
  });

  it('forwards the five whitelisted parameters and drops anything else', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const res = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/basket?list=BASE&day=2026-10-12&window=custom&from=2026-01-01&to=2026-03-31&evil=1',
    });
    expect(res.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/basket?list=BASE&day=2026-10-12&window=custom&from=2026-01-01&to=2026-03-31',
    );
  });

  it('refuses an unknown list, window or date before it reaches Python', async () => {
    server = await buildTestServer();
    for (const q of [
      'list=Z',
      'window=fortnight',
      'day=yesterday',
      'from=2026-10-1',
      'to=2026-10-12%3Brm',
    ]) {
      const bad = await server.inject({
        method: 'GET',
        url: `/api/backtest/legwise/rotation/basket?${q}`,
      });
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
    const res = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/basket',
    });
    expect(res.statusCode).toBe(402);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
