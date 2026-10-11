/**
 * Strategy Matrix proxy routes (`/api/backtest/legwise/rotation/matrix*`): whitelisted, validated
 * query parameters are forwarded to the loopback Python service, anything else is refused or
 * dropped. Same harness as backtest-routes.test.ts: `fetch` is mocked, no socket is opened.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
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
  (requireAccess as ReturnType<typeof vi.fn>).mockImplementation(async () => undefined);
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

const MATRIX = '/api/backtest/legwise/rotation/matrix';

describe('GET /api/backtest/legwise/rotation/matrix', () => {
  it('forwards whitelisted params, encoded, and drops the rest', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { available: true }));
    const res = await server.inject({
      method: 'GET',
      url: `${MATRIX}?view=dte_slot&metric=win_rate&compare=P1,P2&index=NIFTY&family=wide&dte=7%2B,1&vix_band=%3C10.5,18%2B&min_n=20&list=A&basis=selected&slot=09:17&evil=1`,
    });
    expect(res.statusCode).toBe(200);
    const [url] = fetchMock.mock.calls[0] as [string];
    const upstream = new URL(url);
    expect(upstream.origin + upstream.pathname).toBe(
      'http://127.0.0.1:8000/legwise/rotation/matrix',
    );
    expect(Object.fromEntries(upstream.searchParams)).toEqual({
      view: 'dte_slot',
      metric: 'win_rate',
      compare: 'P1,P2',
      index: 'NIFTY',
      family: 'wide',
      dte: '7+,1',
      vix_band: '<10.5,18+',
      min_n: '20',
      list: 'A',
      basis: 'selected',
      slot: '09:17',
    });
  });

  it('serves the bare request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { available: true }));
    const res = await server.inject({ method: 'GET', url: MATRIX });
    expect(res.statusCode).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      'http://127.0.0.1:8000/legwise/rotation/matrix',
    );
  });

  it.each([
    `${MATRIX}?view=nope`,
    `${MATRIX}?metric=sharpe`,
    `${MATRIX}?compare=P1`,
    `${MATRIX}?compare=P1,P9`,
    `${MATRIX}?period=P4`,
    `${MATRIX}?index=BANKNIFTY`,
    `${MATRIX}?from=2025-1-1`,
    `${MATRIX}?family=wide;rm`,
    `${MATRIX}?min_n=abc`,
    `${MATRIX}?list=Z`,
    `${MATRIX}?basis=everything`,
  ])('refuses %s before it reaches Python', async (url) => {
    const res = await server.inject({ method: 'GET', url });
    expect(res.statusCode, `${url} -> ${res.body}`).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('passes an upstream error body and status through', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(422, { error: 'selection frequency needs a list' }),
    );
    const res = await server.inject({ method: 'GET', url: `${MATRIX}?metric=selection` });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body)).toEqual({ error: 'selection frequency needs a list' });
  });

  it('checks the access gate first', async () => {
    (requireAccess as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async (_req: unknown, reply: { code: (n: number) => { send: (b: unknown) => void } }) => {
        reply.code(402).send({ error: 'payment required' });
      },
    );
    const res = await server.inject({ method: 'GET', url: MATRIX });
    expect(res.statusCode).toBe(402);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/backtest/legwise/rotation/matrix/cell', () => {
  it('forwards the cell key with the same filters', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { days: [] }));
    const res = await server.inject({
      method: 'GET',
      url: `${MATRIX}/cell?view=vix_family&row=%3C10.5&col=N:wide&period=P1&list=REF`,
    });
    expect(res.statusCode).toBe(200);
    const upstream = new URL((fetchMock.mock.calls[0] as [string])[0]);
    expect(upstream.pathname).toBe('/legwise/rotation/matrix/cell');
    expect(Object.fromEntries(upstream.searchParams)).toEqual({
      view: 'vix_family',
      row: '<10.5',
      col: 'N:wide',
      period: 'P1',
      list: 'REF',
    });
  });

  it.each([
    `${MATRIX}/cell?col=0917`,
    `${MATRIX}/cell?row=N:wide`,
    `${MATRIX}/cell?row=../etc&col=0917`,
  ])('refuses %s', async (url) => {
    const res = await server.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
