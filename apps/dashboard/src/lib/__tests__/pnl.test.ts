/**
 * Unit tests for src/frontend/lib/pnl.ts
 *
 * All IST date-boundary assertions inject an explicit `today` string so tests
 * are deterministic regardless of when they run (CI is in UTC; dev machines
 * may be in any timezone).  We never rely on wall-clock time here.
 *
 * Test categories:
 *  1. Closed-only filtering (open trades must not affect realized totals)
 *  2. Null / NaN net_pnl exclusion (never treated as 0)
 *  3. Divide-by-zero win rate → 0
 *  4. IST today-boundary selection (exits that straddle the IST midnight boundary)
 *  5. Cumulative series: ordering by exit_time ascending, null exclusions
 */

import { describe, expect, it } from 'vitest';
import type { PaperTrade } from '../../types/trading.js';
import { computePnlSummary } from '../pnl.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal PaperTrade fixture with sensible defaults.
 * Only callers that care about a field need to override it.
 */
function makeTrade(overrides: Partial<PaperTrade> = {}): PaperTrade {
  return {
    id: 'trade-1',
    entry_time: '2026-05-20T09:15:00.000Z',
    exit_time: '2026-05-20T10:30:00.000Z', // default: closed today
    status: 'closed',
    straddle_at_entry: '200.00',
    entry_ce_price: '100.00',
    entry_pe_price: '100.00',
    gross_pnl: '150.00',
    net_pnl: '140.00',
    exit_reason: 'target',
    lots: 1,
    lot_size: 50,
    ...overrides,
  };
}

// A fixed "today" string for deterministic IST-today tests.
// This is the IST date for 2026-05-20T09:15:00Z, which is 14:45 IST on 2026-05-20.
const TODAY_IST = '2026-05-20';

// ---------------------------------------------------------------------------
// 1. Closed-only filtering
// ---------------------------------------------------------------------------

describe('computePnlSummary — closed-only filtering', () => {
  it('counts open trades in openCount but excludes them from P&L', () => {
    const trades: PaperTrade[] = [
      makeTrade({
        id: 'c1',
        status: 'closed',
        net_pnl: '100.00',
        exit_time: '2026-05-20T10:00:00.000Z',
      }),
      makeTrade({ id: 'o1', status: 'open', net_pnl: '999.00', exit_time: null }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    expect(summary.openCount).toBe(1);
    expect(summary.closedCount).toBe(1);
    // The open trade's P&L must NOT appear in the realized total.
    expect(summary.totalRealizedPnl).toBe(100);
  });

  it('returns zero totalRealizedPnl when all trades are open', () => {
    const trades: PaperTrade[] = [
      makeTrade({ id: 'o1', status: 'open', net_pnl: '500.00', exit_time: null }),
      makeTrade({ id: 'o2', status: 'open', net_pnl: '200.00', exit_time: null }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    expect(summary.totalRealizedPnl).toBe(0);
    expect(summary.openCount).toBe(2);
    expect(summary.closedCount).toBe(0);
  });

  it('returns correct counts when all trades are closed', () => {
    const trades: PaperTrade[] = [
      makeTrade({ id: 'c1', status: 'closed', net_pnl: '50.00' }),
      makeTrade({ id: 'c2', status: 'closed', net_pnl: '-30.00' }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    expect(summary.openCount).toBe(0);
    expect(summary.closedCount).toBe(2);
  });

  it('handles an empty trade list without throwing', () => {
    const summary = computePnlSummary([], TODAY_IST);
    expect(summary.totalRealizedPnl).toBe(0);
    expect(summary.openCount).toBe(0);
    expect(summary.closedCount).toBe(0);
    expect(summary.winRate).toBe(0);
    expect(summary.cumulativeSeries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. Null / NaN net_pnl exclusion
// ---------------------------------------------------------------------------

describe('computePnlSummary — null net_pnl exclusion', () => {
  it('skips a null net_pnl trade in the total (does not sum it as 0)', () => {
    const trades: PaperTrade[] = [
      makeTrade({ id: 'c1', status: 'closed', net_pnl: '100.00' }),
      // null net_pnl — must be skipped, not added as 0
      makeTrade({ id: 'c2', status: 'closed', net_pnl: null }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    // If the null were summed as 0 the total would still be 100, but the
    // real risk is that NaN-from-parseFloat(null) would corrupt the sum
    // or that a zero would inflate the win-rate denominator.
    // closedCount must still be 2 (we counted the trade even though its P&L is null).
    expect(summary.closedCount).toBe(2);
    expect(summary.totalRealizedPnl).toBe(100);
  });

  it('skips a malformed (non-numeric) net_pnl string', () => {
    const trades: PaperTrade[] = [
      makeTrade({ id: 'c1', status: 'closed', net_pnl: 'n/a' }),
      makeTrade({ id: 'c2', status: 'closed', net_pnl: '200.00' }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    expect(summary.totalRealizedPnl).toBe(200);
  });

  it('null net_pnl trade does not count as a winner', () => {
    // If null were treated as 0 it still would not be >0, so win rate would be
    // 0/2 = 0.  But a null should not count as a loser either.
    // A winner is defined as net_pnl > 0 — null has no sign, so skip entirely.
    const trades: PaperTrade[] = [
      makeTrade({ id: 'c1', status: 'closed', net_pnl: '100.00' }), // winner
      makeTrade({ id: 'c2', status: 'closed', net_pnl: null }), // skip
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    // 1 winner out of 2 closed trades = 0.5
    expect(summary.winRate).toBe(0.5);
  });

  it('sums multiple valid net_pnl values correctly', () => {
    const trades: PaperTrade[] = [
      makeTrade({ id: 'c1', status: 'closed', net_pnl: '300.00' }),
      makeTrade({ id: 'c2', status: 'closed', net_pnl: '-100.00' }),
      makeTrade({ id: 'c3', status: 'closed', net_pnl: null }), // skipped
      makeTrade({ id: 'c4', status: 'closed', net_pnl: '50.00' }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    // 300 - 100 + 50 = 250 (null excluded)
    expect(summary.totalRealizedPnl).toBeCloseTo(250, 5);
  });
});

// ---------------------------------------------------------------------------
// 3. Win rate — divide-by-zero guard
// ---------------------------------------------------------------------------

describe('computePnlSummary — win rate', () => {
  it('returns 0 when there are no closed trades (guard against divide-by-zero)', () => {
    const trades: PaperTrade[] = [
      makeTrade({ id: 'o1', status: 'open', net_pnl: null, exit_time: null }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    expect(summary.winRate).toBe(0);
  });

  it('returns 0 for an empty trade list', () => {
    const summary = computePnlSummary([], TODAY_IST);
    expect(summary.winRate).toBe(0);
  });

  it('returns 1.0 when all closed trades are winners', () => {
    const trades: PaperTrade[] = [
      makeTrade({ id: 'c1', status: 'closed', net_pnl: '100.00' }),
      makeTrade({ id: 'c2', status: 'closed', net_pnl: '50.00' }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    expect(summary.winRate).toBe(1);
  });

  it('returns 0 when all closed trades are losers', () => {
    const trades: PaperTrade[] = [
      makeTrade({ id: 'c1', status: 'closed', net_pnl: '-50.00' }),
      makeTrade({ id: 'c2', status: 'closed', net_pnl: '-20.00' }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    expect(summary.winRate).toBe(0);
  });

  it('computes a fractional win rate correctly', () => {
    const trades: PaperTrade[] = [
      makeTrade({ id: 'c1', status: 'closed', net_pnl: '100.00' }), // win
      makeTrade({ id: 'c2', status: 'closed', net_pnl: '-50.00' }), // loss
      makeTrade({ id: 'c3', status: 'closed', net_pnl: '25.00' }), // win
      makeTrade({ id: 'c4', status: 'closed', net_pnl: '-10.00' }), // loss
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    // 2 wins / 4 closed = 0.5
    expect(summary.winRate).toBe(0.5);
  });

  it('treats exactly-zero net_pnl as neither win nor loss', () => {
    const trades: PaperTrade[] = [
      makeTrade({ id: 'c1', status: 'closed', net_pnl: '0.00' }),
      makeTrade({ id: 'c2', status: 'closed', net_pnl: '100.00' }), // win
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    // 1 winner out of 2 closed = 0.5
    expect(summary.winRate).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// 4. IST today-boundary selection
// ---------------------------------------------------------------------------

describe('computePnlSummary — IST today-boundary selection', () => {
  /**
   * IST midnight = UTC 18:30 the previous calendar day.
   * All instants are chosen to straddle that boundary to verify correctness.
   *
   * We inject TODAY_IST = '2026-05-20' as the "today" string and test trades
   * with exit_time that map to IST-today vs IST-yesterday.
   */

  it('includes a trade that exited during IST-today', () => {
    // 2026-05-20T09:15:00Z → IST 14:45 on 2026-05-20  (well within today)
    const trades: PaperTrade[] = [
      makeTrade({
        id: 'c1',
        status: 'closed',
        net_pnl: '120.00',
        exit_time: '2026-05-20T09:15:00.000Z',
      }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    expect(summary.todayRealizedPnl).toBe(120);
  });

  it('excludes a trade that exited IST-yesterday (UTC today)', () => {
    // 2026-05-19T18:29:59Z → IST 23:59:59 on 2026-05-19 (one second before IST midnight)
    // This is still IST 2026-05-19, NOT today.
    const trades: PaperTrade[] = [
      makeTrade({
        id: 'c1',
        status: 'closed',
        net_pnl: '200.00',
        exit_time: '2026-05-19T18:29:59.000Z',
      }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    expect(summary.todayRealizedPnl).toBe(0);
    // But the trade should still be counted in the total and closedCount
    expect(summary.totalRealizedPnl).toBe(200);
    expect(summary.closedCount).toBe(1);
  });

  it('includes a trade that exited exactly at IST midnight (first second of today)', () => {
    // 2026-05-19T18:30:00Z → IST 00:00:00 on 2026-05-20 (exactly IST midnight = start of today)
    const trades: PaperTrade[] = [
      makeTrade({
        id: 'c1',
        status: 'closed',
        net_pnl: '75.00',
        exit_time: '2026-05-19T18:30:00.000Z',
      }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    expect(summary.todayRealizedPnl).toBe(75);
  });

  it('includes a trade that exited at the last second of IST-today', () => {
    // IST end of day 2026-05-20: 2026-05-20T18:29:59.999Z → IST 23:59:59.999 on 2026-05-20
    const trades: PaperTrade[] = [
      makeTrade({
        id: 'c1',
        status: 'closed',
        net_pnl: '50.00',
        exit_time: '2026-05-20T18:29:59.999Z',
      }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    expect(summary.todayRealizedPnl).toBe(50);
  });

  it('excludes a trade that exited at the first second of IST-tomorrow', () => {
    // 2026-05-20T18:30:00Z → IST 00:00:00 on 2026-05-21 (first second of tomorrow)
    const trades: PaperTrade[] = [
      makeTrade({
        id: 'c1',
        status: 'closed',
        net_pnl: '99.00',
        exit_time: '2026-05-20T18:30:00.000Z',
      }),
    ];
    // TODAY_IST is still 2026-05-20; this trade is IST 2026-05-21 → excluded
    const summary = computePnlSummary(trades, TODAY_IST);
    expect(summary.todayRealizedPnl).toBe(0);
    // But it's in the total (it is closed)
    expect(summary.totalRealizedPnl).toBe(99);
  });

  it('sums only the today trades when mixing today and non-today closed trades', () => {
    const trades: PaperTrade[] = [
      // IST yesterday
      makeTrade({
        id: 'c1',
        status: 'closed',
        net_pnl: '300.00',
        exit_time: '2026-05-19T09:00:00.000Z', // IST 14:30 on 2026-05-19
      }),
      // IST today
      makeTrade({
        id: 'c2',
        status: 'closed',
        net_pnl: '80.00',
        exit_time: '2026-05-20T05:00:00.000Z', // IST 10:30 on 2026-05-20
      }),
      // IST today (negative)
      makeTrade({
        id: 'c3',
        status: 'closed',
        net_pnl: '-20.00',
        exit_time: '2026-05-20T07:00:00.000Z', // IST 12:30 on 2026-05-20
      }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    // Only c2 and c3 are today: 80 - 20 = 60
    expect(summary.todayRealizedPnl).toBeCloseTo(60, 5);
    // Total includes all three: 300 + 80 - 20 = 360
    expect(summary.totalRealizedPnl).toBeCloseTo(360, 5);
  });
});

// ---------------------------------------------------------------------------
// 5. Cumulative series — ordering and null exclusion
// ---------------------------------------------------------------------------

describe('computePnlSummary — cumulative series', () => {
  it('returns an empty series when there are no closed trades', () => {
    const summary = computePnlSummary([], TODAY_IST);
    expect(summary.cumulativeSeries).toEqual([]);
  });

  it('returns a single-point series for one closed trade', () => {
    const trades: PaperTrade[] = [
      makeTrade({
        id: 'c1',
        status: 'closed',
        net_pnl: '100.00',
        exit_time: '2026-05-20T09:15:00.000Z',
      }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    expect(summary.cumulativeSeries).toHaveLength(1);
    expect(summary.cumulativeSeries[0]?.value).toBe(100);
    // time should be the IST date string
    expect(summary.cumulativeSeries[0]?.time).toBe('2026-05-20');
  });

  it('orders the series by exit_time ascending (not insertion order)', () => {
    // Insert in reverse order to prove sorting is applied.
    const trades: PaperTrade[] = [
      makeTrade({
        id: 'c2',
        status: 'closed',
        net_pnl: '50.00',
        exit_time: '2026-05-20T11:00:00.000Z',
      }),
      makeTrade({
        id: 'c1',
        status: 'closed',
        net_pnl: '100.00',
        exit_time: '2026-05-20T09:00:00.000Z',
      }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    // c1 exits at 09:00, c2 at 11:00 — series must be c1 first.
    expect(summary.cumulativeSeries).toHaveLength(2);
    // First point: just c1's P&L = 100
    expect(summary.cumulativeSeries[0]?.value).toBeCloseTo(100, 5);
    // Second point: c1 + c2 = 150
    expect(summary.cumulativeSeries[1]?.value).toBeCloseTo(150, 5);
  });

  it('excludes trades with null net_pnl from the series', () => {
    const trades: PaperTrade[] = [
      makeTrade({
        id: 'c1',
        status: 'closed',
        net_pnl: '100.00',
        exit_time: '2026-05-20T09:00:00.000Z',
      }),
      makeTrade({
        id: 'c2',
        status: 'closed',
        net_pnl: null,
        exit_time: '2026-05-20T10:00:00.000Z',
      }),
      makeTrade({
        id: 'c3',
        status: 'closed',
        net_pnl: '50.00',
        exit_time: '2026-05-20T11:00:00.000Z',
      }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    // c2 has null net_pnl — excluded from the series entirely (not plotted as 0).
    expect(summary.cumulativeSeries).toHaveLength(2);
    expect(summary.cumulativeSeries[0]?.value).toBeCloseTo(100, 5);
    expect(summary.cumulativeSeries[1]?.value).toBeCloseTo(150, 5);
  });

  it('excludes trades with null exit_time from the series', () => {
    // A closed trade with null exit_time is a data integrity anomaly; skip it.
    const trades: PaperTrade[] = [
      makeTrade({
        id: 'c1',
        status: 'closed',
        net_pnl: '100.00',
        exit_time: '2026-05-20T09:00:00.000Z',
      }),
      makeTrade({ id: 'c2', status: 'closed', net_pnl: '200.00', exit_time: null }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    expect(summary.cumulativeSeries).toHaveLength(1);
    expect(summary.cumulativeSeries[0]?.value).toBeCloseTo(100, 5);
  });

  it('builds the running sum correctly across multiple trades', () => {
    const trades: PaperTrade[] = [
      makeTrade({
        id: 'c1',
        status: 'closed',
        net_pnl: '100.00',
        exit_time: '2026-05-18T09:00:00.000Z',
      }),
      makeTrade({
        id: 'c2',
        status: 'closed',
        net_pnl: '-40.00',
        exit_time: '2026-05-19T09:00:00.000Z',
      }),
      makeTrade({
        id: 'c3',
        status: 'closed',
        net_pnl: '60.00',
        exit_time: '2026-05-20T09:00:00.000Z',
      }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    expect(summary.cumulativeSeries).toHaveLength(3);
    expect(summary.cumulativeSeries[0]?.value).toBeCloseTo(100, 5); // 100
    expect(summary.cumulativeSeries[1]?.value).toBeCloseTo(60, 5); // 100 - 40
    expect(summary.cumulativeSeries[2]?.value).toBeCloseTo(120, 5); // 100 - 40 + 60
  });

  it('uses the IST date (not UTC date) for the series time field', () => {
    // 2026-05-19T18:35:00Z → IST 00:05:00 on 2026-05-20
    // The UTC date is still 2026-05-19, but the IST date should be 2026-05-20.
    const trades: PaperTrade[] = [
      makeTrade({
        id: 'c1',
        status: 'closed',
        net_pnl: '75.00',
        exit_time: '2026-05-19T18:35:00.000Z',
      }),
    ];
    const summary = computePnlSummary(trades, TODAY_IST);
    expect(summary.cumulativeSeries).toHaveLength(1);
    // Must be the IST date 2026-05-20, not the UTC date 2026-05-19.
    expect(summary.cumulativeSeries[0]?.time).toBe('2026-05-20');
  });
});
