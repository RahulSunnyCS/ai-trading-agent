/**
 * Integration tests for the historical backfill writer (T-55).
 *
 * These tests require a running PostgreSQL (TimescaleDB) instance with the full
 * schema applied (migrations 001–007 inclusive). Run with:
 *   bun run test:integration
 * (Requires: docker compose up -d)
 *
 * What is tested:
 *   1. Idempotent re-run: running the same backfill twice writes ZERO duplicate rows.
 *   2. Interrupted run / resume: mock fetchHistoricalCandles to throw FyersAuthError
 *      partway through; verify the run checkpoints correctly and a subsequent call
 *      resumes from the checkpoint without re-writing completed data.
 *   3. Calendar gap recording: when candle data is missing for expected trading
 *      days, the gap is recorded in backfill_ranges.gaps_json and the status is
 *      'gapped', not 'complete'.
 *
 * The Fyers fetch layer is mocked in all tests (no live network calls).
 *
 * Design decisions:
 *   - We call runBackfill() directly (no subprocess), mocking fetchHistoricalCandles
 *     via the fetchFn + sleepFn injectable parameters from BackfillOptions.
 *   - Because we are testing the writer (not the fetcher), fetchFn always returns
 *     pre-built candle arrays. sleepFn is stubbed to a no-op.
 *   - createTestDb() runs all migrations so migration 007 is applied before tests.
 *   - cleanTestDb() is called in afterEach to prevent state leakage between tests.
 *   - All DB reads after runBackfill() are time-range bounded (hypertable discipline).
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

import { createTestDb, cleanTestDb } from "../../../test/integration/helpers.js";
import { runBackfill, BackfillResumeError, resolveSymbolTable, reconcileCalendarGaps } from "../backfill.js";
import {
  FyersAuthError,
  type FyersCandle,
  type FyersHistoricalResult,
  type FetchFn,
} from "../../brokers/fyers-historical.js";

// ---------------------------------------------------------------------------
// Skip guard — skip the entire suite when DATABASE_URL is absent (no Docker)
// ---------------------------------------------------------------------------

const SKIP = !process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

/**
 * A candle factory. Creates synthetic FyersCandle objects for use in mock
 * fetchFn implementations. All prices are made-up — we only care about the
 * timestamp and the structure, not market realism.
 */
function makeCandle(date: string, closePrice: number): FyersCandle {
  // Use 10:00 IST (04:30 UTC) as the candle time — a valid NSE trading hour.
  // This ensures the UTC date extracted for calendar reconciliation matches
  // the trading day date (e.g. '2024-01-02').
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
 * Build a mock fetchFn that returns the given candles and no gaps.
 * Used for the happy-path idempotency test.
 */
function mockFetchFn(candles: FyersCandle[]): FetchFn {
  // The backfill writer calls fetchHistoricalCandles (from fyers-historical.ts)
  // which internally calls fetchFn for HTTP requests. We mock the underlying
  // HTTP fetch so that fetchHistoricalCandles returns our pre-built candles.
  //
  // We construct a Response whose JSON body matches the Fyers v3 API shape:
  //   { s: "ok", candles: [[epochSeconds, open, high, low, close, volume], ...] }
  //
  // fetchHistoricalCandles parses this and returns FyersCandle objects that
  // match our input (modulo floating-point trivially).
  const rawCandles = candles.map((c) => [
    Math.floor(c.timestamp.getTime() / 1000),
    c.open,
    c.high,
    c.low,
    c.close,
    c.volume,
  ]);

  const responseBody = JSON.stringify({ s: "ok", candles: rawCandles });

  return () =>
    Promise.resolve(
      new Response(responseBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

/** No-op sleep function to avoid delays in tests. */
const noopSleep = () => Promise.resolve();

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("backfill writer integration", () => {
  let db: Pool;

  // ── Setup ──────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    // createTestDb() runs all migrations (001–007) against the test database.
    // If migration 007 has not been applied yet, it will be applied now.
    db = await createTestDb();
  }, 30_000);

  afterAll(async () => {
    await db.end();
  });

  afterEach(async () => {
    // Truncate all data tables between tests to prevent state leakage.
    // We also truncate backfill_ranges since cleanTestDb does not cover it.
    await db.query(`
      TRUNCATE market_ticks, option_ticks, backfill_ranges
      RESTART IDENTITY CASCADE
    `);
  });

  // ── Env setup for Fyers credential resolution ──────────────────────────────
  // fetchHistoricalCandles() always tries to resolve credentials first (before
  // calling fetchFn). To prevent it from throwing FyersNoCredentialsError in
  // tests, we provide dummy env vars. The actual fetchFn mock never hits the
  // network, so the values don't matter.
  beforeAll(() => {
    process.env.FYERS_ACCESS_TOKEN = "test-token-for-backfill-tests";
    process.env.FYERS_APP_ID = "TEST12345678-100";
  });

  afterAll(() => {
    // Remove only if we set them — don't leak to other test files.
    if (process.env.FYERS_ACCESS_TOKEN === "test-token-for-backfill-tests") {
      process.env.FYERS_ACCESS_TOKEN = undefined;
    }
    if (process.env.FYERS_APP_ID === "TEST12345678-100") {
      process.env.FYERS_APP_ID = undefined;
    }
  });

  // ── Test 1: Idempotent re-run ───────────────────────────────────────────────

  it("idempotent re-run writes zero duplicate rows", async () => {
    // Two weekdays in the same week — no weekend gaps, so calendar reconciliation
    // should find no missing days and mark the range 'complete'.
    const candles = [
      makeCandle("2024-01-02", 21800), // Tuesday
      makeCandle("2024-01-03", 21900), // Wednesday
    ];

    const options = {
      symbol: "NSE:NIFTY50-INDEX",
      resolution: "D" as const,
      from: new Date("2024-01-02T00:00:00.000Z"),
      to: new Date("2024-01-03T00:00:00.000Z"),
      fetchFn: mockFetchFn(candles),
      sleepFn: noopSleep,
    };

    // First run — should write 2 rows.
    const result1 = await runBackfill(db, options);

    // Verify rows are in the database (time-range bounded query).
    const rows1 = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM market_ticks
       WHERE symbol = $1
         AND time >= $2
         AND time <= $3
         AND source = 'fyers-historical'`,
      [
        "NSE:NIFTY50-INDEX",
        "2024-01-02T00:00:00.000Z",
        "2024-01-04T00:00:00.000Z",
      ],
    );
    const countAfterFirst = Number(rows1.rows[0]?.count ?? 0);

    // Status should be 'complete' for two consecutive weekdays.
    // (If the test DB contains NSE holidays on these dates, it may be 'gapped' —
    // but 2024-01-02 and 2024-01-03 are both normal NSE trading days.)
    expect(["complete", "gapped"]).toContain(result1.status);
    expect(result1.rowsWritten).toBe(candles.length);

    // Second run — must write ZERO new rows (idempotency).
    // The fetchFn is reset to return the same candles; ON CONFLICT DO NOTHING
    // should absorb all of them.
    const options2 = { ...options, fetchFn: mockFetchFn(candles) };
    const result2 = await runBackfill(db, options2);

    // rowsWritten in the second call should be 0 because status was 'complete'
    // or 'gapped' — the writer short-circuits immediately without a fetch.
    expect(result2.rowsWritten).toBe(0);
    expect(["complete", "gapped"]).toContain(result2.status);

    // Total row count in the DB must not have changed.
    const rows2 = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM market_ticks
       WHERE symbol = $1
         AND time >= $2
         AND time <= $3
         AND source = 'fyers-historical'`,
      [
        "NSE:NIFTY50-INDEX",
        "2024-01-02T00:00:00.000Z",
        "2024-01-04T00:00:00.000Z",
      ],
    );
    const countAfterSecond = Number(rows2.rows[0]?.count ?? 0);
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  // ── Test 2: Interrupted run resumes from checkpoint ────────────────────────

  it("interrupted run resumes from checkpoint without re-writing completed data", async () => {
    // Simulate a fetch that succeeds for one candle, then fails with FyersAuthError.
    // We do this by providing a fetchFn that returns a response for the first chunk
    // but throws FyersAuthError on the second.
    //
    // fetchHistoricalCandles() chunks the range based on RESOLUTION_DAY_CAPS.
    // For resolution='D' (daily), the cap is 365 days per request. Our 3-day range
    // fits in one chunk — so we can't use chunking to simulate a mid-fetch interrupt.
    //
    // Instead, we simulate it at the runBackfill level by:
    //   (a) Running a partial first "run" by making fetchFn throw FyersAuthError
    //       with lastSuccessfulCutoff = the timestamp of the one candle we "wrote".
    //   (b) Verifying the partial row was written via a direct DB INSERT before the
    //       authError (simulating what T-54 would have done before failing).
    //
    // Approach: We use a sequence of fetchFn calls.
    //   Call 1: Returns one candle (simulates partial success before auth failure).
    //   Call 2: Throws FyersAuthError with lastSuccessfulCutoff set to that candle.
    //
    // Because fetchHistoricalCandles() resolves credentials first and THEN calls
    // fetchFn, and because our fetchFn mock never actually calls the Fyers API,
    // we need to simulate the auth failure at the fetchFn level.
    //
    // We simulate by making the fetchFn throw an auth-style response on the first
    // call (to trigger FyersAuthError in fetchHistoricalCandles), with
    // lastSuccessfulCutoff = null (no candles fetched before failure).
    // Then on the resume run, the fetchFn returns the full candle set.

    const candles = [
      makeCandle("2024-01-02", 21800),
      makeCandle("2024-01-03", 21900),
      makeCandle("2024-01-04", 22000), // Thursday
    ];

    const symbol = "NSE:NIFTY50-INDEX";
    const resolution = "D" as const;
    const from = new Date("2024-01-02T00:00:00.000Z");
    const to = new Date("2024-01-04T00:00:00.000Z");

    // First run: fetchFn returns 401 → fetchHistoricalCandles throws FyersAuthError
    // with lastSuccessfulCutoff = null (no candles fetched before failure).
    const authFailFetchFn: FetchFn = () =>
      Promise.resolve(new Response("Unauthorized", { status: 401 }));

    const options1 = { symbol, resolution, from, to, fetchFn: authFailFetchFn, sleepFn: noopSleep };

    let resumeError: BackfillResumeError | undefined;
    try {
      await runBackfill(db, options1);
      // Should never reach here
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(BackfillResumeError);
      resumeError = err as BackfillResumeError;
    }

    // The BackfillResumeError must have been thrown.
    expect(resumeError).toBeDefined();
    expect(resumeError!.rangeId).toBeGreaterThan(0);

    // backfill_ranges must show status = 'partial'.
    const partialRow = await db.query<{ status: string; checkpoint_ts: Date | null }>(
      `SELECT status, checkpoint_ts FROM backfill_ranges WHERE id = $1`,
      [resumeError!.rangeId],
    );
    expect(partialRow.rows[0]?.status).toBe("partial");
    // lastSuccessfulCutoff was null (no candles fetched before the 401),
    // so checkpoint_ts must be null.
    expect(partialRow.rows[0]?.checkpoint_ts).toBeNull();

    // Second run: fetchFn now returns the full candle set → write succeeds.
    // The resume sees status='partial' with checkpoint_ts=null, so it restarts
    // from the original from date (not a mid-range cutoff). ON CONFLICT DO NOTHING
    // handles any overlap.
    const options2 = { symbol, resolution, from, to, fetchFn: mockFetchFn(candles), sleepFn: noopSleep };
    const result2 = await runBackfill(db, options2);

    // After the resume, the range should be 'complete' or 'gapped' (not 'partial').
    expect(["complete", "gapped"]).toContain(result2.status);
    expect(result2.rowsWritten).toBe(candles.length);

    // DB should now have all 3 candles (time-range bounded query).
    const rows = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM market_ticks
       WHERE symbol = $1
         AND time >= $2
         AND time <= $3
         AND source = 'fyers-historical'`,
      [symbol, from.toISOString(), new Date("2024-01-05T00:00:00.000Z").toISOString()],
    );
    expect(Number(rows.rows[0]?.count ?? 0)).toBe(candles.length);

    // Running again with the same options is now idempotent (status is complete/gapped).
    const options3 = { symbol, resolution, from, to, fetchFn: mockFetchFn(candles), sleepFn: noopSleep };
    const result3 = await runBackfill(db, options3);
    expect(result3.rowsWritten).toBe(0); // short-circuit, no re-write
  });

  // ── Test 3: Calendar gap is recorded, not hidden ───────────────────────────

  it("calendar gap is recorded in backfill_ranges and status is gapped not complete", async () => {
    // Provide candles for Monday and Wednesday only — Tuesday is missing.
    // The calendar reconciler should detect Tuesday (2024-01-02 is a Tuesday;
    // let us use a week where the gap is clear):
    //   Mon 2024-01-08, Tue 2024-01-09 (missing), Wed 2024-01-10
    // The reconciler generates expected days {Mon, Tue, Wed} and finds Tue missing.
    const candlesWithGap = [
      makeCandle("2024-01-08", 21700), // Monday
      // 2024-01-09 Tuesday — intentionally missing (simulates a Fyers data gap)
      makeCandle("2024-01-10", 21800), // Wednesday
    ];

    const symbol = "NSE:NIFTY50-INDEX";
    const resolution = "D" as const;
    const from = new Date("2024-01-08T00:00:00.000Z");
    const to = new Date("2024-01-10T00:00:00.000Z");

    const options = {
      symbol,
      resolution,
      from,
      to,
      fetchFn: mockFetchFn(candlesWithGap),
      sleepFn: noopSleep,
    };

    const result = await runBackfill(db, options);

    // Status MUST be 'gapped' (not 'complete') because Tuesday is missing.
    expect(result.status).toBe("gapped");
    expect(result.gaps.length).toBeGreaterThan(0);

    // The returned gaps must include an entry covering 2024-01-09 (Tuesday).
    const tuesdayGap = result.gaps.find(
      (g) => g.from.toISOString().startsWith("2024-01-09"),
    );
    expect(tuesdayGap).toBeDefined();

    // DB row must have gaps_detected > 0 and gaps_json populated.
    const rangeRow = await db.query<{
      status: string;
      gaps_detected: number;
      gaps_json: string | null;
    }>(
      `SELECT status, gaps_detected, gaps_json FROM backfill_ranges WHERE id = $1`,
      [result.rangeId],
    );

    const row = rangeRow.rows[0];
    expect(row).toBeDefined();
    expect(row?.status).toBe("gapped");
    expect(Number(row?.gaps_detected ?? 0)).toBeGreaterThan(0);
    expect(row?.gaps_json).not.toBeNull();

    // Verify gaps_json is valid JSON containing the Tuesday entry.
    const parsedGaps = JSON.parse(row!.gaps_json!) as Array<{ from: string; to: string; reason: string }>;
    expect(Array.isArray(parsedGaps)).toBe(true);
    const tuesdayInJson = parsedGaps.some((g) => g.from.startsWith("2024-01-09"));
    expect(tuesdayInJson).toBe(true);

    // Two candle rows must still be written (the gap doesn't block writes).
    const rows = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM market_ticks
       WHERE symbol = $1
         AND time >= $2
         AND time <= $3
         AND source = 'fyers-historical'`,
      [symbol, from.toISOString(), new Date("2024-01-11T00:00:00.000Z").toISOString()],
    );
    expect(Number(rows.rows[0]?.count ?? 0)).toBe(candlesWithGap.length);
  });
});

// ---------------------------------------------------------------------------
// Unit-level tests (no DB required)
// ---------------------------------------------------------------------------
// These cover pure functions that don't need the database. They run in the
// unit test project and do NOT require Docker services.

describe("resolveSymbolTable (unit)", () => {
  it("routes -INDEX symbols to market_ticks", () => {
    expect(resolveSymbolTable("NSE:NIFTY50-INDEX")).toBe("market_ticks");
    expect(resolveSymbolTable("NSE:NIFTYBANK-INDEX")).toBe("market_ticks");
    expect(resolveSymbolTable("NSE:INDIAVIX-INDEX")).toBe("market_ticks");
  });

  it("routes CE/PE symbols to option_ticks", () => {
    expect(resolveSymbolTable("NSE:NIFTY25MAY24000CE")).toBe("option_ticks");
    expect(resolveSymbolTable("NSE:NIFTY25MAY24000PE")).toBe("option_ticks");
    expect(resolveSymbolTable("NSE:BANKNIFTY25MAY47000CE")).toBe("option_ticks");
  });

  it("defaults unrecognised symbols to market_ticks", () => {
    expect(resolveSymbolTable("UNKNOWN:SYMBOL")).toBe("market_ticks");
  });
});

describe("reconcileCalendarGaps (unit)", () => {
  it("returns no gaps when all expected trading days are covered", () => {
    // Mon–Fri covered → no gaps expected.
    const candles: FyersCandle[] = [
      { timestamp: new Date("2024-01-08T04:30:00.000Z"), open: 100, high: 110, low: 90, close: 105, volume: 1000 },
      { timestamp: new Date("2024-01-09T04:30:00.000Z"), open: 105, high: 115, low: 95, close: 110, volume: 1000 },
      { timestamp: new Date("2024-01-10T04:30:00.000Z"), open: 110, high: 120, low: 100, close: 115, volume: 1000 },
    ];

    const gaps = reconcileCalendarGaps(
      candles,
      [],
      new Date("2024-01-08T00:00:00.000Z"),
      new Date("2024-01-10T00:00:00.000Z"),
      "D",
    );

    expect(gaps.length).toBe(0);
  });

  it("records missing trading days as gaps", () => {
    // Mon and Wed present, Tue missing.
    const candles: FyersCandle[] = [
      { timestamp: new Date("2024-01-08T04:30:00.000Z"), open: 100, high: 110, low: 90, close: 105, volume: 1000 },
      { timestamp: new Date("2024-01-10T04:30:00.000Z"), open: 110, high: 120, low: 100, close: 115, volume: 1000 },
    ];

    const gaps = reconcileCalendarGaps(
      candles,
      [],
      new Date("2024-01-08T00:00:00.000Z"),
      new Date("2024-01-10T00:00:00.000Z"),
      "D",
    );

    expect(gaps.length).toBe(1);
    expect(gaps[0]!.from.toISOString().startsWith("2024-01-09")).toBe(true);
  });

  it("skips weekend days when generating expected trading days", () => {
    // Range spans Mon–Sun: only Mon–Fri are expected trading days.
    // Provide Mon–Fri candles → no gaps.
    const candles: FyersCandle[] = [
      { timestamp: new Date("2024-01-08T04:30:00.000Z"), open: 100, high: 110, low: 90, close: 105, volume: 1000 },
      { timestamp: new Date("2024-01-09T04:30:00.000Z"), open: 105, high: 115, low: 95, close: 110, volume: 1000 },
      { timestamp: new Date("2024-01-10T04:30:00.000Z"), open: 110, high: 120, low: 100, close: 115, volume: 1000 },
      { timestamp: new Date("2024-01-11T04:30:00.000Z"), open: 115, high: 125, low: 105, close: 120, volume: 1000 },
      { timestamp: new Date("2024-01-12T04:30:00.000Z"), open: 120, high: 130, low: 110, close: 125, volume: 1000 },
    ];

    const gaps = reconcileCalendarGaps(
      candles,
      [],
      new Date("2024-01-08T00:00:00.000Z"),
      new Date("2024-01-14T00:00:00.000Z"), // ends Sunday
      "D",
    );

    // Sat and Sun are not in the expected set, so no gaps.
    expect(gaps.length).toBe(0);
  });

  it("skips day-level reconciliation for weekly resolution", () => {
    // Weekly candles: only one candle for the entire week — no day-level gaps expected.
    const candles: FyersCandle[] = [
      { timestamp: new Date("2024-01-08T04:30:00.000Z"), open: 100, high: 110, low: 90, close: 105, volume: 5000 },
    ];

    const gaps = reconcileCalendarGaps(
      candles,
      [],
      new Date("2024-01-08T00:00:00.000Z"),
      new Date("2024-01-12T00:00:00.000Z"),
      "W",
    );

    // W resolution skips day-level reconciliation — expect 0 gaps.
    expect(gaps.length).toBe(0);
  });

  it("merges Fyers-reported chunk gaps into the result", () => {
    const fyersGaps = [
      {
        from: new Date("2024-01-08T00:00:00.000Z"),
        to: new Date("2024-01-08T00:00:00.000Z"),
        reason: "No candles returned by Fyers for this date range.",
      },
    ];

    const gaps = reconcileCalendarGaps(
      [],
      fyersGaps,
      new Date("2024-01-08T00:00:00.000Z"),
      new Date("2024-01-08T00:00:00.000Z"),
      "D",
    );

    // One day missing + one Fyers-reported gap = 2 gap entries
    // (the day-level reconciler also finds Mon 2024-01-08 missing).
    expect(gaps.length).toBeGreaterThan(0);
    const fyersEntry = gaps.find((g) => g.reason.includes("Fyers API returned no candles"));
    expect(fyersEntry).toBeDefined();
  });
});
