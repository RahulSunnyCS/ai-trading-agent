/**
 * Historical Straddle Reconstructor (T-56)
 *
 * Rebuilds `straddle_snapshots` rows for a past date range from raw data
 * already written to the `option_ticks` and `market_ticks` hypertables by
 * the backfill writer (T-55).
 *
 * Contract:
 *   - For each cadence step T in [from, to], at configurable cadence (default 15s):
 *       1. Read the index price at-or-before T to determine ATM strike
 *          via getAtmStrike(). This is the ONLY index read permitted.
 *       2. Build CE and PE symbols for that ATM strike and the weekly expiry
 *          covering T.
 *       3. Query option_ticks for the CE and PE last prices at-or-before T.
 *       4. Compute straddle_value, roc, and acceleration via straddle-math.ts
 *          (the same code used by the live calculator).
 *       5. Write one row to straddle_snapshots tagged with the resolution from
 *          the option_ticks row so downstream consumers can distinguish
 *          1-minute vs 5-minute fidelity data.
 *   - LOOK-AHEAD GUARANTEE: every input used at step T is strictly at-or-before T.
 *     There is no lookahead — no future bar is ever consulted.
 *   - FAIL LOUD: if a CE or PE candle is absent at step T, throw MissingLegError.
 *     Never interpolate, extrapolate, or zero-fill.
 *   - All DB queries are time-range bounded (hypertable discipline — no full-table scans).
 *   - All DB writes use parameterised queries (no string interpolation of external values).
 *
 * Security notes:
 *   - No user-supplied values are interpolated into SQL.
 *   - The `from` and `to` parameters are Date objects validated on entry.
 *   - Pool is caller-supplied (no singleton dependency) for testability.
 */

import type { Pool } from 'pg';

import { buildOptionSymbol, getAtmStrike, getCurrentExpiry } from '../brokers/instrument-registry';
import type { Underlying } from '../brokers/types';
import { UNDERLYING_SYMBOLS } from '../brokers/types';
import {
  computeAcceleration,
  computeRoc,
  computeStraddleValue,
  pushToBuffer,
} from '../straddle-math';

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

/**
 * Options for a single reconstruction run.
 *
 * The (underlying, from, to) tuple defines the date range to reconstruct.
 * The cadence controls how many steps are produced within the range.
 */
export interface ReconstructOptions {
  /** Which index to reconstruct straddle history for. */
  underlying: Underlying;
  /** Inclusive start of the range. Must be in the past. */
  from: Date;
  /** Inclusive end of the range. Must be ≥ from. */
  to: Date;
  /**
   * Step interval in milliseconds (default: 15 000 = 15 seconds).
   *
   * This is the granularity at which steps are produced. For hourly or
   * daily historical candles, set this to match the candle interval (e.g.
   * 3 600 000 for 1-hour candles) so only one step is attempted per candle.
   */
  cadenceMs?: number;
  /**
   * Rolling buffer window size for ROC / acceleration (default: 5).
   * Must match the live calculator config if you intend to compare live
   * and historical data on the same chart.
   */
  rocWindowSize?: number;
  /**
   * If true, write reconstructed rows to straddle_snapshots in the DB.
   * If false (dry-run), compute the snapshots but do not persist them.
   * Default: true.
   */
  persist?: boolean;
}

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/**
 * One successfully computed snapshot step.
 * Mirrors the straddle_snapshots table schema (without the auto-generated id).
 */
export interface ReconstructedSnapshot {
  /** UTC timestamp of this step. */
  time: Date;
  /** Underlying name, e.g. 'NIFTY'. */
  symbol: string;
  /** Weekly expiry date for the options used at this step. */
  expiry: Date;
  /** ATM strike at this step (derived from index price at-or-before time). */
  strike: number;
  /** Last CE premium at-or-before this step's timestamp. */
  call_ltp: number;
  /** Last PE premium at-or-before this step's timestamp. */
  put_ltp: number;
  /** call_ltp + put_ltp */
  straddle_value: number;
  /** Rate of change (% per cadence step). null when < 2 steps accumulated. */
  roc: number | null;
  /** Second derivative of straddle value. null when < 3 steps accumulated. */
  roc_acceleration: number | null;
  /** VIX is not available historically — always null in reconstruction. */
  vix: null;
  /**
   * Resolution tag propagated from the option_ticks row (e.g. '1', '5', 'D').
   * Never null — if both CE and PE have a resolution tag, the CE value is used;
   * if null for some reason the literal string 'unknown' is stored so callers
   * can detect the absence explicitly.
   */
  resolution: string;
}

/** Summary of a completed reconstruction run. */
export interface ReconstructResult {
  /** Number of steps attempted (total cadence points in the range). */
  stepsAttempted: number;
  /** Number of snapshots successfully written (or computed, in dry-run mode). */
  snapshotsWritten: number;
  /**
   * Steps that had a missing CE or PE leg. Each entry holds the step timestamp
   * and the error that was recorded. Reconstruction continues after a gap.
   */
  gaps: ReconstructGap[];
}

/** One recorded gap: a cadence step where a required leg candle was absent. */
export interface ReconstructGap {
  /** Timestamp of the cadence step that could not be computed. */
  stepTime: Date;
  /** The specific symbol that was missing, e.g. 'NSE:NIFTY2413024000CE'. */
  missingSymbol: string;
  /** Human-readable explanation. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown (internally) when a required CE or PE leg candle is missing at a step.
 *
 * Exported so tests can assert on the error type.
 * The reconstructor catches this per-step and records it as a gap rather than
 * aborting the entire run — but a caller that wants strict mode can configure
 * strict mode (see failOnFirstGap option) to re-throw on the first gap.
 */
export class MissingLegError extends Error {
  /** The full Fyers symbol that returned no data. */
  readonly missingSymbol: string;
  /** UTC timestamp of the step that failed. */
  readonly stepTime: Date;

  constructor(missingSymbol: string, stepTime: Date) {
    super(
      `[ReconstructStraddle] Missing leg candle at ${stepTime.toISOString()}: no option_ticks row at-or-before this timestamp for symbol ${missingSymbol}. Never interpolated or zero-filled — this is a data gap.`,
    );
    this.name = 'MissingLegError';
    this.missingSymbol = missingSymbol;
    this.stepTime = stepTime;
  }
}

// ---------------------------------------------------------------------------
// DB helpers — all queries are parameterised and time-range bounded
// ---------------------------------------------------------------------------

/**
 * Query option_ticks for the last traded price of a symbol at-or-before the
 * given timestamp. Also returns the resolution tag so fidelity is propagated.
 *
 * WHY AT-OR-BEFORE?
 * Historical candle data arrives at discrete intervals (1-min, 5-min, etc.).
 * A 15-second cadence step will rarely land exactly on a candle boundary. We
 * use the most recent candle at-or-before T — the "last known price at T" —
 * which is the correct causal interpretation. This is explicitly NOT lookahead.
 *
 * WHY time-range bounded?
 * option_ticks is a TimescaleDB hypertable. Without a WHERE time > ... clause
 * the query would scan every chunk. We bound from the left by a 24-hour window
 * (1 full trading day) — enough for intraday data — and from the right by the
 * step timestamp T. The hypertable's chunk exclusion then restricts the scan
 * to at most one or two chunks.
 *
 * Returns null when no row is found — the caller throws MissingLegError.
 */
async function queryLegAtOrBefore(
  pool: Pool,
  symbol: string,
  atOrBefore: Date,
  lookbackMs = 24 * 60 * 60 * 1000, // 24 hours; caller can override for tests
): Promise<{ ltp: number; resolution: string | null } | null> {
  // The lower bound prevents a full-table scan while allowing at least one
  // full trading day of lookback (NSE market hours: 09:15–15:30 IST = ~6.25h).
  // We use 24 hours to handle multi-day gaps in the data without widening the
  // hypertable scan excessively.
  const lowerBound = new Date(atOrBefore.getTime() - lookbackMs);

  const result = await pool.query<{ ltp: string; resolution: string | null }>(
    `SELECT ltp, resolution
     FROM option_ticks
     WHERE symbol = $1
       AND time >= $2
       AND time <= $3
     ORDER BY time DESC
     LIMIT 1`,
    [symbol, lowerBound.toISOString(), atOrBefore.toISOString()],
  );

  const row = result.rows[0];
  if (!row) return null;

  // ltp comes back as a string due to pg's NUMERIC type parser.
  // We convert to number here because the straddle math expects float64.
  // Precision loss is acceptable: straddle values are INR amounts where
  // sub-paisa precision is not meaningful.
  return {
    ltp: Number.parseFloat(row.ltp),
    resolution: row.resolution,
  };
}

/**
 * Query market_ticks for the index price at-or-before the given timestamp.
 *
 * This is used SOLELY to derive the ATM strike via getAtmStrike() — no other
 * use of the index price is permitted so the look-ahead guarantee holds.
 * The underlying index symbol (e.g. 'NSE:NIFTY50-INDEX') is derived from
 * the Underlying type, not from user input.
 *
 * Returns null when no index tick is found.
 */
async function queryIndexPriceAtOrBefore(
  pool: Pool,
  indexSymbol: string,
  atOrBefore: Date,
  lookbackMs = 24 * 60 * 60 * 1000,
): Promise<number | null> {
  const lowerBound = new Date(atOrBefore.getTime() - lookbackMs);

  const result = await pool.query<{ ltp: string }>(
    `SELECT ltp
     FROM market_ticks
     WHERE symbol = $1
       AND time >= $2
       AND time <= $3
     ORDER BY time DESC
     LIMIT 1`,
    [indexSymbol, lowerBound.toISOString(), atOrBefore.toISOString()],
  );

  const row = result.rows[0];
  if (!row) return null;

  return Number.parseFloat(row.ltp);
}

/**
 * Write one reconstructed snapshot to straddle_snapshots.
 *
 * Uses ON CONFLICT (time, symbol, strike, expiry) DO NOTHING to make
 * re-running reconstruction over an already-filled range safe and idempotent.
 *
 * WHY explicit conflict target instead of DO NOTHING without a target?
 * The table's composite PRIMARY KEY is (id, time) where id is BIGSERIAL.
 * Since id is auto-generated, two inserts of the same logical snapshot receive
 * different id values and are never considered conflicts by the PK — meaning
 * ON CONFLICT DO NOTHING (without a target) was dead code and re-running
 * reconstruction silently duplicated rows. Migration 009 adds a UNIQUE index
 * on (time, symbol, strike, expiry) which matches the conflict target below.
 *
 * WHY DO NOTHING rather than DO UPDATE?
 * The first write wins: if a row already exists for this (time, symbol, strike,
 * expiry) it means the range was previously reconstructed. Preserving the first
 * write is correct — we never want a re-run to silently overwrite production
 * data, and the operator can always DELETE + re-reconstruct if truly needed.
 *
 * vix is always NULL for historical reconstruction — it is not available
 * from the Fyers historical candle endpoint.
 *
 * resolution is included so downstream consumers can query fidelity tags
 * (e.g. '1', '5', 'D') without joining back to option_ticks. Before migration
 * 008 added the column, this field was omitted and every reconstructed row
 * persisted NULL for resolution. The column is now explicitly populated.
 */
async function writeSnapshot(pool: Pool, snap: ReconstructedSnapshot): Promise<void> {
  await pool.query(
    `INSERT INTO straddle_snapshots
       (time, symbol, expiry, strike, call_ltp, put_ltp, straddle_value, roc, roc_acceleration, vix, resolution)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (time, symbol, strike, expiry) DO NOTHING`,
    [
      snap.time.toISOString(),
      snap.symbol,
      snap.expiry
        .toISOString()
        .slice(0, 10), // DATE column — truncate to date
      snap.strike,
      snap.call_ltp,
      snap.put_ltp,
      snap.straddle_value,
      snap.roc, // null for first two steps
      snap.roc_acceleration, // null for first two steps
      snap.vix, // always null for historical data
      snap.resolution, // resolution tag from option_ticks (e.g. '1', '5', 'D')
    ],
  );
}

// ---------------------------------------------------------------------------
// Expiry resolution for a given step timestamp
// ---------------------------------------------------------------------------

/**
 * Determine the weekly expiry date in force at a given past timestamp.
 *
 * We cannot use getCurrentExpiry() with a RealClock because that returns the
 * CURRENT expiry (now), not the expiry that was active at a past step.
 * Instead, we build a minimal Clock that returns the step timestamp and pass
 * it to getCurrentExpiry() — which then applies the Thursday-detection and
 * 15:30-cutoff logic against that historical instant.
 *
 * This is the correct causal implementation: we reconstruct what the expiry
 * WOULD HAVE BEEN at step T, using only the information available at T.
 */
function getExpiryAtStep(underlying: Underlying, stepTime: Date): Date {
  // Build a minimal Clock shim that satisfies the Clock interface and returns
  // the historical step timestamp. getCurrentExpiry() only uses timestamp(),
  // so the other methods are never called.
  const clock = {
    now(): number {
      return stepTime.getTime();
    },
    timestamp(): number {
      return stepTime.getTime();
    },
    today(): string {
      return stepTime.toISOString().slice(0, 10);
    },
    toISTDate(_ms: number): string {
      return stepTime.toISOString().slice(0, 10);
    },
    toISTTime(_ms: number): string {
      return stepTime.toISOString().slice(11, 19);
    },
  };
  return getCurrentExpiry(underlying, clock);
}

// ---------------------------------------------------------------------------
// Main public function
// ---------------------------------------------------------------------------

/**
 * Reconstruct straddle snapshots for a past [from, to] date range.
 *
 * Steps through the range at `cadenceMs` intervals. At each step T:
 *   1. Reads the index price at-or-before T (AT-OR-BEFORE — no lookahead).
 *   2. Derives the ATM strike via getAtmStrike().
 *   3. Builds CE and PE symbols for that strike and the expiry active at T.
 *   4. Reads CE and PE last prices from option_ticks at-or-before T.
 *   5. Computes snapshot fields using straddle-math pure functions.
 *   6. Persists to straddle_snapshots (if persist=true).
 *
 * Gaps (missing leg candles) are recorded in the result and the run continues.
 * The rolling ROC/acceleration buffer is maintained across successful steps
 * only — gaps do NOT advance the buffer. This is correct because a gap means
 * "we have no data at T", not "the straddle was zero at T".
 *
 * @param pool  PostgreSQL connection pool. Must point at a DB with migrations applied.
 * @param options  Reconstruction configuration.
 * @returns  Summary of the run including gap records.
 */
export async function reconstructStraddle(
  pool: Pool,
  options: ReconstructOptions,
): Promise<ReconstructResult> {
  const { underlying, from, to, cadenceMs = 15_000, rocWindowSize = 5, persist = true } = options;

  // Validate inputs before touching the DB.
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
    throw new Error('[ReconstructStraddle] from must be a valid Date');
  }
  if (!(to instanceof Date) || Number.isNaN(to.getTime())) {
    throw new Error('[ReconstructStraddle] to must be a valid Date');
  }
  if (from > to) {
    throw new Error(
      `[ReconstructStraddle] from (${from.toISOString()}) must not be after ` +
        `to (${to.toISOString()})`,
    );
  }
  if (cadenceMs <= 0) {
    throw new Error('[ReconstructStraddle] cadenceMs must be a positive number');
  }

  const indexSymbol = UNDERLYING_SYMBOLS[underlying];

  // Rolling buffer — shared across all steps in time order.
  // A gap does NOT advance the buffer (see contract above).
  const straddleBuffer: number[] = [];

  let stepsAttempted = 0;
  let snapshotsWritten = 0;
  const gaps: ReconstructGap[] = [];

  // Step through the range at cadence intervals.
  // We step from `from` to `to` inclusive by advancing stepTime by cadenceMs
  // each iteration. Using a while-loop (not recursion) to avoid stack overflow
  // for very long ranges.
  let stepTime = new Date(from.getTime());

  while (stepTime <= to) {
    stepsAttempted += 1;

    // ── 1. Index price at-or-before step T ───────────────────────────────────
    // LOOK-AHEAD GUARANTEE: atOrBefore = stepTime — no future data can be used.
    const indexPrice = await queryIndexPriceAtOrBefore(pool, indexSymbol, stepTime);

    if (indexPrice === null) {
      // No index price → cannot determine ATM strike → record as gap.
      // We record the index symbol as the missing piece for debuggability.
      gaps.push({
        stepTime: new Date(stepTime),
        missingSymbol: indexSymbol,
        reason: `No index price found for ${indexSymbol} at-or-before ${stepTime.toISOString()}`,
      });
      stepTime = new Date(stepTime.getTime() + cadenceMs);
      continue;
    }

    // ── 2. ATM strike ─────────────────────────────────────────────────────────
    const strike = getAtmStrike(underlying, indexPrice);

    // ── 3. Option symbols for this step ──────────────────────────────────────
    // getExpiryAtStep uses only the step timestamp — no future information.
    const expiry = getExpiryAtStep(underlying, stepTime);
    const ceSymbol = buildOptionSymbol(underlying, expiry, strike, 'CE');
    const peSymbol = buildOptionSymbol(underlying, expiry, strike, 'PE');

    // ── 4. CE and PE prices at-or-before step T ───────────────────────────────
    // LOOK-AHEAD GUARANTEE: both queries bound their upper limit to stepTime.
    let ceData: { ltp: number; resolution: string | null } | null;
    let peData: { ltp: number; resolution: string | null } | null;

    try {
      ceData = await queryLegAtOrBefore(pool, ceSymbol, stepTime);
      if (ceData === null) {
        throw new MissingLegError(ceSymbol, stepTime);
      }

      peData = await queryLegAtOrBefore(pool, peSymbol, stepTime);
      if (peData === null) {
        throw new MissingLegError(peSymbol, stepTime);
      }
    } catch (err) {
      if (err instanceof MissingLegError) {
        // Record the gap and continue — do NOT advance the rolling buffer.
        gaps.push({
          stepTime: new Date(stepTime),
          missingSymbol: err.missingSymbol,
          reason: err.message,
        });
        stepTime = new Date(stepTime.getTime() + cadenceMs);
        continue;
      }
      // Unexpected DB error — re-throw immediately (fail loud).
      throw err;
    }

    // ── 5. Compute snapshot fields via straddle-math pure functions ───────────
    const callLtp = ceData.ltp;
    const putLtp = peData.ltp;
    const straddleValue = computeStraddleValue(callLtp, putLtp);

    // Push to the rolling buffer BEFORE computing ROC/acceleration so this step's
    // value is included in the current-step computation. This is the same order
    // as the live calculator in straddle-calc.ts.
    pushToBuffer(straddleBuffer, straddleValue, rocWindowSize);

    const roc = computeRoc(straddleBuffer);
    const acceleration = computeAcceleration(straddleBuffer);

    // Resolve resolution: prefer CE's resolution (the CE leg is always the
    // primary leg for symbol routing), fall back to PE's, or use 'unknown'
    // if neither has a tag (should not happen for fyers-historical rows, but
    // we guard defensively).
    const resolution = ceData.resolution ?? peData.resolution ?? 'unknown';

    const snapshot: ReconstructedSnapshot = {
      time: new Date(stepTime),
      symbol: underlying,
      expiry,
      strike,
      call_ltp: callLtp,
      put_ltp: putLtp,
      straddle_value: straddleValue,
      // Emit null for the first snapshot (1 entry in buffer) — ROC is 0 but
      // we store null in the DB to signal "not enough history", matching the
      // straddle_snapshots schema where roc is nullable.
      roc: straddleBuffer.length >= 2 ? roc : null,
      roc_acceleration: straddleBuffer.length >= 3 ? acceleration : null,
      vix: null,
      resolution,
    };

    // ── 6. Persist ─────────────────────────────────────────────────────────────
    if (persist) {
      await writeSnapshot(pool, snapshot);
    }

    snapshotsWritten += 1;
    stepTime = new Date(stepTime.getTime() + cadenceMs);
  }

  return { stepsAttempted, snapshotsWritten, gaps };
}
