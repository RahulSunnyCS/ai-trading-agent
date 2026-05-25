/**
 * portfolio-risk-multi-index.test.ts — T-45 additions
 *
 * Tests for per-(personality, underlying) portfolio stop scoping.
 *
 * Key behaviour:
 *   - Rule 3 daily stop is now scoped per (personality_id, underlying).
 *   - A BANKNIFTY loss does NOT block a NIFTY entry for the same personality.
 *   - A NIFTY loss DOES block a NIFTY entry for the same personality.
 *   - A BANKNIFTY loss does NOT block a NIFTY entry for a different personality.
 *   - Each underlying is an independent book (D2 Option A).
 *
 * All tests are unit-level: the DB pool is mocked, no network connections.
 */

import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../../utils/clock.js';
import { type TradeIntent, portfolioRiskCheck } from '../portfolio-risk.js';

// ---------------------------------------------------------------------------
// Fixed test timestamp: IST Wednesday 2026-05-20 10:00:00
// ---------------------------------------------------------------------------
const WED_1000_IST = new Date('2026-05-20T04:30:00.000Z').getTime();

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

/**
 * Build a minimal Pool mock that returns specific P&L values for the
 * (personality_id, underlying) combination.
 *
 * Only the daily stop query (Rule 3) matters here — we pass through the
 * remaining queries (Rules 4 and 5) with safe defaults.
 */
function makePoolWithPnl(opts: {
  personalityId: string;
  underlying: string;
  pnlForCombo: string;  // P&L returned ONLY for this (personality, underlying) combo
}): Pool {
  const { personalityId, underlying, pnlForCombo } = opts;

  // Track which queries were called to verify SQL param filtering
  const queryCalls: Array<{ sql: string; params: unknown[] }> = [];

  const mockQuery = vi.fn().mockImplementation((sql: string, params: unknown[]) => {
    queryCalls.push({ sql, params });

    // Rule 3: daily P&L aggregate — parameterised by (personality_id, underlying)
    if (sql.includes('SUM(net_pnl)')) {
      // The mock returns the configured P&L only when both personality and underlying match.
      // If they don't match (or params are different), return 0 (no loss).
      const queryPersonality = params[2] as string;
      const queryUnderlying = params[3] as string;
      if (queryPersonality === personalityId && queryUnderlying === underlying) {
        return Promise.resolve({ rows: [{ total_pnl: pnlForCombo }] });
      }
      return Promise.resolve({ rows: [{ total_pnl: '0' }] });
    }
    // Rule 4: margin open count
    if (sql.includes('COUNT(*)') && sql.includes("status = 'open'")) {
      return Promise.resolve({ rows: [{ cnt: '0' }] });
    }
    return Promise.resolve({ rows: [] });
  });

  const mockClient: PoolClient = {
    query: vi.fn().mockImplementation((sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('pg_try_advisory_xact_lock')) {
        return Promise.resolve({ rows: [{ acquired: true }] });
      }
      if (sql.includes('COUNT(*)')) {
        return Promise.resolve({ rows: [{ cnt: '0' }] });
      }
      return Promise.resolve({ rows: [] });
    }),
    release: vi.fn(),
  } as unknown as PoolClient;

  return {
    query: mockQuery,
    connect: vi.fn().mockResolvedValue(mockClient),
    _queryCalls: queryCalls,
  } as unknown as Pool & { _queryCalls: typeof queryCalls };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  for (const key of [
    'BLOCKED_DATES',
    'PORTFOLIO_DAILY_STOP',
    'VIX_STALE_MS',
    'MARGIN_CAPITAL',
    'MARGIN_RATE',
  ]) {
    Reflect.deleteProperty(process.env, key);
  }
});

// ---------------------------------------------------------------------------
// Per-underlying portfolio stop scoping (D2 Option A)
// ---------------------------------------------------------------------------

describe('portfolioRiskCheck — Rule 3: per-(personality, underlying) daily stop', () => {
  it('blocks when this personality has hit the NIFTY daily stop', async () => {
    process.env.BLOCKED_DATES = '[]';
    process.env.PORTFOLIO_DAILY_STOP = '20000';

    const intent: TradeIntent = {
      personalityId: 'precision',
      underlying: 'NIFTY',
      atmStrike: 24500,
      straddleValue: 200,
    };

    // NIFTY loss for 'precision' exceeds the stop
    const db = makePoolWithPnl({
      personalityId: 'precision',
      underlying: 'NIFTY',
      pnlForCombo: '-25000',
    });

    const result = await portfolioRiskCheck(db, intent, new FixedClock(WED_1000_IST), 0);
    expect(result).toEqual({ allowed: false, reason: 'PORTFOLIO_DAILY_STOP' });
  });

  it('does NOT block NIFTY when personality has a BANKNIFTY loss (independent books)', async () => {
    process.env.BLOCKED_DATES = '[]';
    process.env.PORTFOLIO_DAILY_STOP = '20000';

    // We want to enter NIFTY
    const intentNifty: TradeIntent = {
      personalityId: 'precision',
      underlying: 'NIFTY',
      atmStrike: 24500,
      straddleValue: 200,
    };

    // The BANKNIFTY P&L is bad, but NIFTY P&L is 0 for the same personality.
    // Since the daily stop query is scoped per (personality, underlying),
    // a BANKNIFTY loss should NOT block a NIFTY entry.
    const db = makePoolWithPnl({
      personalityId: 'precision',
      underlying: 'BANKNIFTY',  // Only BANKNIFTY has the loss
      pnlForCombo: '-25000',     // BANKNIFTY lost 25k
    });
    // NIFTY P&L for 'precision' is 0 (not in the loss config) — so Rule 3 passes

    const result = await portfolioRiskCheck(db, intentNifty, new FixedClock(WED_1000_IST), 0);
    // NIFTY should be allowed — the BANKNIFTY loss is in a separate book
    expect(result).toEqual({ allowed: true });
  });

  it('does NOT block a different personality when this personality has a NIFTY loss', async () => {
    process.env.BLOCKED_DATES = '[]';
    process.env.PORTFOLIO_DAILY_STOP = '20000';

    // 'momentum' personality wants to enter NIFTY
    const intentMomentum: TradeIntent = {
      personalityId: 'momentum',
      underlying: 'NIFTY',
      atmStrike: 24500,
      straddleValue: 200,
    };

    // 'precision' has a NIFTY loss — but 'momentum' should not be blocked
    const db = makePoolWithPnl({
      personalityId: 'precision',   // precision lost, not momentum
      underlying: 'NIFTY',
      pnlForCombo: '-25000',
    });

    const result = await portfolioRiskCheck(
      db,
      intentMomentum,
      new FixedClock(WED_1000_IST),
      0,
    );
    // 'momentum' is a separate personality — its NIFTY P&L is 0, not blocked
    expect(result).toEqual({ allowed: true });
  });

  it('blocks SENSEX entry when personality has hit the SENSEX daily stop', async () => {
    process.env.BLOCKED_DATES = '[]';
    process.env.PORTFOLIO_DAILY_STOP = '15000';

    const intent: TradeIntent = {
      personalityId: 'adjuster',
      underlying: 'SENSEX',
      atmStrike: 80000,
      straddleValue: 300,
    };

    const db = makePoolWithPnl({
      personalityId: 'adjuster',
      underlying: 'SENSEX',
      pnlForCombo: '-20000',  // Exceeds 15k stop
    });

    const result = await portfolioRiskCheck(db, intent, new FixedClock(WED_1000_IST), 0);
    expect(result).toEqual({ allowed: false, reason: 'PORTFOLIO_DAILY_STOP' });
  });

  it('allows BANKNIFTY entry when only SENSEX is at daily stop (independent books)', async () => {
    process.env.BLOCKED_DATES = '[]';
    process.env.PORTFOLIO_DAILY_STOP = '15000';

    // Want to enter BANKNIFTY
    const intentBanknifty: TradeIntent = {
      personalityId: 'adjuster',
      underlying: 'BANKNIFTY',
      atmStrike: 52000,
      straddleValue: 200,
    };

    // SENSEX stop is hit, but BANKNIFTY P&L is 0
    const db = makePoolWithPnl({
      personalityId: 'adjuster',
      underlying: 'SENSEX',   // SENSEX is at stop
      pnlForCombo: '-20000',
    });

    const result = await portfolioRiskCheck(
      db,
      intentBanknifty,
      new FixedClock(WED_1000_IST),
      0,
    );
    // BANKNIFTY is a separate book — should be allowed
    expect(result).toEqual({ allowed: true });
  });

  it('SQL query includes personality_id and underlying as parameters', async () => {
    process.env.BLOCKED_DATES = '[]';
    process.env.PORTFOLIO_DAILY_STOP = '20000';

    const intent: TradeIntent = {
      personalityId: 'clockwork',
      underlying: 'BANKNIFTY',
      atmStrike: 52000,
      straddleValue: 200,
    };

    const db = makePoolWithPnl({
      personalityId: 'clockwork',
      underlying: 'BANKNIFTY',
      pnlForCombo: '0',
    });

    await portfolioRiskCheck(db, intent, new FixedClock(WED_1000_IST), 0);

    // Find the SUM(net_pnl) query
    const calls = (db.query as ReturnType<typeof vi.fn>).mock.calls;
    const pnlCall = calls.find((c) => (c[0] as string).includes('SUM(net_pnl)'));
    expect(pnlCall).toBeTruthy();

    // Parameters: [istMidnightISO, istTomorrowISO, personality_id, underlying]
    const params = pnlCall![1] as unknown[];
    expect(params[2]).toBe('clockwork');
    expect(params[3]).toBe('BANKNIFTY');
  });

  it('at the stop boundary (exactly -PORTFOLIO_DAILY_STOP) — blocks (condition is <=)', async () => {
    process.env.BLOCKED_DATES = '[]';
    process.env.PORTFOLIO_DAILY_STOP = '10000';

    const intent: TradeIntent = {
      personalityId: 'reducer',
      underlying: 'NIFTY',
      atmStrike: 24500,
      straddleValue: 200,
    };

    const db = makePoolWithPnl({
      personalityId: 'reducer',
      underlying: 'NIFTY',
      pnlForCombo: '-10000',  // Exactly at the boundary
    });

    const result = await portfolioRiskCheck(db, intent, new FixedClock(WED_1000_IST), 0);
    // <= -10000 is true at -10000 → should block
    expect(result).toEqual({ allowed: false, reason: 'PORTFOLIO_DAILY_STOP' });
  });

  it('passes when P&L is just above the stop (-9999 vs -10000 stop)', async () => {
    process.env.BLOCKED_DATES = '[]';
    process.env.PORTFOLIO_DAILY_STOP = '10000';

    const intent: TradeIntent = {
      personalityId: 'reducer',
      underlying: 'NIFTY',
      atmStrike: 24500,
      straddleValue: 200,
    };

    const db = makePoolWithPnl({
      personalityId: 'reducer',
      underlying: 'NIFTY',
      pnlForCombo: '-9999',  // Just above the boundary
    });

    const result = await portfolioRiskCheck(db, intent, new FixedClock(WED_1000_IST), 0);
    // -9999 > -10000 → not at or below stop → passes
    expect(result).toEqual({ allowed: true });
  });
});

// ---------------------------------------------------------------------------
// Lot size per underlying (Rule 4 margin estimate)
// ---------------------------------------------------------------------------

describe('portfolioRiskCheck — Rule 4: per-underlying lot sizes', () => {
  afterEach(() => {
    for (const key of [
      'LOT_SIZE_NIFTY',
      'LOT_SIZE_BANKNIFTY',
      'LOT_SIZE_SENSEX',
      'MARGIN_CAPITAL',
      'MARGIN_RATE',
    ]) {
      Reflect.deleteProperty(process.env, key);
    }
  });

  it('uses per-underlying lot size for margin estimation', async () => {
    process.env.BLOCKED_DATES = '[]';
    process.env.PORTFOLIO_DAILY_STOP = '100000'; // high — won't trigger
    // Use a small capital so a single open BANKNIFTY position exceeds 70%
    process.env.MARGIN_CAPITAL = '1000';
    process.env.MARGIN_RATE = '0.20';
    // BANKNIFTY lot size default 15: 1 open * 300 (straddle) * 1 * 15 * 0.20 = 900
    // 70% of 1000 = 700 → 900 > 700 → margin exceeded

    const intent: TradeIntent = {
      personalityId: 'precision',
      underlying: 'BANKNIFTY',
      atmStrike: 52000,
      straddleValue: 300,
    };

    const db = makePoolWithPnl({
      personalityId: 'precision',
      underlying: 'BANKNIFTY',
      pnlForCombo: '0',
    });

    // Override the open count for Rule 4 to return 1
    const originalQuery = (db.query as ReturnType<typeof vi.fn>).getMockImplementation();
    (db.query as ReturnType<typeof vi.fn>).mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes('COUNT(*)') && sql.includes("status = 'open'")) {
        return Promise.resolve({ rows: [{ cnt: '1' }] });
      }
      return originalQuery!(sql, params);
    });

    const result = await portfolioRiskCheck(db, intent, new FixedClock(WED_1000_IST), 0);
    // estimatedMargin = 1 * 300 * 1 * 15 * 0.20 = 900 > 700 → MARGIN_BUFFER_EXCEEDED
    expect(result).toEqual({ allowed: false, reason: 'MARGIN_BUFFER_EXCEEDED' });
  });
});
