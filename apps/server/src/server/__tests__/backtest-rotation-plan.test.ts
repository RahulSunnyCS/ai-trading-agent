/**
 * The Today page's baskets proxy route (`GET /api/backtest/legwise/rotation/plan`, dashboard
 * review 2026-10-28): no query reaches the Python service, and access is gated like every other
 * Options Lab route. Same harness as backtest-rotation-lot-plans.test.ts.
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

describe('GET /api/backtest/legwise/rotation/plan', () => {
  it('reaches the upstream route with no query, whatever is asked', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { sessions: [], accounts: [] }));
    const res = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/plan?evil=1',
    });
    expect(res.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/plan',
    );
  });

  it('is gated like the other Options Lab routes', async () => {
    (requireAccess as ReturnType<typeof vi.fn>).mockImplementation(
      async (_req: FastifyRequest, reply: FastifyReply) => {
        await reply.code(402).send({ error: 'no access' });
      },
    );
    server = await buildTestServer();
    const res = await server.inject({ method: 'GET', url: '/api/backtest/legwise/rotation/plan' });
    expect(res.statusCode).toBe(402);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
