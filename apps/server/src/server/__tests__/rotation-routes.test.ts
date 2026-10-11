/**
 * The Rotation page's read routes in src/server/routes/backtest.ts (BL-058 Phase 4): whitelisted
 * params reach the Python service, anything else is dropped or refused. Same harness as
 * backtest-routes.test.ts (inject(), a mocked fetch).
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

let server: FastifyInstance;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.BACKTEST_API_URL = 'http://127.0.0.1:8000';
  (isPaymentEnabled as ReturnType<typeof vi.fn>).mockReturnValue(false);
  (requireAccess as ReturnType<typeof vi.fn>).mockImplementation(
    async (_req: FastifyRequest, _reply: FastifyReply) => undefined,
  );
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  server = Fastify({ logger: false });
  server.decorate('db', { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Pool);
  await server.register(backtestRoutes);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await server.close();
});

describe('rotation read routes', () => {
  it('forwards overview with a valid day and drops unknown params', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { health: {} }));
    const res = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/overview?day=2026-10-12',
    });
    expect(res.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/overview?day=2026-10-12',
    );
  });

  it('forwards summary with from and to', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { n_days: 0 }));
    const res = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/summary?from=2026-10-12&to=2026-12-31',
    });
    expect(res.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/summary?from=2026-10-12&to=2026-12-31',
    );
  });

  it('refuses a malformed date without calling Python', async () => {
    for (const url of [
      '/api/backtest/legwise/rotation/overview?day=tomorrow',
      '/api/backtest/legwise/rotation/summary?from=2026-1-1',
    ]) {
      const res = await server.inject({ method: 'GET', url });
      expect(res.statusCode, `${url} -> ${res.body}`).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops a parameter it does not know instead of forwarding it', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { n_days: 0 }));
    const res = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/summary?from=2026-10-12&evil=../../etc',
    });
    expect(res.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/summary?from=2026-10-12',
    );
  });
});
