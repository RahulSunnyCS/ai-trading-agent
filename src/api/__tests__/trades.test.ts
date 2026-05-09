import { mock, describe, it, expect, beforeEach } from 'bun:test';

const mockQuery = mock<(...args: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]));

mock.module('../../db/client',       () => ({ query: mockQuery }));
mock.module('../../api/ws/live-feed', () => ({ registerLiveFeed: () => {} }));

const { buildApp } = await import('../server');

import type { PaperTrade } from '../../db/schema';

function makeTrade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id:                  'trade-1',
    personality_id:      'p1',
    signal_id:           undefined,
    strategy_id:         1,
    underlying:          'NIFTY',
    expiry:              new Date('2026-05-15'),
    entry_time:          new Date('2026-05-09T09:30:00Z'),
    exit_time:           undefined,
    status:              'open',
    exit_reason:         undefined,
    entry_ce_strike:     24000,
    entry_ce_price:      100,
    exit_ce_price:       undefined,
    entry_pe_strike:     24000,
    entry_pe_price:      100,
    exit_pe_price:       undefined,
    lots:                1,
    position_multiplier: 1,
    gross_pnl:           undefined,
    net_pnl:             undefined,
    max_drawdown:        undefined,
    max_favorable_excursion: undefined,
    vix_at_entry:        14.5,
    spot_at_entry:       24000,
    straddle_at_entry:   200,
    market_regime:       'RANGING',
    has_event_flag:      false,
    ...overrides,
  };
}

describe('GET /api/trades', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns empty array when no trades', async () => {
    mockQuery.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/trades' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });

  it('returns trades list', async () => {
    const trade = makeTrade();
    mockQuery.mockResolvedValue([trade]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/trades' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('trade-1');
  });

  it('rejects invalid status param', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/trades?status=invalid' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/trades/:id', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns 404 for unknown trade', async () => {
    mockQuery.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/trades/nonexistent-id' });
    expect(res.statusCode).toBe(404);
  });

  it('returns trade by id', async () => {
    const trade = makeTrade();
    mockQuery.mockResolvedValue([trade]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/trades/trade-1' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).id).toBe('trade-1');
  });
});

describe('POST /api/trades/:id/close', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns 404 for unknown trade', async () => {
    mockQuery.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/trades/no-such-id/close' });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 if trade is already closed', async () => {
    mockQuery.mockResolvedValue([makeTrade({ status: 'closed' })]);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/trades/trade-1/close' });
    expect(res.statusCode).toBe(409);
  });

  it('closes an open trade', async () => {
    const open   = makeTrade({ status: 'open' });
    const closed = makeTrade({ status: 'closed', exit_reason: 'MANUAL' });
    // First query: SELECT existing; second: UPDATE RETURNING
    mockQuery.mockResolvedValueOnce([open]).mockResolvedValueOnce([closed]);
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/trades/trade-1/close' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).exit_reason).toBe('MANUAL');
  });
});
