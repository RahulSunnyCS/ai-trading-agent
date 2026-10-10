/**
 * The rotation explain / rank-correlation proxy routes (src/server/routes/backtest.ts, the
 * "rotation explain" block): params are whitelisted and validated, nothing else is forwarded, and
 * the Python service's error body passes through unchanged.
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

describe('GET /api/backtest/legwise/rotation/explain', () => {
  it('forwards day, list and top and drops anything else', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { day: '2026-10-12' }));
    const res = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/explain?day=2026-10-12&list=REF&top=5',
    });
    expect(res.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/explain?day=2026-10-12&list=REF&top=5',
    );
  });

  it('refuses a malformed day, an unknown list and a non-numeric or oversized top', async () => {
    server = await buildTestServer();
    for (const query of ['day=12-10-2026', 'list=Z', 'top=abc', 'top=123', 'day=2026-10-12%3Brm']) {
      const res = await server.inject({
        method: 'GET',
        url: `/api/backtest/legwise/rotation/explain?${query}`,
      });
      expect(res.statusCode, `${query} -> ${res.body}`).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops a parameter that is not whitelisted', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { day: '2026-10-12' }));
    await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/explain?day=2026-10-12&path=%2Fetc%2Fpasswd&list=A',
    });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/explain?day=2026-10-12&list=A',
    );
  });

  it('passes the service error body and status through', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, { error: 'only 12 earlier days of results before 2025-01-01' }),
    );
    const res = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/explain?day=2025-01-01',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'only 12 earlier days of results before 2025-01-01' });
  });

  it('is behind the access gate', async () => {
    server = await buildTestServer();
    (requireAccess as ReturnType<typeof vi.fn>).mockImplementation(
      async (_req: FastifyRequest, reply: FastifyReply) => {
        await reply.code(402).send({ error: 'payment required' });
      },
    );
    const res = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/explain',
    });
    expect(res.statusCode).toBe(402);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/backtest/legwise/rotation/ic', () => {
  it('forwards from, to, list and mode', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { days: [] }));
    const ok = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/ic?from=2025-12-03&to=2026-10-08&list=A&mode=research&x=1',
    });
    expect(ok.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/ic?from=2025-12-03&to=2026-10-08&list=A&mode=research',
    );
  });

  it('refuses an unknown mode and a malformed date', async () => {
    server = await buildTestServer();
    for (const query of ['mode=pooled', 'from=yesterday', 'list=a']) {
      const res = await server.inject({
        method: 'GET',
        url: `/api/backtest/legwise/rotation/ic?${query}`,
      });
      expect(res.statusCode, `${query} -> ${res.body}`).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
