/**
 * Unit tests for backtest-runner.ts
 *
 * All tests mock the pg Pool — no Docker / real database required.
 * The mock pool returns configurable results for each query call:
 *   - First call: personality_configs rows
 *   - Second call: daily_regime_tags rows
 *   - Subsequent calls: straddle_snapshots rows (empty by default)
 *
 * Design:
 *   - We test config validation, split computation, and split-label tagging.
 *   - We do NOT test the full signal-to-trade simulation path in unit tests
 *     (that requires real snapshot data and is covered by integration tests).
 *   - Pool.query is mocked with vi.fn() to avoid any DB dependency.
 */

import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createBacktestRunner } from '../backtest-runner.js';

// ---------------------------------------------------------------------------
// Mock pool factory
// ---------------------------------------------------------------------------

/**
 * Creates a minimal pg Pool mock.
 *
 * `queryResponses` is a list of result rows arrays returned in call order:
 *   - response[0] → first pool.query() call (personality_configs)
 *   - response[1] → second pool.query() call (daily_regime_tags)
 *   - response[2..] → subsequent calls (straddle_snapshots per day)
 *
 * If the call index exceeds the responses array length, returns { rows: [] }.
 */
function makeMockPool(queryResponses: Array<Array<Record<string, unknown>>>): Pool {
  let callIdx = 0;
  const mockQuery = vi.fn(() => {
    const rows = queryResponses[callIdx] ?? [];
    callIdx++;
    return Promise.resolve({ rows, rowCount: rows.length });
  });

  return {
    query: mockQuery,
    end: vi.fn().mockResolvedValue(undefined),
  } as unknown as Pool;
}

/** Default mock personality row (maps to a valid PersonalityConfigM2). */
function makePersonalityRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pers-001',
    name: 'clockwork',
    display_name: 'Clockwork',
    group_type: 'reference',
    entry_type: 'fixed_time',
    management_style: 'hold',
    is_frozen: true,
    is_active: true,
    phase: 1,
    params: { max_daily_trades: 1, max_daily_loss: 5000 },
    created_at: new Date('2024-01-01'),
    updated_at: new Date('2024-01-01'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createBacktestRunner — factory
// ---------------------------------------------------------------------------

describe('createBacktestRunner', () => {
  it('returns an object with a run method', () => {
    const pool = makeMockPool([]);
    const runner = createBacktestRunner(pool);
    expect(runner).toBeDefined();
    expect(typeof runner.run).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('config validation', () => {
  it('throws when fromDate is after toDate', async () => {
    const pool = makeMockPool([]);
    const runner = createBacktestRunner(pool);
    await expect(
      runner.run({
        underlying: 'NIFTY',
        fromDate: '2024-12-31',
        toDate: '2024-01-01',
      }),
    ).rejects.toThrow(/fromDate.*toDate|toDate.*fromDate/i);
  });

  it('throws for trainFraction = 0 (boundary — invalid)', async () => {
    const pool = makeMockPool([[makePersonalityRow()], []]);
    const runner = createBacktestRunner(pool);
    await expect(
      runner.run({
        underlying: 'NIFTY',
        fromDate: '2024-01-01',
        toDate: '2024-01-31',
        trainFraction: 0,
      }),
    ).rejects.toThrow(/trainFraction/i);
  });

  it('throws for trainFraction = 1 (boundary — invalid)', async () => {
    const pool = makeMockPool([[makePersonalityRow()], []]);
    const runner = createBacktestRunner(pool);
    await expect(
      runner.run({
        underlying: 'NIFTY',
        fromDate: '2024-01-01',
        toDate: '2024-01-31',
        trainFraction: 1,
      }),
    ).rejects.toThrow(/trainFraction/i);
  });

  it('throws for negative holdoutDays', async () => {
    const pool = makeMockPool([[makePersonalityRow()], []]);
    const runner = createBacktestRunner(pool);
    await expect(
      runner.run({
        underlying: 'NIFTY',
        fromDate: '2024-01-01',
        toDate: '2024-01-31',
        holdoutDays: -1,
      }),
    ).rejects.toThrow(/holdoutDays/i);
  });

  it('accepts valid equal fromDate and toDate', async () => {
    // Single-day range: one snapshot call → no rows → skipped
    const pool = makeMockPool([
      [makePersonalityRow()], // personalities
      [], // regime tags
      [], // snapshots for 2024-01-15
    ]);
    const runner = createBacktestRunner(pool);
    const result = await runner.run({
      underlying: 'NIFTY',
      fromDate: '2024-01-15',
      toDate: '2024-01-15',
      holdoutDays: 0,
      trainFraction: 0.7,
    });
    expect(result).toBeDefined();
    expect(result.skippedDates).toContain('2024-01-15');
  });
});

// ---------------------------------------------------------------------------
// Split computation
// ---------------------------------------------------------------------------

describe('split computation', () => {
  /**
   * 100-day range with holdoutDays=10 and trainFraction=0.7:
   *   - holdout: last 10 days
   *   - non-holdout: 90 days
   *   - train: floor(90 * 0.7) = 63 days
   *   - test: 90 - 63 = 27 days
   */
  it('correctly computes train/test/holdout day counts for 100-day range', async () => {
    // We need enough mock query responses: 1 (personalities) + 1 (regimes) + 100 (snapshots, all empty)
    const responses: Array<Array<Record<string, unknown>>> = [
      [makePersonalityRow()], // personalities
      [], // regime tags
      // 100 empty snapshot responses (all dates will be skipped)
      ...Array.from({ length: 100 }, () => []),
    ];
    const pool = makeMockPool(responses);
    const runner = createBacktestRunner(pool);

    const result = await runner.run({
      underlying: 'NIFTY',
      fromDate: '2024-01-01',
      toDate: '2024-04-09', // 100 days inclusive (2024 is a leap year)
      holdoutDays: 10,
      trainFraction: 0.7,
    });

    expect(result.split.holdout.days).toBe(10);
    // non-holdout = 90 days
    // floor(90 * 0.7) = 62 because 90 * 0.7 = 62.99999... in IEEE 754
    expect(result.split.train.days).toBe(62);
    expect(result.split.test.days).toBe(28); // 90 - 62
  });

  it('places all days in holdout when holdoutDays >= total days', async () => {
    const responses: Array<Array<Record<string, unknown>>> = [
      [makePersonalityRow()],
      [],
      [],
      [],
      [],
      [],
      [], // 5 empty snapshot responses
    ];
    const pool = makeMockPool(responses);
    const runner = createBacktestRunner(pool);

    const result = await runner.run({
      underlying: 'NIFTY',
      fromDate: '2024-01-01',
      toDate: '2024-01-05', // 5 days
      holdoutDays: 10, // exceeds total days
      trainFraction: 0.7,
    });

    // holdout is capped at total days
    expect(result.split.holdout.days).toBe(5);
    expect(result.split.train.days).toBe(0);
    expect(result.split.test.days).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Trade split labelling
// ---------------------------------------------------------------------------

describe('trade split labelling', () => {
  /**
   * Verifies that the backtest runner assigns the correct split label to trades.
   * We use a 10-day range with holdoutDays=2 and trainFraction=0.7.
   *   - 10 days total
   *   - holdout: last 2 days (2024-01-09, 2024-01-10)
   *   - non-holdout: 8 days
   *   - train: floor(8 * 0.7) = 5 days (2024-01-01 to 2024-01-05)
   *   - test: 3 days (2024-01-06 to 2024-01-08)
   *
   * We can only observe the split via result.split (not trades, since all snapshot
   * calls return empty rows and thus no trades are simulated). This is sufficient
   * to verify split boundary correctness.
   */
  it('assigns correct split boundaries for 10-day range with holdoutDays=2', async () => {
    const responses: Array<Array<Record<string, unknown>>> = [
      [makePersonalityRow()],
      [],
      ...Array.from({ length: 10 }, () => []),
    ];
    const pool = makeMockPool(responses);
    const runner = createBacktestRunner(pool);

    const result = await runner.run({
      underlying: 'NIFTY',
      fromDate: '2024-01-01',
      toDate: '2024-01-10',
      holdoutDays: 2,
      trainFraction: 0.7,
    });

    expect(result.split.holdout.from).toBe('2024-01-09');
    expect(result.split.holdout.to).toBe('2024-01-10');
    expect(result.split.holdout.days).toBe(2);

    expect(result.split.train.days).toBe(5); // floor(8 * 0.7)
    expect(result.split.train.from).toBe('2024-01-01');
    expect(result.split.train.to).toBe('2024-01-05');

    expect(result.split.test.days).toBe(3);
    expect(result.split.test.from).toBe('2024-01-06');
    expect(result.split.test.to).toBe('2024-01-08');
  });

  it('returns all skipped dates when all snapshots are empty', async () => {
    const responses: Array<Array<Record<string, unknown>>> = [
      [makePersonalityRow()],
      [],
      [],
      [],
      [], // 3 days → all skipped
    ];
    const pool = makeMockPool(responses);
    const runner = createBacktestRunner(pool);

    const result = await runner.run({
      underlying: 'NIFTY',
      fromDate: '2024-01-01',
      toDate: '2024-01-03',
      holdoutDays: 0,
      trainFraction: 0.7,
    });

    expect(result.skippedDates).toEqual(['2024-01-01', '2024-01-02', '2024-01-03']);
    expect(result.tradingDays).toBe(0);
    expect(result.trades).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Result structure
// ---------------------------------------------------------------------------

describe('BacktestResult structure', () => {
  it('includes config, split, personalities, and trades in result', async () => {
    const pool = makeMockPool([[makePersonalityRow()], [], []]);
    const runner = createBacktestRunner(pool);

    const config = {
      underlying: 'NIFTY',
      fromDate: '2024-01-15',
      toDate: '2024-01-15',
      holdoutDays: 0,
      trainFraction: 0.7,
    };
    const result = await runner.run(config);

    expect(result.config).toMatchObject({ underlying: 'NIFTY' });
    expect(result.split).toHaveProperty('train');
    expect(result.split).toHaveProperty('test');
    expect(result.split).toHaveProperty('holdout');
    expect(result.personalities).toHaveLength(1);
    expect(result.personalities[0]?.name).toBe('clockwork');
    expect(Array.isArray(result.trades)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C2 N+1 fix: single range query replaces per-day loop
// ---------------------------------------------------------------------------

describe('single-range snapshot query (C2 N+1 fix)', () => {
  /**
   * Counts total pool.query() calls made during runner.run().
   *
   * Before the fix: 2 (personalities + regimes) + N (one per calendar day)
   * After the fix:  2 (personalities + regimes) + 1 (range query for all days)
   *
   * We use a tracking wrapper around pool.query to count calls precisely.
   */
  function makeCountingPool(queryResponses: Array<Array<Record<string, unknown>>>): {
    pool: Pool;
    getCallCount: () => number;
  } {
    let callIdx = 0;
    let callCount = 0;
    const mockQuery = vi.fn(() => {
      callCount++;
      const rows = queryResponses[callIdx] ?? [];
      callIdx++;
      return Promise.resolve({ rows, rowCount: rows.length });
    });
    const pool = {
      query: mockQuery,
      end: vi.fn().mockResolvedValue(undefined),
    } as unknown as Pool;
    return { pool, getCallCount: () => callCount };
  }

  it('issues exactly 3 pool.query() calls regardless of the date range length', async () => {
    // 10-day range. Before fix: 2 + 10 = 12 calls. After fix: 2 + 1 = 3 calls.
    // The mock returns:
    //   - call 1: personality rows
    //   - call 2: regime tags (empty)
    //   - call 3: all straddle snapshots for the full range (empty)
    const { pool, getCallCount } = makeCountingPool([
      [makePersonalityRow()], // personalities
      [],                      // regime tags
      [],                      // single range query (all days, no snapshots)
    ]);

    const runner = createBacktestRunner(pool);
    await runner.run({
      underlying: 'NIFTY',
      fromDate: '2024-01-01',
      toDate: '2024-01-10', // 10 calendar days
      holdoutDays: 0,
      trainFraction: 0.7,
    });

    // Exactly 3 DB calls: personalities, regime tags, single snapshot range query
    expect(getCallCount()).toBe(3);
  });

  it('issues exactly 3 pool.query() calls for a 100-day range', async () => {
    // Verify the O(1) query count holds for a larger range (was O(N) before fix).
    const { pool, getCallCount } = makeCountingPool([
      [makePersonalityRow()],
      [],
      [], // single range response
    ]);

    const runner = createBacktestRunner(pool);
    await runner.run({
      underlying: 'NIFTY',
      fromDate: '2024-01-01',
      toDate: '2024-04-09', // ~100 calendar days
      holdoutDays: 10,
      trainFraction: 0.7,
    });

    // Still exactly 3 calls regardless of date range width
    expect(getCallCount()).toBe(3);
  });

  it('correctly groups snapshots by date when the range query returns rows', async () => {
    // Verify that rows returned by the range query are correctly assigned to their
    // calendar day. We inject 2 snapshot rows for 2024-01-01 and verify they
    // produce 1 trading day (not 0 skipped).
    //
    // The range query returns rows with a computed `date_iso` column
    // (TO_CHAR(time AT TIME ZONE 'UTC', 'YYYY-MM-DD')) that the runner uses to
    // group rows into the per-day map.
    //
    // We simulate a row that has time = '2024-01-01T09:30:00Z' (IST 15:00 trading hour)
    // and provide the computed date_iso = '2024-01-01'.
    const snapshotRows = [
      {
        date_iso: '2024-01-01',
        time: new Date('2024-01-01T09:30:00Z'),
        call_ltp: '100',
        put_ltp: '100',
        straddle_value: '200',
        roc: '0.5',
        roc_acceleration: '-0.1',
        vix: '15',
        strike: '21000',
      },
      {
        date_iso: '2024-01-01',
        time: new Date('2024-01-01T10:00:00Z'),
        call_ltp: '105',
        put_ltp: '95',
        straddle_value: '200',
        roc: '0.3',
        roc_acceleration: '-0.2',
        vix: '15',
        strike: '21000',
      },
    ];

    const { pool } = makeCountingPool([
      [makePersonalityRow()], // personalities
      [],                      // regime tags
      snapshotRows,            // range query returns 2 rows for 2024-01-01
    ]);

    const runner = createBacktestRunner(pool);
    const result = await runner.run({
      underlying: 'NIFTY',
      fromDate: '2024-01-01',
      toDate: '2024-01-01',
      holdoutDays: 0,
      trainFraction: 0.7,
    });

    // 2024-01-01 has snapshots → it is a trading day (not skipped)
    expect(result.tradingDays).toBe(1);
    expect(result.skippedDates).not.toContain('2024-01-01');
  });

  it('skips days with no snapshots in the range (same behavior as per-day query)', async () => {
    // A 3-day range with an empty range query → all 3 days are skipped.
    // This is the same behavior as the old per-day loop returning empty arrays.
    const { pool } = makeCountingPool([
      [makePersonalityRow()],
      [],
      [], // empty range = no snapshots for any day
    ]);

    const runner = createBacktestRunner(pool);
    const result = await runner.run({
      underlying: 'NIFTY',
      fromDate: '2024-01-01',
      toDate: '2024-01-03',
      holdoutDays: 0,
      trainFraction: 0.7,
    });

    expect(result.tradingDays).toBe(0);
    expect(result.skippedDates).toEqual(['2024-01-01', '2024-01-02', '2024-01-03']);
  });
});
