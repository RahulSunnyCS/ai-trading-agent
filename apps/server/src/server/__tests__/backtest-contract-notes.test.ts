/**
 * The Trade book proxy routes (`/api/backtest/legwise/contract-notes/*`, BL-168): the reads forward
 * only plain days, `broker/id` and `extremes`; the day is a plain day; the inputs PUT forwards a body
 * rebuilt from validated fields; every route is gated by requireAccess. `fetch` is mocked: no
 * network. Every account id and figure here is invented.
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

const UPSTREAM = 'http://127.0.0.1:8000/legwise/contract-notes';

function calledUrl(i = 0): string {
  return (fetchMock.mock.calls[i] as [string])[0];
}

describe('GET /api/backtest/legwise/contract-notes/*', () => {
  it.each(['summary', 'days', 'months', 'trips', 'money', 'momentum'])(
    '%s reaches its upstream route with no query when none is given',
    async (name) => {
      server = await buildTestServer();
      fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
      const res = await server.inject({
        method: 'GET',
        url: `/api/backtest/legwise/contract-notes/${name}`,
      });
      expect(res.statusCode).toBe(200);
      expect(calledUrl()).toBe(`${UPSTREAM}/${name}`);
    },
  );

  it('forwards from, to and account, and drops anything else', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    const res = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/contract-notes/days?from=2026-04-01&to=2027-03-31&account=finvasia/XX0001&evil=1',
    });
    expect(res.statusCode).toBe(200);
    expect(calledUrl()).toBe(
      `${UPSTREAM}/days?from=2026-04-01&to=2027-03-31&account=finvasia%2FXX0001`,
    );
  });

  it('forwards extremes on trips only', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/contract-notes/trips?extremes=1',
    });
    expect(calledUrl(0)).toBe(`${UPSTREAM}/trips?extremes=1`);
    await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/contract-notes/money?account=angelone/YY02&extremes=1',
    });
    expect(calledUrl(1)).toBe(`${UPSTREAM}/money`);
  });

  it('refuses a malformed day or account before it reaches Python', async () => {
    server = await buildTestServer();
    for (const q of [
      'from=yesterday',
      'to=2026-10-1',
      'from=2026-10-19%3Brm',
      'account=kite/AB12',
      'account=finvasia/..%2F..',
    ]) {
      const bad = await server.inject({
        method: 'GET',
        url: `/api/backtest/legwise/contract-notes/summary?${q}`,
      });
      expect(bad.statusCode, `${q} -> ${bad.body}`).toBe(400);
    }
    const trips = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/contract-notes/trips?extremes=yes',
    });
    expect(trips.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads one day by a plain day only', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { day: '2026-10-23' }));
    const ok = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/contract-notes/day/2026-10-23',
    });
    expect(ok.statusCode).toBe(200);
    expect(calledUrl()).toBe(`${UPSTREAM}/day/2026-10-23`);
    const bad = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/contract-notes/day/23-10-2026',
    });
    expect(bad.statusCode).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('passes an upstream error through and a dead service as 503', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: 'the data root is not available' }));
    const down = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/contract-notes/summary',
    });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ error: 'the data root is not available' });
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    const dead = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/contract-notes/summary',
    });
    expect(dead.statusCode).toBe(503);
    expect(dead.json()).toEqual({ error: 'backtest_service_unavailable' });
  });
});

describe('PUT /api/backtest/legwise/contract-notes/inputs/:day', () => {
  function put(day: string, payload: unknown) {
    return server.inject({
      method: 'PUT',
      url: `/api/backtest/legwise/contract-notes/inputs/${day}`,
      payload: payload as Record<string, unknown>,
    });
  }

  it('forwards the validated fields, nulls included', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, manual: {} }));
    const res = await put('2026-10-23', {
      algos: 9,
      capital_total: null,
      capital: { finvasia: 400000, angelone: null },
    });
    expect(res.statusCode).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${UPSTREAM}/inputs/2026-10-23`);
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({
      algos: 9,
      capital_total: null,
      capital: { finvasia: 400000, angelone: null },
    });
  });

  it('drops unknown fields before they reach Python', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true, manual: {} }));
    const res = await put('2026-10-23', { algos: 4, note: 'x', capital: { kite: 1, angelone: 5 } });
    expect(res.statusCode).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({ algos: 4, capital: { angelone: 5 } });
  });

  it('refuses a body with nothing left to save once unknown keys are stripped', async () => {
    server = await buildTestServer();
    for (const body of [{ note: 'x' }, { capital: { kite: 1 } }]) {
      const res = await put('2026-10-23', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(422);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses out-of-range values and a bad day', async () => {
    server = await buildTestServer();
    for (const body of [
      { algos: -1 },
      { algos: 201 },
      { algos: 2.5 },
      { capital_total: -5 },
      { capital_total: 200_000_000 },
      { capital: { finvasia: -1 } },
      { algos: true },
      { capital: { angelone: false } },
      {},
    ]) {
      const bad = await put('2026-10-23', body);
      expect(bad.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await put('2026-13', { algos: 1 })).statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is gated by requireAccess', async () => {
    server = await buildTestServer();
    (requireAccess as ReturnType<typeof vi.fn>).mockImplementation(
      async (_req: FastifyRequest, reply: FastifyReply) => {
        await reply.code(402).send({ error: 'payment required' });
      },
    );
    const res = await put('2026-10-23', { algos: 3 });
    expect(res.statusCode).toBe(402);
    const read = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/contract-notes/summary',
    });
    expect(read.statusCode).toBe(402);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
