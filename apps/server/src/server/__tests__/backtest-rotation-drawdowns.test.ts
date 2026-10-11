/**
 * The "Drawdown episodes" proxy route (`GET /api/backtest/legwise/rotation/drawdowns`): list and
 * window are enums, min_depth is a plain non-negative number, anything else is refused or dropped
 * before it reaches the Python service, and access is gated like every other Options Lab route.
 * Same harness as backtest-routes.test.ts.
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

describe('GET /api/backtest/legwise/rotation/drawdowns', () => {
  it('reaches the upstream route with no query when none is given', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { episodes: [] }));
    const res = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/drawdowns',
    });
    expect(res.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/drawdowns',
    );
  });

  it('forwards list, window and min_depth and drops anything else', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const res = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/drawdowns?list=REF&window=last63&min_depth=250&evil=1',
    });
    expect(res.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/drawdowns?list=REF&window=last63&min_depth=250',
    );
  });

  it('forwards the portfolio stop and trail, and refuses a malformed one', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const ok = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/drawdowns?list=A&stop=10000&trail=sl:1000,500',
    });
    expect(ok.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/drawdowns?list=A&stop=10000&trail=sl%3A1000%2C500',
    );
    for (const q of ['stop=abc', 'trail=evil:1,2', 'stop=1e9']) {
      const bad = await server.inject({
        method: 'GET',
        url: `/api/backtest/legwise/rotation/drawdowns?${q}`,
      });
      expect(bad.statusCode, `${q} -> ${bad.body}`).toBe(400);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses an unknown list or window and a malformed depth', async () => {
    server = await buildTestServer();
    for (const q of [
      'list=BASE',
      'list=Z',
      'window=custom',
      'min_depth=-1',
      'min_depth=abc',
      'min_depth=1e9',
      'min_depth=5%3Brm',
    ]) {
      const bad = await server.inject({
        method: 'GET',
        url: `/api/backtest/legwise/rotation/drawdowns?${q}`,
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
      url: '/api/backtest/legwise/rotation/drawdowns',
    });
    expect(res.statusCode).toBe(402);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
