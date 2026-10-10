/**
 * The rotation daily log's proxy routes (src/server/routes/backtest.ts, the "rotation daily log"
 * block): whitelisted queries, a strict placement body, the access gate on every route, and the
 * upstream URL always rebuilt from validated fields. `fetch` is mocked: no network.
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

describe('rotation daily log routes', () => {
  it('GET log forwards only from, to and source, validated', async () => {
    server = await buildTestServer();
    for (const url of [
      '/api/backtest/legwise/rotation/log?from=12-10-2026',
      '/api/backtest/legwise/rotation/log?source=everything',
      '/api/backtest/legwise/rotation/log?to=2026-10-12%3Brm',
    ]) {
      const bad = await server.inject({ method: 'GET', url });
      expect(bad.statusCode, `${url} -> ${bad.body}`).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { rows: [] }));
    const ok = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/log?from=2026-10-12&to=2026-10-30&source=all&evil=1',
    });
    expect(ok.statusCode).toBe(200);
    expect(requireAccess).toHaveBeenCalled();
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/log?from=2026-10-12&to=2026-10-30&source=all',
    );
  });

  it('GET log with no query asks upstream for the default', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { rows: [] }));
    const res = await server.inject({ method: 'GET', url: '/api/backtest/legwise/rotation/log' });
    expect(res.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/log',
    );
  });

  it('GET day takes a date only and passes the upstream 404 through', async () => {
    server = await buildTestServer();
    const bad = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/day/..%2Fsecrets',
    });
    expect(bad.statusCode).toBe(400);
    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: 'not a day' }));
    const res = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/day/2026-10-24',
    });
    expect(res.statusCode).toBe(404);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/day/2026-10-24',
    );
  });

  it('GET placement forwards a validated range', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { current: [] }));
    const res = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/placement?from=2026-10-12&to=2026-10-16',
    });
    expect(res.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/placement?from=2026-10-12&to=2026-10-16',
    );
  });

  it('POST placement forwards a rebuilt body and is access-gated', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { row: { status: 'changed' } }));
    const res = await server.inject({
      method: 'POST',
      url: '/api/backtest/legwise/rotation/placement',
      payload: { day: '2026-10-12', list: 'REF', status: 'changed', note: 'dropped the Buy leg' },
    });
    expect(res.statusCode).toBe(200);
    expect(requireAccess).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8000/legwise/rotation/placement');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      day: '2026-10-12',
      list: 'REF',
      status: 'changed',
      note: 'dropped the Buy leg',
    });
  });

  it('POST placement sends an empty note when none is given, and never an extra field', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { row: {} }));
    await server.inject({
      method: 'POST',
      url: '/api/backtest/legwise/rotation/placement',
      payload: { day: '2026-10-12', list: 'A', status: 'placed', journal: 'rewrite' },
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      day: '2026-10-12',
      list: 'A',
      status: 'placed',
      note: '',
    });
  });

  it('POST placement refuses a bad body without calling upstream', async () => {
    server = await buildTestServer();
    const bad = [
      { day: '12/10/2026', list: 'A', status: 'placed' },
      { day: '2026-10-12', list: 'Z', status: 'placed' },
      { day: '2026-10-12', list: 'A', status: 'maybe' },
      { day: '2026-10-12', list: 'A', status: 'placed', note: 'x'.repeat(301) },
      { day: '2026-10-12', list: 'A' },
      {},
    ];
    for (const payload of bad) {
      const res = await server.inject({
        method: 'POST',
        url: '/api/backtest/legwise/rotation/placement',
        payload,
      });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET forensics takes a variant name and a date, and rebuilds the upstream query', async () => {
    server = await buildTestServer();
    for (const url of [
      '/api/backtest/legwise/rotation/forensics?variant=N_wide_0917',
      '/api/backtest/legwise/rotation/forensics?variant=..%2Fx&day=2026-10-12',
      '/api/backtest/legwise/rotation/forensics?variant=bl054_wide_0917&day=2026-10-12',
      '/api/backtest/legwise/rotation/forensics?variant=N_wide_0917&day=2026-10-12&cuts=25:99;rm',
    ]) {
      const bad = await server.inject({ method: 'GET', url });
      expect(bad.statusCode, `${url} -> ${bad.body}`).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { mtm: [] }));
    const ok = await server.inject({
      method: 'GET',
      url: '/api/backtest/legwise/rotation/forensics?variant=S_p250_1302&day=2026-10-12&cuts=10:30,13:30',
    });
    expect(ok.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/forensics?variant=S_p250_1302&day=2026-10-12&cuts=10%3A30%2C13%3A30',
    );
  });

  it('every rotation log route runs the access gate first', async () => {
    server = await buildTestServer();
    (requireAccess as ReturnType<typeof vi.fn>).mockImplementation(
      async (_req: FastifyRequest, reply: FastifyReply) => {
        await reply.status(402).send({ error: 'payment_required' });
      },
    );
    const cases: [string, string, unknown?][] = [
      ['GET', '/api/backtest/legwise/rotation/log'],
      ['GET', '/api/backtest/legwise/rotation/day/2026-10-12'],
      ['GET', '/api/backtest/legwise/rotation/placement'],
      ['GET', '/api/backtest/legwise/rotation/forensics?variant=N_wide_0917&day=2026-10-12'],
      [
        'POST',
        '/api/backtest/legwise/rotation/placement',
        { day: '2026-10-12', list: 'A', status: 'placed' },
      ],
    ];
    for (const [method, url, payload] of cases) {
      const res = await server.inject({
        method: method as 'GET' | 'POST',
        url,
        ...(payload ? { payload: payload as object } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(402);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
