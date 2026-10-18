/**
 * The Options Lab favourites proxy routes (src/server/routes/backtest.ts, the "options lab
 * favourites" block): the access gate on both verbs, a strict body, and the upstream body always
 * rebuilt from validated fields. `fetch` is mocked: no network.
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

describe('options lab favourites routes', () => {
  it('GET forwards to the favourites path behind the access gate', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { lists: ['A'], strategies: [] }));
    const res = await server.inject({ method: 'GET', url: '/api/backtest/legwise/favourites' });
    expect(res.statusCode).toBe(200);
    expect(requireAccess).toHaveBeenCalled();
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/favourites',
    );
  });

  it('PUT forwards only the validated fields', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { lists: ['A', 'REF'], strategies: ['x'] }));
    const res = await server.inject({
      method: 'PUT',
      url: '/api/backtest/legwise/favourites',
      payload: { lists: ['A', 'REF'], strategies: ['x'] },
    });
    expect(res.statusCode).toBe(200);
    expect(requireAccess).toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8000/legwise/favourites');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(String(init.body))).toEqual({ lists: ['A', 'REF'], strategies: ['x'] });
  });

  it.each([
    ['an unknown list', { lists: ['Z'], strategies: [] }],
    ['a path-like strategy name', { lists: [], strategies: ['../etc'] }],
    ['a missing field', { lists: [] }],
    ['a list that is a number', { lists: [1], strategies: [] }],
  ])('PUT refuses %s before it reaches upstream', async (_label, payload) => {
    server = await buildTestServer();
    const res = await server.inject({
      method: 'PUT',
      url: '/api/backtest/legwise/favourites',
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('drops an unknown field instead of forwarding it', async () => {
    server = await buildTestServer();
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { lists: [], strategies: [] }));
    const res = await server.inject({
      method: 'PUT',
      url: '/api/backtest/legwise/favourites',
      payload: { lists: [], strategies: [], evil: '../../x' },
    });
    expect(res.statusCode).toBe(200);
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toEqual({ lists: [], strategies: [] });
  });

  it('answers 503 when the backtest service is down', async () => {
    server = await buildTestServer();
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await server.inject({ method: 'GET', url: '/api/backtest/legwise/favourites' });
    expect(res.statusCode).toBe(503);
  });
});
