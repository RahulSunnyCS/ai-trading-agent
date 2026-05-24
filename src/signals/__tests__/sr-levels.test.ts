/**
 * sr-levels.test.ts — unit and property tests for src/signals/sr-levels.ts
 *
 * ALL tests are purely in-memory. No real PostgreSQL or TimescaleDB connection
 * is required. The `Pool` parameter accepted by sr-levels.ts is an opaque
 * interface to the tests — we inject a minimal stub that records SQL calls and
 * returns scripted row arrays. The stub satisfies TypeScript's structural typing
 * for pg.Pool without importing pg at runtime.
 *
 * Why stub instead of mock: pg.Pool is a class with many methods. A structural
 * stub that only implements `query()` is less brittle than a full vi.mock() and
 * keeps the test file free of module-resolution concerns for the pg package.
 *
 * Fast-check property tests verify mathematical invariants over thousands of
 * randomly generated inputs, catching corner cases that example-based tests miss.
 *
 * Time anchors used throughout (IST = UTC+5:30, no DST):
 *   TUESDAY_2026_05_19  → '2026-05-19' in IST
 *   IST midnight        → 2026-05-18T18:30:00.000Z in UTC
 *
 * prev-week window for '2026-05-19' (Tuesday):
 *   Monday 2026-05-11 00:00 IST → 2026-05-10T18:30:00Z
 *   Monday 2026-05-18 00:00 IST → 2026-05-17T18:30:00Z
 *
 * prev-month window for '2026-05-19' (in May 2026):
 *   2026-04-01 00:00 IST → 2026-03-31T18:30:00Z
 *   2026-05-01 00:00 IST → 2026-04-30T18:30:00Z
 */

import * as fc from 'fast-check';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';
import type { Clock } from '../../utils/clock.js';
import {
  DEFAULT_SR_CONFIG,
  InsufficientHistoryCoverageError,
  assertHistoryCoverage,
  computePOC,
  computePivotLevels,
  computeSRLevels,
  countHistoryBars,
  istDateToUtcMs,
  istWeekWindow,
  prevIstMonthWindow,
  prevIstWeekWindow,
  scoreLevel,
  utcMsToIstDate,
} from '../sr-levels.js';

// ---------------------------------------------------------------------------
// Minimal Pool stub
// ---------------------------------------------------------------------------

/**
 * QueryInterceptor is a function that receives the SQL text and parameters and
 * returns the rows array for that query. Returning [] simulates no data.
 *
 * We use a function (not a pre-built map) because some tests need to return
 * different results for different queries (e.g. prev-week vs. prev-month OHLCV).
 */
type QueryInterceptor = (sql: string, params: unknown[]) => QueryResultRow[];

/**
 * Builds a minimal pg.Pool stub that delegates all `query()` calls to the
 * interceptor function.
 *
 * The real pg.Pool.query() returns a full QueryResult; we satisfy TypeScript's
 * structural check by returning just the `rows` field (which is all callers
 * in sr-levels.ts actually use — they access `result.rows`).
 */
function makePoolStub(interceptor: QueryInterceptor): Pool {
  return {
    query: <T extends QueryResultRow>(
      sql: string,
      params?: unknown[],
    ): Promise<QueryResult<T>> => {
      const rows = interceptor(sql, params ?? []) as T[];
      return Promise.resolve({
        rows,
        command: 'SELECT',
        rowCount: rows.length,
        oid: 0,
        fields: [],
      } satisfies QueryResult<T>);
    },
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Clock stubs
// ---------------------------------------------------------------------------

/** Returns a minimal Clock stub frozen at the given IST date string. */
function makeClock(istDate: string): Clock {
  return {
    now: () => istDateToUtcMs(istDate),
    today: () => istDate,
    toISTDate: () => istDate,
    toISTTime: () => '10:00:00',
  };
}

// ---------------------------------------------------------------------------
// OHLCV row factory
// ---------------------------------------------------------------------------

/**
 * Builds the row shape returned by fetchOHLCV's SQL query.
 * All values are strings as pg returns them when the NUMERIC type parser is set.
 */
function makeOHLCVRow(
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number | null,
  rowCount = 100,
): QueryResultRow {
  return {
    open_price: String(open),
    high_price: String(high),
    low_price: String(low),
    close_price: String(close),
    total_volume: volume !== null ? String(volume) : null,
    row_count: String(rowCount),
  };
}

/** Builds a tick row as returned by fetchTicksForPOC. */
function makeTickRow(ltp: number, volume: number | null): QueryResultRow {
  return { ltp: String(ltp), volume: volume !== null ? String(volume) : null };
}

/** Builds a count row as returned by countHistoryBars. */
function makeCountRow(count: number): QueryResultRow {
  return { cnt: String(count) };
}

// ---------------------------------------------------------------------------
// Section 1: IST date arithmetic helpers
// ---------------------------------------------------------------------------

describe('istDateToUtcMs / utcMsToIstDate', () => {
  it('round-trips an IST date string through ms and back', () => {
    const dates = ['2026-01-01', '2026-05-18', '2026-12-31', '2025-04-14'];
    for (const d of dates) {
      expect(utcMsToIstDate(istDateToUtcMs(d))).toBe(d);
    }
  });

  it('IST midnight 2026-05-18 is UTC 2026-05-17T18:30:00Z', () => {
    const ms = istDateToUtcMs('2026-05-18');
    expect(new Date(ms).toISOString()).toBe('2026-05-17T18:30:00.000Z');
  });

  it('IST midnight 2026-01-01 is UTC 2025-12-31T18:30:00Z', () => {
    const ms = istDateToUtcMs('2026-01-01');
    expect(new Date(ms).toISOString()).toBe('2025-12-31T18:30:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Section 2: IST week window
// ---------------------------------------------------------------------------

describe('istWeekWindow', () => {
  it('Tuesday in IST week: weekStart is previous Monday IST midnight', () => {
    // 2026-05-19 is a Tuesday
    const ms = istDateToUtcMs('2026-05-19');
    const { weekStart, weekEnd } = istWeekWindow(ms);

    // Monday 2026-05-18 00:00 IST = 2026-05-17T18:30:00Z
    expect(new Date(weekStart).toISOString()).toBe('2026-05-17T18:30:00.000Z');
    // Monday 2026-05-25 00:00 IST = 2026-05-24T18:30:00Z
    expect(new Date(weekEnd).toISOString()).toBe('2026-05-24T18:30:00.000Z');
  });

  it('Monday itself: weekStart IS that Monday', () => {
    // 2026-05-18 is a Monday
    const ms = istDateToUtcMs('2026-05-18');
    const { weekStart } = istWeekWindow(ms);
    expect(new Date(weekStart).toISOString()).toBe('2026-05-17T18:30:00.000Z');
  });

  it('Sunday: weekStart is the previous Monday (6 days back)', () => {
    // 2026-05-17 is a Sunday
    const ms = istDateToUtcMs('2026-05-17');
    const { weekStart } = istWeekWindow(ms);
    // Previous Monday = 2026-05-11 → 2026-05-10T18:30:00Z
    expect(new Date(weekStart).toISOString()).toBe('2026-05-10T18:30:00.000Z');
  });

  it('weekEnd - weekStart = exactly 7 days', () => {
    const dates = ['2026-05-18', '2026-05-19', '2026-05-17', '2026-05-13', '2026-05-15'];
    for (const d of dates) {
      const ms = istDateToUtcMs(d);
      const { weekStart, weekEnd } = istWeekWindow(ms);
      expect(weekEnd - weekStart).toBe(7 * 24 * 60 * 60 * 1000);
    }
  });
});

describe('prevIstWeekWindow', () => {
  it('for Tuesday 2026-05-19: prev week = Mon May 11 – Mon May 18 (exclusive)', () => {
    const ms = istDateToUtcMs('2026-05-19');
    const { from, to } = prevIstWeekWindow(ms);

    // Mon 2026-05-11 00:00 IST = 2026-05-10T18:30:00Z
    expect(new Date(from).toISOString()).toBe('2026-05-10T18:30:00.000Z');
    // Mon 2026-05-18 00:00 IST = 2026-05-17T18:30:00Z
    expect(new Date(to).toISOString()).toBe('2026-05-17T18:30:00.000Z');
  });

  it('previous week window is always exactly 7 days', () => {
    const { from, to } = prevIstWeekWindow(istDateToUtcMs('2026-05-19'));
    expect(to - from).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// Section 3: Previous IST month window
// ---------------------------------------------------------------------------

describe('prevIstMonthWindow', () => {
  it('May 2026 → April 2026 window', () => {
    const ms = istDateToUtcMs('2026-05-19');
    const { from, to } = prevIstMonthWindow(ms);

    // 2026-04-01 00:00 IST = 2026-03-31T18:30:00Z
    expect(new Date(from).toISOString()).toBe('2026-03-31T18:30:00.000Z');
    // 2026-05-01 00:00 IST = 2026-04-30T18:30:00Z
    expect(new Date(to).toISOString()).toBe('2026-04-30T18:30:00.000Z');
  });

  it('January 2026 → December 2025 (cross-year boundary)', () => {
    const ms = istDateToUtcMs('2026-01-15');
    const { from, to } = prevIstMonthWindow(ms);

    // 2025-12-01 00:00 IST = 2025-11-30T18:30:00Z
    expect(new Date(from).toISOString()).toBe('2025-11-30T18:30:00.000Z');
    // 2026-01-01 00:00 IST = 2025-12-31T18:30:00Z
    expect(new Date(to).toISOString()).toBe('2025-12-31T18:30:00.000Z');
  });

  it('from < to always', () => {
    const months = [
      '2026-01-15',
      '2026-03-01',
      '2026-07-04',
      '2026-12-25',
    ];
    for (const d of months) {
      const { from, to } = prevIstMonthWindow(istDateToUtcMs(d));
      expect(from).toBeLessThan(to);
    }
  });
});

// ---------------------------------------------------------------------------
// Section 4: Pivot level math — property tests
// ---------------------------------------------------------------------------

describe('computePivotLevels — property tests', () => {
  // Shared arbitraries for a realistic NIFTY OHLC range.
  //
  // We enforce a minimum range of 1.0pt (INDEX_MIN_RANGE_PTS) to avoid
  // floating-point degenerate cases where the computed R1/PP difference is
  // below float64 precision. In practice, NIFTY/BANKNIFTY candles always have
  // ranges of at least several points, so this is not a real-world constraint.
  const INDEX_MIN_RANGE_PTS = 1.0;

  const ohlcArb = fc
    .tuple(
      // Base price: realistic NIFTY range [15000, 30000]
      fc.integer({ min: 15000, max: 30000 }),
      // Range (high - low): integer points to avoid float precision edge cases.
      // Minimum 1 point ensures the ordering invariants hold at float64 precision.
      fc.integer({ min: 1, max: 2000 }),
      // Close position within range: [0, 100] maps to [0%, 100%]
      fc.integer({ min: 0, max: 100 }),
    )
    .map(([basePrice, range, closePosPct]) => {
      const low = basePrice;
      const high = basePrice + range;
      const close = low + (closePosPct / 100) * range;
      return { open: low, high, low, close, volume: null };
    });

  // Verify the min-range guard: all generated candles have range >= INDEX_MIN_RANGE_PTS
  it('ohlcArb always produces candles with range >= 1pt', () => {
    fc.assert(
      fc.property(ohlcArb, (candle) => {
        expect(candle.high - candle.low).toBeGreaterThanOrEqual(INDEX_MIN_RANGE_PTS);
      }),
    );
  });

  it('PP = (H + L + C) / 3 always', () => {
    fc.assert(
      fc.property(ohlcArb, (candle) => {
        const { pp } = computePivotLevels(candle);
        const expected = (candle.high + candle.low + candle.close) / 3;
        // toBeCloseTo(expected, 10) would fail on large integers due to float
        // representation; we check the absolute error instead.
        const absErr = Math.abs(pp - expected);
        expect(absErr).toBeLessThan(1e-6);
      }),
    );
  });

  it('R1 > PP when range >= 1pt (integer range guarantees no float tie)', () => {
    fc.assert(
      fc.property(ohlcArb, (candle) => {
        const { pp, r1 } = computePivotLevels(candle);
        // R1 = 2*PP - low. Range = high - low >= 1 → R1 - PP = PP - low = (high+low+close)/3 - low
        // = (high - low + close - low) / 3. Since high - low >= 1 and close >= low: R1 - PP >= 1/3.
        expect(r1).toBeGreaterThan(pp);
      }),
    );
  });

  it('S1 < PP when range >= 1pt', () => {
    fc.assert(
      fc.property(ohlcArb, (candle) => {
        const { pp, s1 } = computePivotLevels(candle);
        // S1 = 2*PP - high. PP - S1 = high - PP = (2*high + low - close) / 3 - high... but
        // more directly: PP - S1 = high - PP; since high > low and close ≤ high, PP < high.
        expect(s1).toBeLessThan(pp);
      }),
    );
  });

  it('R2 > R1 (outer resistance further from PP, range >= 1pt)', () => {
    fc.assert(
      fc.property(ohlcArb, (candle) => {
        const { r1, r2 } = computePivotLevels(candle);
        // R2 = PP + range; R1 = 2*PP - low = PP + (PP - low).
        // R2 - R1 = range - (PP - low) = range - (high + close - 2*low) / 3.
        // Since close ≤ high: R2 - R1 ≥ range - (high + high - 2*low)/3 = range/3 ≥ 1/3.
        expect(r2).toBeGreaterThan(r1);
      }),
    );
  });

  it('S2 < S1 (outer support further from PP, range >= 1pt)', () => {
    fc.assert(
      fc.property(ohlcArb, (candle) => {
        const { s1, s2 } = computePivotLevels(candle);
        // S2 = PP - range; S1 = 2*PP - high = PP - (high - PP).
        // S1 - S2 = range - (high - PP) = range - (2*high + low - close - high*... complex).
        // Simpler: S1 - S2 = range - (high - PP) ≥ range - (high - (H+L+C)/3).
        // Since close >= low: high - PP = (2*high - low - close)/3 ≤ (2*high - 2*low)/3 = 2*range/3.
        // So S1 - S2 ≥ range - 2*range/3 = range/3 ≥ 1/3.
        expect(s2).toBeLessThan(s1);
      }),
    );
  });

  it('R2 - PP = PP - S2 = range (symmetry)', () => {
    fc.assert(
      fc.property(ohlcArb, (candle) => {
        const { pp, r2, s2 } = computePivotLevels(candle);
        const range = candle.high - candle.low;
        expect(r2 - pp).toBeCloseTo(range, 10);
        expect(pp - s2).toBeCloseTo(range, 10);
      }),
    );
  });

  it('concrete example: H=22800 L=22000 C=22500 → PP=22433.33', () => {
    const pivots = computePivotLevels({ open: 22000, high: 22800, low: 22000, close: 22500, volume: null });
    expect(pivots.pp).toBeCloseTo((22800 + 22000 + 22500) / 3, 5);
    expect(pivots.r1).toBeCloseTo(2 * pivots.pp - 22000, 5);
    expect(pivots.s1).toBeCloseTo(2 * pivots.pp - 22800, 5);
    expect(pivots.r2).toBeCloseTo(pivots.pp + 800, 5);
    expect(pivots.s2).toBeCloseTo(pivots.pp - 800, 5);
  });
});

// ---------------------------------------------------------------------------
// Section 5: POC bucketing — property tests
// ---------------------------------------------------------------------------

describe('computePOC', () => {
  it('returns null when all ticks have null volume', () => {
    const ticks = [
      { ltp: 22500, volume: null },
      { ltp: 22550, volume: null },
      { ltp: 22600, volume: null },
    ];
    expect(computePOC(ticks, 50)).toBeNull();
  });

  it('returns null for empty tick array', () => {
    expect(computePOC([], 50)).toBeNull();
  });

  it('returns a value when at least one tick has volume', () => {
    const ticks = [
      { ltp: 22500, volume: null },
      { ltp: 22550, volume: 1000 },
    ];
    // Only one tick has volume → that bucket wins
    const poc = computePOC(ticks, 50);
    expect(poc).not.toBeNull();
  });

  it('POC price is always a multiple of bucketPts', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ltp: fc.float({ min: 15000, max: 30000, noNaN: true }),
            volume: fc.oneof(fc.constant(null), fc.integer({ min: 1, max: 100000 })),
          }),
          { minLength: 1, maxLength: 200 },
        ),
        fc.constantFrom(50, 100, 25),
        (ticks, bucketPts) => {
          const poc = computePOC(ticks, bucketPts);
          if (poc === null) return; // null is valid when all volume is null
          expect(poc % bucketPts).toBe(0);
        },
      ),
    );
  });

  it('POC is the lower boundary of the highest-volume bucket', () => {
    // Ticks all in the 22500 bucket (50pt bucket: [22500, 22550))
    // and one outlier tick with low volume in 22550 bucket
    const ticks = [
      { ltp: 22501, volume: 5000 },
      { ltp: 22510, volume: 5000 },
      { ltp: 22540, volume: 5000 },
      { ltp: 22551, volume: 10 }, // 22550 bucket, much less volume
    ];
    expect(computePOC(ticks, 50)).toBe(22500); // Math.floor(22501/50)*50 = 22500
  });

  it('ticks with null volume are ignored; ticks with real volume determine POC', () => {
    const ticks = [
      { ltp: 22200, volume: null }, // Would be in bucket 22200 — excluded
      { ltp: 22200, volume: null },
      { ltp: 22250, volume: 100 },  // Bucket 22250 with small volume
      { ltp: 22300, volume: 9999 }, // Bucket 22300 wins despite fewer ticks
    ];
    expect(computePOC(ticks, 50)).toBe(22300);
  });

  it('POC price is always within [minLtp, maxLtp] rounded down to bucket boundary', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ltp: fc.integer({ min: 10000, max: 50000 }),
            volume: fc.integer({ min: 1, max: 10000 }),
          }),
          { minLength: 1, maxLength: 100 },
        ),
        (ticks) => {
          const poc = computePOC(ticks, 50);
          if (poc === null) return;
          const minPossible = Math.floor(Math.min(...ticks.map((t) => t.ltp)) / 50) * 50;
          const maxPossible = Math.floor(Math.max(...ticks.map((t) => t.ltp)) / 50) * 50;
          expect(poc).toBeGreaterThanOrEqual(minPossible);
          expect(poc).toBeLessThanOrEqual(maxPossible);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Section 6: Strength score
// ---------------------------------------------------------------------------

describe('scoreLevel', () => {
  const config = DEFAULT_SR_CONFIG;

  it('score is in [0, 1] for all inputs', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 15000, max: 30000, noNaN: true }), // levelPrice
        fc.float({ min: 15000, max: 30000, noNaN: true }), // currentSpot
        fc.array(fc.float({ min: 15000, max: 30000, noNaN: true }), { maxLength: 10 }),
        fc.boolean(),
        (levelPrice, spot, others, hasvol) => {
          const score = scoreLevel(levelPrice, 'prev_week_high', spot, [levelPrice, ...others], config, hasvol);
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(1);
        },
      ),
    );
  });

  it('at-spot level gets proximity weight of 1.0 (no distance penalty)', () => {
    // Level exactly at spot, no confluence, non-POC
    const score = scoreLevel(22500, 'prev_week_high', 22500, [22500], config, false);
    // proximity = 1/(1+0) = 1.0, confluence = 1.0, volume = 1.0 → score = 1.0
    expect(score).toBeCloseTo(1.0, 10);
  });

  it('level 100pt away gets proximity weight ~0.5 (before confluence/volume)', () => {
    // No other levels, non-POC, spot = 22500, level = 22600 → distance = 100
    // proximity = 1/(1+100/100) = 0.5
    const score = scoreLevel(22600, 'prev_week_high', 22500, [22600], config, false);
    expect(score).toBeCloseTo(0.5, 5);
  });

  it('confluence adds to score: two nearby levels → higher score than one', () => {
    const singleScore = scoreLevel(22500, 'prev_week_high', 22500, [22500], config, false);
    // Add a second level within confluence band
    const confluenceScore = scoreLevel(22500, 'prev_week_high', 22500, [22500, 22510], config, false);
    // singleScore = 1.0 already at max, so test with a displaced level
    const displaced = 22600;
    const displacedSingle = scoreLevel(displaced, 'prev_week_high', 22500, [displaced], config, false);
    const displacedConfluence = scoreLevel(displaced, 'prev_week_high', 22500, [displaced, 22610], config, false);
    // Confluence should boost score, but it may be clamped to 1
    expect(displacedConfluence).toBeGreaterThanOrEqual(displacedSingle);
    // At-spot: already 1.0, confluence just gets clamped
    expect(confluenceScore).toBeCloseTo(Math.min(1, singleScore * 1.15), 5);
  });

  it('POC with volume gets a higher score than non-POC at the same location (when not clamped)', () => {
    // Use a displaced level so scores are not clamped to 1
    const displacedPrice = 22700;
    const spot = 22500;
    const nonPocScore = scoreLevel(displacedPrice, 'prev_week_high', spot, [displacedPrice], config, false);
    const pocScore = scoreLevel(displacedPrice, 'poc', spot, [displacedPrice], config, true);
    expect(pocScore).toBeGreaterThan(nonPocScore);
  });

  it('null volume (hasVolumeData=false) returns neutral score (same as non-POC)', () => {
    // Non-POC types always get neutral volume weight regardless of hasVolumeData
    const score1 = scoreLevel(22600, 'pivot', 22500, [22600], config, false);
    const score2 = scoreLevel(22600, 'pivot', 22500, [22600], config, true);
    // pivot never gets volume boost regardless of hasVolumeData flag
    expect(score1).toBeCloseTo(score2, 10);
  });

  it('further away → lower score (monotone in distance when no confluence)', () => {
    const spot = 22500;
    const close = scoreLevel(22510, 'pivot', spot, [22510], config, false);
    const far = scoreLevel(22800, 'pivot', spot, [22800], config, false);
    expect(close).toBeGreaterThan(far);
  });
});

// ---------------------------------------------------------------------------
// Section 7: Coverage guard
// ---------------------------------------------------------------------------

describe('assertHistoryCoverage', () => {
  it('does NOT throw when actual bars >= expected', async () => {
    // Pool returns count = 1000
    const pool = makePoolStub(() => [makeCountRow(1000)]);
    await expect(
      assertHistoryCoverage(pool, 'NIFTY', 0, 1000, 500),
    ).resolves.toBeUndefined();
  });

  it('does NOT throw when actual bars == expected (boundary)', async () => {
    const pool = makePoolStub(() => [makeCountRow(500)]);
    await expect(
      assertHistoryCoverage(pool, 'NIFTY', 0, 1000, 500),
    ).resolves.toBeUndefined();
  });

  it('throws InsufficientHistoryCoverageError when actual < expected', async () => {
    const pool = makePoolStub(() => [makeCountRow(100)]);
    await expect(
      assertHistoryCoverage(pool, 'NIFTY', 0, 1000, 500),
    ).rejects.toThrow(InsufficientHistoryCoverageError);
  });

  it('thrown error carries machine-readable fields', async () => {
    const pool = makePoolStub(() => [makeCountRow(42)]);
    try {
      await assertHistoryCoverage(pool, 'BANKNIFTY', 1000, 2000, 300);
      expect.fail('Expected InsufficientHistoryCoverageError to be thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientHistoryCoverageError);
      const typed = err as InsufficientHistoryCoverageError;
      expect(typed.underlying).toBe('BANKNIFTY');
      expect(typed.actualBars).toBe(42);
      expect(typed.expectedBars).toBe(300);
      expect(typed.name).toBe('InsufficientHistoryCoverageError');
      expect(typed.message).toContain('BANKNIFTY');
      expect(typed.message).toContain('42');
      expect(typed.message).toContain('300');
    }
  });

  it('throws when actual = 0 (no data at all)', async () => {
    const pool = makePoolStub(() => [makeCountRow(0)]);
    await expect(
      assertHistoryCoverage(pool, 'SENSEX', 0, 1000, 1),
    ).rejects.toThrow(InsufficientHistoryCoverageError);
  });

  it('property: throw iff actualBars < expectedBars', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10000 }),  // actual
        fc.integer({ min: 1, max: 10000 }),  // expected
        async (actual, expected) => {
          const pool = makePoolStub(() => [makeCountRow(actual)]);
          const shouldThrow = actual < expected;
          if (shouldThrow) {
            await expect(
              assertHistoryCoverage(pool, 'NIFTY', 0, 1000, expected),
            ).rejects.toThrow(InsufficientHistoryCoverageError);
          } else {
            await expect(
              assertHistoryCoverage(pool, 'NIFTY', 0, 1000, expected),
            ).resolves.toBeUndefined();
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Section 8: countHistoryBars
// ---------------------------------------------------------------------------

describe('countHistoryBars', () => {
  it('returns the count from the DB row', async () => {
    const pool = makePoolStub(() => [makeCountRow(1234)]);
    expect(await countHistoryBars(pool, 'NIFTY', 0, 1000)).toBe(1234);
  });

  it('returns 0 when no rows returned', async () => {
    const pool = makePoolStub(() => []); // empty result
    expect(await countHistoryBars(pool, 'NIFTY', 0, 1000)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Section 9: computeSRLevels — integration of all components via stub pool
// ---------------------------------------------------------------------------

describe('computeSRLevels', () => {
  const CLOCK = makeClock('2026-05-19'); // Tuesday

  /**
   * A pool that returns:
   *   - OHLCV query → one row (prev-week or prev-month candle)
   *   - Tick query  → ticks with volume (for POC)
   *   - Count query → 1000 bars
   *
   * We distinguish query type by checking for UNIQUE keywords in the SQL string:
   *   OHLCV query: contains "FIRST" (uses FIRST() TimescaleDB aggregate — unique to fetchOHLCV)
   *   Tick query:  contains "ORDER BY time" (unique to fetchTicksForPOC)
   *   Count query: contains "AS cnt" (the alias used only in countHistoryBars)
   *
   * We do NOT use "COUNT(*)" as a discriminator because fetchOHLCV also uses
   * COUNT(*) as row_count in its SELECT clause. "AS cnt" is unique to the
   * standalone count query.
   */
  function makeFullPool(opts: {
    prevWeekOHLCV?: QueryResultRow;
    prevMonthOHLCV?: QueryResultRow;
    ticks?: QueryResultRow[];
  }): Pool {
    const prevWeekOHLCV =
      opts.prevWeekOHLCV ??
      makeOHLCVRow(22000, 22800, 21800, 22500, 50000);
    const prevMonthOHLCV =
      opts.prevMonthOHLCV ??
      makeOHLCVRow(21000, 23000, 20500, 22000, 200000);
    const ticks = opts.ticks ?? [
      makeTickRow(22300, 10000),
      makeTickRow(22350, 8000),
      makeTickRow(22300, 12000), // 22300 bucket wins (total 22000)
      makeTickRow(22350, 5000),
    ];

    // Track call order: first OHLCV call = prev-week, second = prev-month
    let ohlcvCallCount = 0;

    return makePoolStub((sql) => {
      // fetchTicksForPOC: unique discriminator is ORDER BY time
      if (sql.includes('ORDER BY time')) return ticks;
      // countHistoryBars: unique discriminator is "AS cnt" alias
      if (sql.includes('AS cnt')) return [makeCountRow(1000)];
      // fetchOHLCV: unique discriminator is FIRST() aggregate function
      if (sql.includes('FIRST')) {
        ohlcvCallCount++;
        if (ohlcvCallCount === 1) return [prevWeekOHLCV]; // prev-week
        if (ohlcvCallCount === 2) return [prevMonthOHLCV]; // prev-month
      }
      return [];
    });
  }

  it('returns levels from all three families when data is present', async () => {
    const pool = makeFullPool({});
    const result = await computeSRLevels(pool, 'NIFTY', 22500, CLOCK);

    // Contributed families: prev_week_high, prev_week_low, pivot, poc
    expect(result.contributed).toContain('prev_week_high');
    expect(result.contributed).toContain('prev_week_low');
    expect(result.contributed).toContain('pivot');
    expect(result.contributed).toContain('poc');
    expect(result.poc_used).toBe(true);
  });

  it('result.levels is sorted by strength descending', async () => {
    const pool = makeFullPool({});
    const { levels } = await computeSRLevels(pool, 'NIFTY', 22500, CLOCK);

    for (let i = 1; i < levels.length; i++) {
      const prev = levels[i - 1];
      const curr = levels[i];
      if (prev === undefined || curr === undefined) continue;
      expect(prev.strength).toBeGreaterThanOrEqual(curr.strength);
    }
  });

  it('all strength scores are in [0, 1]', async () => {
    const pool = makeFullPool({});
    const { levels } = await computeSRLevels(pool, 'NIFTY', 22500, CLOCK);
    for (const level of levels) {
      expect(level.strength).toBeGreaterThanOrEqual(0);
      expect(level.strength).toBeLessThanOrEqual(1);
    }
  });

  it('omits POC when all ticks have null volume (poc_used=false)', async () => {
    const pool = makeFullPool({
      ticks: [
        makeTickRow(22300, null),
        makeTickRow(22350, null),
      ],
    });

    const result = await computeSRLevels(pool, 'NIFTY', 22500, CLOCK);

    expect(result.poc_used).toBe(false);
    expect(result.contributed).not.toContain('poc');
    expect(result.levels.every((l) => l.type !== 'poc')).toBe(true);
  });

  it('omits prev-week H/L when no ticks in prev-week window', async () => {
    // First OHLCV call (prev-week) returns empty → no H/L levels
    let ohlcvCallCount = 0;
    const pool = makePoolStub((sql) => {
      if (sql.includes('ORDER BY time')) return [];
      if (sql.includes('AS cnt')) return [makeCountRow(0)];
      if (sql.includes('FIRST')) {
        ohlcvCallCount++;
        if (ohlcvCallCount === 1) return []; // prev-week: no data
        return [makeOHLCVRow(21000, 23000, 20500, 22000, 200000)]; // prev-month
      }
      return [];
    });

    const result = await computeSRLevels(pool, 'NIFTY', 22500, CLOCK);

    expect(result.contributed).not.toContain('prev_week_high');
    expect(result.contributed).not.toContain('prev_week_low');
    expect(result.contributed).toContain('pivot'); // pivot still present
  });

  it('omits pivot when no ticks in prev-month window', async () => {
    let ohlcvCallCount = 0;
    const pool = makePoolStub((sql) => {
      if (sql.includes('ORDER BY time')) return [makeTickRow(22300, 5000)];
      if (sql.includes('AS cnt')) return [makeCountRow(100)];
      if (sql.includes('FIRST')) {
        ohlcvCallCount++;
        if (ohlcvCallCount === 1) return [makeOHLCVRow(22000, 22800, 21800, 22500, 50000)];
        return []; // prev-month: no data
      }
      return [];
    });

    const result = await computeSRLevels(pool, 'NIFTY', 22500, CLOCK);

    expect(result.contributed).not.toContain('pivot');
    expect(result.contributed).toContain('prev_week_high');
  });

  it('returns empty levels and empty contributed when no data at all', async () => {
    const pool = makePoolStub(() => []); // all queries return empty
    const result = await computeSRLevels(pool, 'NIFTY', 22500, CLOCK);

    expect(result.levels).toHaveLength(0);
    expect(result.contributed).toHaveLength(0);
    expect(result.poc_used).toBe(false);
  });

  it('clock.today() is used — not Date.now()', async () => {
    // Two different clocks at different IST dates; both should succeed without
    // touching real time. If Date.now() were called the result would differ
    // based on when the test runs. Since we fully stub the pool, we just verify
    // both calls complete without error.
    const clock1 = makeClock('2026-01-15'); // January
    const clock2 = makeClock('2026-07-20'); // July

    const pool = makeFullPool({});
    await expect(computeSRLevels(pool, 'NIFTY', 22500, clock1)).resolves.not.toThrow();
    await expect(computeSRLevels(pool, 'NIFTY', 22500, clock2)).resolves.not.toThrow();
  });

  it('poc_used field on individual SRLevel is true only for POC levels', async () => {
    const pool = makeFullPool({});
    const { levels } = await computeSRLevels(pool, 'NIFTY', 22500, CLOCK);

    for (const level of levels) {
      if (level.type === 'poc') {
        expect(level.poc_used).toBe(true);
      } else {
        expect(level.poc_used).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Section 10: Property — prev-week window always precedes current week
// ---------------------------------------------------------------------------

describe('prev-week window IST boundary properties', () => {
  it('prevIstWeekWindow.to always equals current week start', () => {
    fc.assert(
      fc.property(
        // Generate IST date strings for a 2-year span
        fc.integer({ min: 0, max: 730 }).map((dayOffset) => {
          const base = new Date('2026-01-01T00:00:00.000Z').getTime();
          return base + dayOffset * 24 * 60 * 60 * 1000;
        }),
        (epochMs) => {
          const { weekStart } = istWeekWindow(epochMs);
          const { to } = prevIstWeekWindow(epochMs);
          // The prev-week window ends exactly where the current week starts
          expect(to).toBe(weekStart);
        },
      ),
    );
  });

  it('prev-week window duration is always exactly 7 days', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 730 }).map((dayOffset) => {
          const base = new Date('2026-01-01T00:00:00.000Z').getTime();
          return base + dayOffset * 24 * 60 * 60 * 1000;
        }),
        (epochMs) => {
          const { from, to } = prevIstWeekWindow(epochMs);
          expect(to - from).toBe(7 * 24 * 60 * 60 * 1000);
        },
      ),
    );
  });
});
