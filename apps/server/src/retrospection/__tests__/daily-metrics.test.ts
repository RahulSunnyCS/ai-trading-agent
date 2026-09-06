/**
 * Unit tests for daily-metrics.ts
 *
 * All tests use an injected mock pool — no real database required.
 * pg NUMERIC columns are represented as strings (e.g. '0.65') matching
 * the runtime behaviour of the pg.types.setTypeParser(1700) override.
 */

import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { computeBeatClockworkDelta, computeDailyMetrics } from '../daily-metrics.js';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/** Build a mock Pool whose query() resolves to the supplied rows array. */
function makePool(rows: Record<string, unknown>[]): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// computeDailyMetrics
// ---------------------------------------------------------------------------

describe('computeDailyMetrics', () => {
  it('returns correct aggregates for 3 closed trades with known pnl_pct values', async () => {
    const rows = [
      { id: 'trade-1', pnl_pct: '2.50', pnl_abs: '500.00' },
      { id: 'trade-2', pnl_pct: '-1.00', pnl_abs: '-200.00' },
      { id: 'trade-3', pnl_pct: '3.00', pnl_abs: '600.00' },
    ];
    const pool = makePool(rows);

    const result = await computeDailyMetrics(pool, 'personality-uuid-1', '2024-11-15');

    expect(result.totalTrades).toBe(3);
    expect(result.winningTrades).toBe(2);
    expect(result.totalPnlPct).toBeCloseTo(4.5, 10);
    expect(result.winRate).toBeCloseTo(2 / 3, 10);
    expect(result.closedTradeIds).toEqual(['trade-1', 'trade-2', 'trade-3']);
  });

  it('returns the zero-state struct when the pool returns no rows', async () => {
    const pool = makePool([]);

    const result = await computeDailyMetrics(pool, 'personality-uuid-1', '2024-11-15');

    expect(result).toEqual({
      totalTrades: 0,
      winningTrades: 0,
      totalPnlPct: 0,
      winRate: 0,
      closedTradeIds: [],
    });
  });

  it('excludes a trade whose pnl_pct is the string "NaN" from aggregates but still includes its id in closedTradeIds', async () => {
    // The trade with pnl_pct='NaN' is corrupt data. Number('NaN') === NaN,
    // which is not finite, so it must be excluded from winningTrades and
    // totalPnlPct. However, its ID is still pushed to closedTradeIds so that
    // callers can identify which trade was skipped.
    const rows = [
      { id: 'trade-good', pnl_pct: '2.00', pnl_abs: '400.00' },
      { id: 'trade-bad', pnl_pct: 'NaN', pnl_abs: '0.00' },
    ];
    const pool = makePool(rows);

    const result = await computeDailyMetrics(pool, 'personality-uuid-1', '2024-11-15');

    // totalTrades = raw row count — includes the bad row
    expect(result.totalTrades).toBe(2);
    // Only the good row contributes to aggregates
    expect(result.winningTrades).toBe(1);
    expect(result.totalPnlPct).toBeCloseTo(2.0, 10);
    // winRate divides winning by raw total (2), not the finite subset (1)
    expect(result.winRate).toBeCloseTo(1 / 2, 10);
    // Both IDs appear in closedTradeIds — audit trail includes the bad row
    expect(result.closedTradeIds).toContain('trade-good');
    expect(result.closedTradeIds).toContain('trade-bad');
  });

  it('counts only strictly positive pnl_pct as a win — breakeven trade (0.00) is not counted', async () => {
    const rows = [
      { id: 'trade-win', pnl_pct: '1.50', pnl_abs: '300.00' },
      { id: 'trade-even', pnl_pct: '0.00', pnl_abs: '0.00' },
      { id: 'trade-loss', pnl_pct: '-0.50', pnl_abs: '-100.00' },
    ];
    const pool = makePool(rows);

    const result = await computeDailyMetrics(pool, 'personality-uuid-1', '2024-11-15');

    expect(result.winningTrades).toBe(1);
    expect(result.totalTrades).toBe(3);
    expect(result.winRate).toBeCloseTo(1 / 3, 10);
  });
});

// ---------------------------------------------------------------------------
// computeBeatClockworkDelta
// ---------------------------------------------------------------------------

describe('computeBeatClockworkDelta', () => {
  it('returns null when Clockwork has zero trades (count = "0")', async () => {
    // COUNT(*) returns '0' as a string. The function must not treat this as
    // "Clockwork earned 0%" — it should return null to signal "no data".
    const pool = makePool([{ count: '0', total: 0 }]);

    const result = await computeBeatClockworkDelta(pool, 1.5, '2024-11-15', 'RANGING');

    expect(result).toBeNull();
  });

  it('returns personality total minus Clockwork sum when Clockwork has trades', async () => {
    // Clockwork has 2 trades summing to 1.20 total P&L%.
    // Personality total is 3.00. Delta should be 3.00 - 1.20 = 1.80.
    const pool = makePool([{ count: '2', total: 1.2 }]);

    const result = await computeBeatClockworkDelta(pool, 3.0, '2024-11-15', 'RANGING');

    expect(result).toBeCloseTo(1.8, 10);
  });

  it('returns a negative delta when personality underperforms Clockwork', async () => {
    // Personality total = 0.50, Clockwork total = 2.00. Delta = -1.50.
    const pool = makePool([{ count: '3', total: 2.0 }]);

    const result = await computeBeatClockworkDelta(pool, 0.5, '2024-11-15', 'TRENDING_STRONG');

    expect(result).toBeCloseTo(-1.5, 10);
  });

  it('returns null when personalityTotalPnlPct is Infinity', async () => {
    // Non-finite input at function entry must short-circuit before any query.
    // We supply a pool that would return valid Clockwork data — it must not
    // even be called.
    const pool = makePool([{ count: '5', total: 2.0 }]);

    const result = await computeBeatClockworkDelta(
      pool,
      Number.POSITIVE_INFINITY,
      '2024-11-15',
      'RANGING',
    );

    expect(result).toBeNull();
  });

  it('returns null when personalityTotalPnlPct is NaN', async () => {
    const pool = makePool([{ count: '5', total: 2.0 }]);

    const result = await computeBeatClockworkDelta(pool, Number.NaN, '2024-11-15', 'RANGING');

    expect(result).toBeNull();
  });
});
