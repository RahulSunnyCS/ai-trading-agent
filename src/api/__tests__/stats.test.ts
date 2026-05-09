import { mock, describe, it, expect, beforeEach } from 'bun:test';

const mockQuery = mock<(...args: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]));

mock.module('../../db/client',       () => ({ query: mockQuery }));
mock.module('../../api/ws/live-feed', () => ({ registerLiveFeed: () => {} }));

const { buildApp } = await import('../server');

const today = new Date().toISOString().slice(0, 10);

describe('GET /api/stats', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns zeroed stats when DB is empty', async () => {
    // stats runs 5 queries in parallel; each returns []
    mockQuery.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.date).toBe(today);
    expect(body.open_trades).toBe(0);
    expect(body.total_pnl_today).toBe(0);
    expect(body.best_personality).toBeNull();
    expect(body.signals_today).toBe(0);
    expect(body.market_regime).toBeNull();
  });

  it('returns correct aggregates from mock data', async () => {
    // 5 parallel queries: openResult, pnlResult, bestResult, signalsResult, regimeResult
    mockQuery
      .mockResolvedValueOnce([{ count: '3' }])
      .mockResolvedValueOnce([{ total: '12500.50' }])
      .mockResolvedValueOnce([{ name: 'Momentum', pnl: '9000' }])
      .mockResolvedValueOnce([{ count: '7' }])
      .mockResolvedValueOnce([{ market_regime: 'TRENDING_STRONG' }]);

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/stats' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.open_trades).toBe(3);
    expect(body.total_pnl_today).toBeCloseTo(12500.5);
    expect(body.best_personality).toBe('Momentum');
    expect(body.signals_today).toBe(7);
    expect(body.market_regime).toBe('TRENDING_STRONG');
  });
});

describe('GET /api/health', () => {
  it('returns ok', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ok');
  });
});
