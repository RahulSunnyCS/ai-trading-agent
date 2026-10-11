/**
 * The portfolio-stop proxy routes (`GET /api/backtest/legwise/rotation/portfolio/{day,days}`,
 * BL-095): the day, list, source, stop and trail are matched to strict shapes before they reach
 * the Python service, anything else is dropped or refused, and access is gated like every other
 * Options Lab route. Same harness as backtest-rotation-drift.test.ts.
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

const BASE = '/api/backtest/legwise/rotation/portfolio';

describe('GET /api/backtest/legwise/rotation/portfolio/day', () => {
  it('forwards day, list, source, stop and trail as typed', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { book: {} }));
    const res = await server.inject({
      method: 'GET',
      url: `${BASE}/day?day=2026-09-11&list=A&source=reconstructed&stop=10000&trail=sl:1000,500`,
    });
    expect(res.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/portfolio/day?day=2026-09-11&list=A&source=reconstructed&stop=10000&trail=sl%3A1000%2C500',
    );
  });

  it('takes source=all, the day route’s filter default', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const res = await server.inject({
      method: 'GET',
      url: `${BASE}/day?day=2026-09-11&list=A&source=all`,
    });
    expect(res.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toContain('&source=all');
  });

  it('passes a 202 warming answer through unchanged (a cold replay is still running)', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(202, { status: 'warming' }));
    const res = await server.inject({ method: 'GET', url: `${BASE}/days?stop=10000` });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: 'warming' });
  });

  it('drops a parameter it does not know', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const res = await server.inject({
      method: 'GET',
      url: `${BASE}/day?day=2026-09-11&evil=1&window=P1`,
    });
    expect(res.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/portfolio/day?day=2026-09-11',
    );
  });

  it('accepts all three trailing modes', async () => {
    server = await buildTestServer();
    for (const trail of ['sl:1000,500', 'lock:2000,500', 'locktrail:2000,500,1000,250']) {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
      const res = await server.inject({
        method: 'GET',
        url: `${BASE}/day?day=2026-09-11&stop=10000&trail=${encodeURIComponent(trail)}`,
      });
      expect(res.statusCode, trail).toBe(200);
    }
  });

  it('forwards an empty stop as no stop (the field was cleared)', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const res = await server.inject({
      method: 'GET',
      url: `${BASE}/day?day=2026-09-11&list=A&stop=`,
    });
    expect(res.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/portfolio/day?day=2026-09-11&list=A',
    );
  });

  it('refuses anything that is not the strict shape before it reaches Python', async () => {
    server = await buildTestServer();
    const bad = [
      'day=2026-9-1',
      'day=2026-09-11&list=Z',
      'day=2026-09-11&list=A%3Brm',
      'day=2026-09-11&source=nope',
      'day=2026-09-11&stop=abc',
      'day=2026-09-11&stop=1e9',
      'day=2026-09-11&trail=evil:1,2',
      'day=2026-09-11&trail=sl:1',
      'day=2026-09-11&trail=sl:1,2,3,4,5',
      'list=A',
    ];
    for (const q of bad) {
      const res = await server.inject({ method: 'GET', url: `${BASE}/day?${q}` });
      expect(res.statusCode, `${q} -> ${res.body}`).toBe(400);
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
    const res = await server.inject({ method: 'GET', url: `${BASE}/day?day=2026-09-11` });
    expect(res.statusCode).toBe(402);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/backtest/legwise/rotation/portfolio/days', () => {
  it('reaches the upstream route with no query when none is given', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { rows: [] }));
    const res = await server.inject({ method: 'GET', url: `${BASE}/days` });
    expect(res.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/portfolio/days',
    );
  });

  it('forwards the window, source, stop and trail', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const res = await server.inject({
      method: 'GET',
      url: `${BASE}/days?from=2026-09-01&to=2026-09-30&source=reconstructed&stop=8000.5&trail=lock:2000,500`,
    });
    expect(res.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/portfolio/days?from=2026-09-01&to=2026-09-30&source=reconstructed&stop=8000.5&trail=lock%3A2000%2C500',
    );
  });

  it('refuses a malformed window or setting', async () => {
    server = await buildTestServer();
    for (const q of ['from=junk', 'to=2026-13', 'source=x', 'stop=;', 'trail=sl:a,b']) {
      const res = await server.inject({ method: 'GET', url: `${BASE}/days?${q}` });
      expect(res.statusCode, `${q} -> ${res.body}`).toBe(400);
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
    const res = await server.inject({ method: 'GET', url: `${BASE}/days` });
    expect(res.statusCode).toBe(402);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
