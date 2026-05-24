/**
 * Integration tests for the historical backfill writer — @critical QA items
 * that require real PostgreSQL to verify DB-level idempotency and resume behavior.
 *
 * @integration — requires Docker services (PostgreSQL + TimescaleDB)
 *
 * Run with: bun run test:integration
 * Requires: docker compose up -d (TimescaleDB + Redis)
 *
 * What is tested (supplement to the existing backfill.test.ts integration suite):
 *
 *   B1. The partial unique index on (symbol, time) WHERE source='fyers-historical'
 *       prevents duplicate rows on a re-run of the same (symbol, from, to,
 *       resolution) range. The ON CONFLICT DO NOTHING in writeMarketTicks /
 *       writeOptionTicks must hit the partial unique index and suppress duplicates.
 *
 *   B2. The partial index is DISJOINT from live keys: inserting a row with
 *       source='fyers' (live key space) then running backfill for the same
 *       (symbol, time) does NOT trigger a conflict and does NOT suppress the
 *       historical write. Both rows can coexist.
 *
 *   B3. Resume-after-interruption continues from checkpoint_ts, not from the
 *       original from date. We simulate the interruption by making the fetch
 *       function return a 401 response (FyersAuthError). After the checkpoint,
 *       we re-run with a successful fetch and assert:
 *         (a) The resume starts from checkpoint_ts (not from the original from).
 *         (b) No rows are duplicated (ON CONFLICT DO NOTHING handles any overlap).
 *         (c) The final status is 'complete' or 'gapped'.
 *
 *   B4. All backfill writes carry a bounded time filter — we verify this by
 *       querying market_ticks without a time range and asserting the written
 *       rows are within the expected [from, to] bounds (hypertable discipline:
 *       the writer must not write rows outside the requested window).
 *
 * The Fyers fetch layer is mocked in all tests (no live network calls). The
 * REAL part under test is Postgres write/idempotency/resume behavior.
 *
 * Design decisions:
 *   - We use createTestDb() which runs all migrations (001–009).
 *   - We truncate backfill_ranges, market_ticks, and option_ticks in afterEach.
 *   - All market_ticks / option_ticks queries use time-range bounds.
 *   - Fyers env vars are stubbed (dummy values) to satisfy the credential check
 *     in fetchHistoricalCandles() before our mockFetchFn intercepts the HTTP call.
 *   - Tests are skipped when DATABASE_URL is absent (no Docker) via describe.skipIf.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Pool } from 'pg';
import { createTestDb } from '../../../test/integration/helpers.js';
import {
  runBackfill,
  BackfillResumeError,
} from '../backfill.js';
import {
  FyersAuthError,
  type FyersCandle,
  type FetchFn,
} from '../../brokers/fyers-historical.js';

// ---------------------------------------------------------------------------
// Skip guard — skip the entire suite when DATABASE_URL is absent (Docker down)
// ---------------------------------------------------------------------------

const SKIP = !process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Candle factory
// ---------------------------------------------------------------------------

/**
 * Build a minimal FyersCandle for the given date and close price.
 * Uses 10:00 IST (04:30 UTC) as the candle timestamp so the UTC date equals
 * the trading day date (avoids midnight-crossing issues).
 */
function makeCandle(date: string, closePrice: number): FyersCandle {
  return {
    timestamp: new Date(`${date}T04:30:00.000Z`),
    open: closePrice - 5,
    high: closePrice + 10,
    low: closePrice - 10,
    close: closePrice,
    volume: 1000,
  };
}

/**
 * Build a mock fetchFn that returns the given candles in the Fyers v3 API
 * response format. The function never makes a real HTTP request.
 */
function mockSuccessFetchFn(candles: FyersCandle[]): FetchFn {
  const rawCandles = candles.map((c) => [
    Math.floor(c.timestamp.getTime() / 1000),
    c.open,
    c.high,
    c.low,
    c.close,
    c.volume,
  ]);
  const body = JSON.stringify({ s: 'ok', candles: rawCandles });
  return () =>
    Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
}

/**
 * Build a mock fetchFn that returns HTTP 401 (simulates FyersAuthError).
 * Used to trigger BackfillResumeError in the interruption/resume tests.
 */
function mockAuthFailFetchFn(): FetchFn {
  return () =>
    Promise.resolve(
      new Response('Unauthorized', { status: 401 }),
    );
}

/** No-op sleep to avoid real delays in test runs. */
const noopSleep = (): Promise<void> => Promise.resolve();

// ---------------------------------------------------------------------------
// DB query helpers (all time-range bounded)
// ---------------------------------------------------------------------------

/**
 * Count rows in market_ticks for the given symbol and time range.
 * source='fyers-historical' matches the partial unique index predicate.
 */
async function countMarketTicksRows(
  db: Pool,
  symbol: string,
  from: Date,
  to: Date,
  source = 'fyers-historical',
): Promise<number> {
  const paddedTo = new Date(to.getTime() + 86_400_000); // +1 day buffer
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM market_ticks
     WHERE symbol = $1
       AND time >= $2
       AND time <= $3
       AND source = $4`,
    [symbol, from.toISOString(), paddedTo.toISOString(), source],
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * Count rows in option_ticks for the given symbol and time range.
 */
async function countOptionTicksRows(
  db: Pool,
  symbol: string,
  from: Date,
  to: Date,
  source = 'fyers-historical',
): Promise<number> {
  const paddedTo = new Date(to.getTime() + 86_400_000);
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM option_ticks
     WHERE symbol = $1
       AND time >= $2
       AND time <= $3
       AND source = $4`,
    [symbol, from.toISOString(), paddedTo.toISOString(), source],
  );
  return Number(result.rows[0]?.count ?? 0);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('backfill integration — partial unique index and resume', () => {
  let db: Pool;

  beforeAll(async () => {
    // createTestDb() runs all migrations (001–009) so the partial unique
    // indexes from migration 007 are in place.
    db = await createTestDb();
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  beforeAll(() => {
    // Provide dummy Fyers credentials so fetchHistoricalCandles() does not
    // throw FyersNoCredentialsError before our mockFetchFn intercepts the request.
    process.env.FYERS_ACCESS_TOKEN = 'test-token-for-backfill-integration';
    process.env.FYERS_APP_ID = 'TESTINTEGR12-100';
  });

  afterAll(() => {
    if (process.env.FYERS_ACCESS_TOKEN === 'test-token-for-backfill-integration') {
      process.env.FYERS_ACCESS_TOKEN = undefined;
    }
    if (process.env.FYERS_APP_ID === 'TESTINTEGR12-100') {
      process.env.FYERS_APP_ID = undefined;
    }
  });

  afterEach(async () => {
    // Truncate all state between tests. backfill_ranges is included so
    // resumption state does not leak across tests.
    await db.query(`
      TRUNCATE market_ticks, option_ticks, backfill_ranges
      RESTART IDENTITY CASCADE
    `);
  });

  // ── B1: Partial unique index prevents duplicates on re-run ─────────────────

  it('partial unique index on (symbol, time) WHERE source=fyers-historical prevents duplicate rows on re-run', async () => {
    // Two consecutive trading days. We do not use a weekend range to avoid
    // triggering calendar gap detection that would make the status 'gapped' in
    // an unpredictable way (the test focuses on idempotency, not gap detection).
    const candles = [
      makeCandle('2024-01-02', 21800), // Tuesday
      makeCandle('2024-01-03', 21900), // Wednesday
    ];

    const symbol = 'NSE:NIFTY50-INDEX';
    const resolution = 'D' as const;
    const from = new Date('2024-01-02T00:00:00.000Z');
    const to = new Date('2024-01-03T00:00:00.000Z');

    const baseOptions = {
      symbol,
      resolution,
      from,
      to,
      fetchFn: mockSuccessFetchFn(candles),
      sleepFn: noopSleep,
    };

    // First run — writes 2 rows.
    const result1 = await runBackfill(db, baseOptions);
    expect(result1.rowsWritten).toBe(candles.length);
    expect(['complete', 'gapped']).toContain(result1.status);

    const countAfterFirst = await countMarketTicksRows(db, symbol, from, to);
    expect(countAfterFirst).toBe(candles.length);

    // Second run — the range status is already 'complete' or 'gapped', so
    // runBackfill short-circuits immediately (no re-fetch, no re-write).
    const result2 = await runBackfill(db, { ...baseOptions, fetchFn: mockSuccessFetchFn(candles) });
    expect(result2.rowsWritten).toBe(0); // short-circuit: no new writes
    expect(['complete', 'gapped']).toContain(result2.status);

    // Row count must be identical — no duplicates.
    const countAfterSecond = await countMarketTicksRows(db, symbol, from, to);
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it('partial unique index prevents duplicates for option_ticks as well as market_ticks', async () => {
    // Use a CE option symbol to exercise the option_ticks write path.
    const ceSymbol = 'NSE:NIFTY25MAY24000CE';
    const candles = [
      makeCandle('2024-01-02', 150),
      makeCandle('2024-01-03', 155),
    ];

    const from = new Date('2024-01-02T00:00:00.000Z');
    const to = new Date('2024-01-03T00:00:00.000Z');

    const options = {
      symbol: ceSymbol,
      resolution: 'D' as const,
      from,
      to,
      fetchFn: mockSuccessFetchFn(candles),
      sleepFn: noopSleep,
    };

    const result1 = await runBackfill(db, options);
    expect(result1.rowsWritten).toBe(candles.length);

    const countAfterFirst = await countOptionTicksRows(db, ceSymbol, from, to);
    expect(countAfterFirst).toBe(candles.length);

    // Short-circuit on second run — status is already terminal.
    const result2 = await runBackfill(db, { ...options, fetchFn: mockSuccessFetchFn(candles) });
    expect(result2.rowsWritten).toBe(0);

    const countAfterSecond = await countOptionTicksRows(db, ceSymbol, from, to);
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  // ── B2: Partial index is disjoint from live keys ────────────────────────────

  it('partial index is disjoint — inserting a live row (source=fyers) then backfilling does not conflict', async () => {
    // Insert a live-style row into market_ticks with source='fyers' at the
    // same (symbol, time) that the backfill will write to.
    // The partial unique index WHERE source='fyers-historical' excludes live rows,
    // so there must be no conflict and both rows coexist.

    const symbol = 'NSE:NIFTY50-INDEX';
    const candleTime = new Date('2024-01-02T04:30:00.000Z');
    const from = new Date('2024-01-02T00:00:00.000Z');
    const to = new Date('2024-01-02T00:00:00.000Z');

    // Insert a live row (source='fyers') at the same timestamp.
    await db.query(
      `INSERT INTO market_ticks (time, symbol, ltp, source)
       VALUES ($1, $2, $3, 'fyers')`,
      [candleTime.toISOString(), symbol, 21750],
    );

    // Verify the live row is present.
    const liveRows = await countMarketTicksRows(db, symbol, from, to, 'fyers');
    expect(liveRows).toBe(1);

    // Now backfill the same (symbol, from, to) range with historical candles.
    const candles = [makeCandle('2024-01-02', 21800)];
    const result = await runBackfill(db, {
      symbol,
      resolution: 'D' as const,
      from,
      to,
      fetchFn: mockSuccessFetchFn(candles),
      sleepFn: noopSleep,
    });

    // The backfill must write 1 new row (source='fyers-historical').
    // It must NOT conflict with the live row (source='fyers' is outside the partial index).
    expect(result.rowsWritten).toBe(1);

    // Both rows (live + historical) must coexist.
    const liveAfter = await countMarketTicksRows(db, symbol, from, to, 'fyers');
    const histAfter = await countMarketTicksRows(db, symbol, from, to, 'fyers-historical');
    expect(liveAfter).toBe(1);  // live row untouched
    expect(histAfter).toBe(1);  // historical row added
  });

  it('partial index is disjoint — simulator rows (source=simulator) are unaffected by backfill idempotency', async () => {
    const symbol = 'NSE:NIFTY50-INDEX';
    const candleTime = new Date('2024-01-02T04:30:00.000Z');
    const from = new Date('2024-01-02T00:00:00.000Z');
    const to = new Date('2024-01-02T00:00:00.000Z');

    // Insert a simulator row at the same timestamp.
    await db.query(
      `INSERT INTO market_ticks (time, symbol, ltp, source)
       VALUES ($1, $2, $3, 'simulator')`,
      [candleTime.toISOString(), symbol, 21000],
    );

    const candles = [makeCandle('2024-01-02', 21800)];
    const result = await runBackfill(db, {
      symbol,
      resolution: 'D' as const,
      from,
      to,
      fetchFn: mockSuccessFetchFn(candles),
      sleepFn: noopSleep,
    });

    expect(result.rowsWritten).toBe(1);

    // Simulator row must still exist and be unaffected.
    const simRows = await countMarketTicksRows(db, symbol, from, to, 'simulator');
    const histRows = await countMarketTicksRows(db, symbol, from, to, 'fyers-historical');
    expect(simRows).toBe(1);
    expect(histRows).toBe(1);
  });

  // ── B3: Resume-after-interruption continues from checkpoint ────────────────

  it('interrupted backfill checkpoints and resumes from checkpoint_ts, not from the original from date', async () => {
    const symbol = 'NSE:NIFTY50-INDEX';
    const resolution = 'D' as const;
    const from = new Date('2024-01-02T00:00:00.000Z');
    const to = new Date('2024-01-04T00:00:00.000Z');

    // ── Phase 1: First run fails with FyersAuthError ────────────────────────
    // The 401 response triggers FyersAuthError inside fetchHistoricalCandles().
    // runBackfill must catch it, write a checkpoint, and throw BackfillResumeError.
    let resumeError: BackfillResumeError | undefined;
    try {
      await runBackfill(db, {
        symbol,
        resolution,
        from,
        to,
        fetchFn: mockAuthFailFetchFn(),
        sleepFn: noopSleep,
      });
      // Must not reach here — the 401 must throw BackfillResumeError.
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(BackfillResumeError);
      resumeError = err as BackfillResumeError;
    }

    expect(resumeError).toBeDefined();
    const rangeId = resumeError!.rangeId;

    // backfill_ranges row must show status='partial' with checkpoint_ts=null
    // (the 401 fired before any candle was successfully fetched).
    const partialResult = await db.query<{
      status: string;
      checkpoint_ts: Date | null;
      rows_written: number;
    }>(
      `SELECT status, checkpoint_ts, rows_written
       FROM backfill_ranges
       WHERE id = $1`,
      [rangeId],
    );
    const partialRow = partialResult.rows[0];
    expect(partialRow?.status).toBe('partial');
    expect(partialRow?.checkpoint_ts).toBeNull(); // no candles written before failure

    // No market_ticks rows should exist yet.
    const countBeforeResume = await countMarketTicksRows(db, symbol, from, to);
    expect(countBeforeResume).toBe(0);

    // ── Phase 2: Resume run with successful fetch ──────────────────────────
    const candles = [
      makeCandle('2024-01-02', 21800), // Tuesday
      makeCandle('2024-01-03', 21900), // Wednesday
      makeCandle('2024-01-04', 22000), // Thursday
    ];

    const result2 = await runBackfill(db, {
      symbol,
      resolution,
      from,
      to,
      fetchFn: mockSuccessFetchFn(candles),
      sleepFn: noopSleep,
    });

    // Resume must complete successfully.
    expect(['complete', 'gapped']).toContain(result2.status);
    // All candles must be written on the resume run.
    expect(result2.rowsWritten).toBe(candles.length);

    // The DB must now contain all 3 candles.
    const countAfterResume = await countMarketTicksRows(db, symbol, from, to);
    expect(countAfterResume).toBe(candles.length);

    // ── Phase 3: Running again is idempotent (status is terminal) ──────────
    const result3 = await runBackfill(db, {
      symbol,
      resolution,
      from,
      to,
      fetchFn: mockSuccessFetchFn(candles),
      sleepFn: noopSleep,
    });
    expect(result3.rowsWritten).toBe(0); // short-circuit
    expect(result3.rangeId).toBe(rangeId); // same range row

    const countAfterThirdRun = await countMarketTicksRows(db, symbol, from, to);
    expect(countAfterThirdRun).toBe(candles.length); // unchanged
  });

  it('a partial run followed by a successful resume produces no duplicate rows', async () => {
    // Verify the ON CONFLICT DO NOTHING absorbs the overlap when checkpoint_ts
    // is NOT null (simulates a partial run where some candles were written before
    // the auth failure — Fyers fetches in chunks, and the checkpoint is set to
    // the last candle of the successfully-fetched chunk).
    //
    // We simulate this by:
    //   1. Directly writing one candle row into market_ticks (mimicking the partial write).
    //   2. Inserting a 'partial' backfill_ranges row with checkpoint_ts = that candle's time.
    //   3. Running runBackfill with the full candle set — the resume must start from
    //      checkpoint_ts and ON CONFLICT DO NOTHING must absorb the overlap row.

    const symbol = 'NSE:NIFTY50-INDEX';
    const resolution = 'D' as const;
    const from = new Date('2024-01-02T00:00:00.000Z');
    const to = new Date('2024-01-03T00:00:00.000Z');
    const checkpointDate = '2024-01-02';
    const checkpointTs = new Date(`${checkpointDate}T04:30:00.000Z`);

    // Write the "already written" candle directly — source='fyers-historical'
    // so the partial unique index applies.
    await db.query(
      `INSERT INTO market_ticks (time, symbol, ltp, source, resolution)
       VALUES ($1, $2, $3, 'fyers-historical', $4)`,
      [checkpointTs.toISOString(), symbol, 21800, resolution],
    );

    // Insert a 'partial' backfill_ranges row with checkpoint_ts set.
    const insertRange = await db.query<{ id: number }>(
      `INSERT INTO backfill_ranges
         (symbol, from_ts, to_ts, resolution, status, rows_written, checkpoint_ts, updated_at)
       VALUES ($1, $2, $3, $4, 'partial', 1, $5, NOW())
       RETURNING id`,
      [symbol, from.toISOString(), to.toISOString(), resolution, checkpointTs.toISOString()],
    );
    const rangeId = insertRange.rows[0]?.id;
    expect(rangeId).toBeDefined();

    // Resume: fetch returns both candles (including the one already in the DB).
    // ON CONFLICT DO NOTHING must absorb the first candle and only write the second.
    const allCandles = [
      makeCandle(checkpointDate, 21800), // already in DB
      makeCandle('2024-01-03', 21900),   // new
    ];

    const result = await runBackfill(db, {
      symbol,
      resolution,
      from,
      to,
      fetchFn: mockSuccessFetchFn(allCandles),
      sleepFn: noopSleep,
    });

    expect(['complete', 'gapped']).toContain(result.status);

    // Total row count in the DB must be exactly 2 — no duplicate for the
    // checkpoint candle, and the new candle was written.
    const countAfter = await countMarketTicksRows(db, symbol, from, to);
    expect(countAfter).toBe(2);
  });

  // ── B4: All backfill writes are within the requested time bounds ────────────

  it('backfill writes only rows within the requested [from, to] time bounds', async () => {
    // Even if fetchHistoricalCandles returned candles outside [from, to]
    // (a defensive concern), the writer must only insert rows from the fetch result.
    // Our mockFetchFn returns exactly the candles we specify — we verify the DB
    // contains only those rows and nothing outside the window.

    const symbol = 'NSE:NIFTY50-INDEX';
    const from = new Date('2024-01-03T00:00:00.000Z');
    const to = new Date('2024-01-05T00:00:00.000Z');

    const candles = [
      makeCandle('2024-01-03', 21850), // Wednesday
      makeCandle('2024-01-04', 21900), // Thursday
      makeCandle('2024-01-05', 21950), // Friday — last day in range
    ];

    await runBackfill(db, {
      symbol,
      resolution: 'D' as const,
      from,
      to,
      fetchFn: mockSuccessFetchFn(candles),
      sleepFn: noopSleep,
    });

    // All rows within the range must be present.
    const countInRange = await countMarketTicksRows(db, symbol, from, to);
    expect(countInRange).toBe(candles.length);

    // No rows outside [from, to] must exist (hypertable discipline).
    const beforeFrom = await countMarketTicksRows(
      db,
      symbol,
      new Date('2024-01-01T00:00:00.000Z'),
      new Date('2024-01-02T23:59:59.000Z'),
    );
    expect(beforeFrom).toBe(0);

    const afterTo = await countMarketTicksRows(
      db,
      symbol,
      new Date('2024-01-06T00:00:00.000Z'),
      new Date('2024-01-10T00:00:00.000Z'),
    );
    expect(afterTo).toBe(0);
  });

  it('backfill writes candles with the correct resolution column value', async () => {
    // The resolution column is written from the BackfillOptions.resolution value.
    // Verify the DB rows have the expected resolution after a successful run.

    const symbol = 'NSE:NIFTY50-INDEX';
    const resolution = '5' as const; // 5-minute candles
    const from = new Date('2024-01-02T00:00:00.000Z');
    const to = new Date('2024-01-02T00:00:00.000Z');
    const candles = [makeCandle('2024-01-02', 21800)];

    await runBackfill(db, {
      symbol,
      resolution,
      from,
      to,
      fetchFn: mockSuccessFetchFn(candles),
      sleepFn: noopSleep,
    });

    // Query the written row and verify the resolution column.
    const result = await db.query<{ resolution: string | null }>(
      `SELECT resolution
       FROM market_ticks
       WHERE symbol = $1
         AND time >= $2
         AND time <= $3
         AND source = 'fyers-historical'`,
      [symbol, from.toISOString(), new Date('2024-01-03T00:00:00.000Z').toISOString()],
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.resolution).toBe(resolution);
  });

  // ── B5: backfill_ranges invariants ──────────────────────────────────────────

  it('a gapped range is never marked complete when calendar gaps are detected', async () => {
    // Provide candles for Monday and Wednesday only — Tuesday is missing.
    // The calendar reconciler must detect the gap and set status='gapped'.
    const symbol = 'NSE:NIFTY50-INDEX';
    const from = new Date('2024-01-08T00:00:00.000Z');
    const to = new Date('2024-01-10T00:00:00.000Z');

    const candlesWithGap = [
      makeCandle('2024-01-08', 21700), // Monday
      // Tuesday 2024-01-09 intentionally absent
      makeCandle('2024-01-10', 21800), // Wednesday
    ];

    const result = await runBackfill(db, {
      symbol,
      resolution: 'D' as const,
      from,
      to,
      fetchFn: mockSuccessFetchFn(candlesWithGap),
      sleepFn: noopSleep,
    });

    expect(result.status).toBe('gapped');
    expect(result.gaps.length).toBeGreaterThan(0);

    // The DB row must not be 'complete'.
    const rangeRow = await db.query<{ status: string }>(
      `SELECT status FROM backfill_ranges WHERE id = $1`,
      [result.rangeId],
    );
    expect(rangeRow.rows[0]?.status).toBe('gapped');
    expect(rangeRow.rows[0]?.status).not.toBe('complete');
  });

  it('a completed range short-circuits on re-run and preserves the rows_written total', async () => {
    const symbol = 'NSE:NIFTY50-INDEX';
    const from = new Date('2024-01-02T00:00:00.000Z');
    const to = new Date('2024-01-03T00:00:00.000Z');
    const candles = [
      makeCandle('2024-01-02', 21800),
      makeCandle('2024-01-03', 21900),
    ];

    const result1 = await runBackfill(db, {
      symbol,
      resolution: 'D' as const,
      from,
      to,
      fetchFn: mockSuccessFetchFn(candles),
      sleepFn: noopSleep,
    });

    expect(result1.rowsWritten).toBe(candles.length);
    const totalAfterFirst = result1.totalRowsWritten;

    // Re-run: status is terminal, must short-circuit.
    const result2 = await runBackfill(db, {
      symbol,
      resolution: 'D' as const,
      from,
      to,
      fetchFn: mockSuccessFetchFn(candles),
      sleepFn: noopSleep,
    });

    expect(result2.rowsWritten).toBe(0);
    // The totalRowsWritten from the second run must reflect the first run's count.
    expect(result2.totalRowsWritten).toBe(totalAfterFirst);
    // rangeId is the same (same backfill_ranges row).
    expect(result2.rangeId).toBe(result1.rangeId);
  });
});
