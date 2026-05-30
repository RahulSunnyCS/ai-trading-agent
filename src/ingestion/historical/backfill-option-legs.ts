/**
 * Option-leg historical backfill orchestrator.
 *
 * For a date range, downloads the ATM CE/PE option-leg candles that the
 * straddle reconstructor and replay harness need in option_ticks. The actual
 * per-symbol fetching is delegated to runBackfill() — this module only plans
 * "which legs over which days" using the already-backfilled intraday index
 * data in market_ticks.
 *
 * Algorithm (per call):
 *   1. Query market_ticks for the index symbol's intraday low/high per
 *      trading day in [from, to]. (Phase 2 must have populated this.)
 *   2. For each day with data, compute the ATM strike band
 *        [ATM(low) − bufferBelow*interval,  ATM(high) + bufferAbove*interval]
 *      and resolve the weekly expiry covering that day.
 *   3. Union the strikes per expiry-week → the unique set of contracts to
 *      fetch for that week.
 *   4. For each (expiry, strike, type) leg, runBackfill the leg's expiry-week
 *      window (clipped to [from, to]). runBackfill is idempotent (ON CONFLICT
 *      DO NOTHING) and resumable, so re-invoking the orchestrator is safe.
 *
 * Symbol-purge interaction:
 *   purgeStaleBackfillData scopes its delete to a single symbol. Each leg is a
 *   distinct symbol, so per-leg purge only ever touches that leg's own data —
 *   different legs do NOT clobber each other. No purgeStale flag is needed.
 *
 * Why expiry-week range vs per-day range:
 *   Each leg trades for ~1 week. Calling runBackfill once per leg over the
 *   full week is simpler than per-day, hits Fyers fewer times (1 call vs 5),
 *   and lets runBackfill's resume-from-checkpoint handle token-expiry mid-run.
 */

import type { Pool } from 'pg';

import type { FyersResolution } from '../brokers/fyers-historical';
import {
  EXCHANGE_BY_UNDERLYING,
  STRIKE_INTERVALS,
  type Underlying,
  buildOptionSymbol,
  getAtmStrike,
  getCurrentWeeklyExpiry,
} from '../brokers/instrument-registry';
import { UNDERLYING_SYMBOLS } from '../brokers/types';
import { type BackfillOptions, type BackfillResult, runBackfill } from './backfill';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One trading day's intraday OHLC slice, sourced from market_ticks. */
export interface DailyOHLC {
  /** Calendar date at UTC midnight. */
  day: Date;
  low: number;
  high: number;
}

/** One concrete option-leg backfill plan. */
export interface LegPlan {
  expiry: Date;
  strike: number;
  type: 'CE' | 'PE';
  symbol: string;
  /** Backfill window for this leg (typically expiry-week, clipped to run range). */
  from: Date;
  to: Date;
}

export interface OptionLegBackfillOptions {
  underlying: Underlying;
  /** Inclusive start of the run window (UTC). */
  from: Date;
  /** Inclusive end of the run window (UTC). */
  to: Date;
  resolution: FyersResolution;
  /**
   * Extra strikes to backfill ABOVE the day's intraday high (in strike-interval
   * units). 1 = one strike beyond. Default 1 — small buffer for edge moves
   * where the reconstructor's at-or-before lookup may land just past the high.
   */
  bufferStrikesAbove?: number;
  /** Extra strikes to backfill BELOW the day's intraday low. Default 1. */
  bufferStrikesBelow?: number;

  // ---- Dependency injection for tests (omit in production) -----------------

  /** Override the daily-OHLC query (production uses queryDailyOhlcFromMarketTicks). */
  queryDailyOHLC?: (db: Pool, indexSymbol: string, from: Date, to: Date) => Promise<DailyOHLC[]>;
  /** Override the per-leg backfill call (production uses runBackfill). */
  runBackfillFn?: (db: Pool, opts: BackfillOptions) => Promise<BackfillResult>;
}

export interface OptionLegBackfillSummary {
  legsAttempted: number;
  legsCompleted: number;
  /** Resumable failures (auth/checkpoint) — re-run the orchestrator after refresh. */
  legsPartial: Array<{ symbol: string; checkpointTs: Date | null }>;
  /** Non-resumable failures (invalid symbol, unexpected). */
  legsFailed: Array<{ symbol: string; error: string }>;
  /** Total candles written across all legs in this invocation. */
  totalRowsWritten: number;
  /** Unique expiry weeks covered. */
  expiriesProcessed: number;
  /** Planned legs (useful for dry-run / progress reporting). */
  plans: LegPlan[];
}

// ---------------------------------------------------------------------------
// Production query: intraday OHLC from market_ticks
// ---------------------------------------------------------------------------

/**
 * Read intraday low/high per UTC day for an index symbol from market_ticks.
 * Skips days with no rows (weekends / holidays).
 *
 * Source-agnostic: any non-null source (live, simulator, fyers-historical) is
 * acceptable — we only need price ranges. For Phase-3 the data comes from the
 * Phase-2 fyers-historical backfill.
 */
async function queryDailyOhlcFromMarketTicks(
  db: Pool,
  indexSymbol: string,
  from: Date,
  to: Date,
): Promise<DailyOHLC[]> {
  // Bound the time predicate (hypertable discipline — never full-table scan).
  const fromStart = utcMidnight(from);
  const toEnd = new Date(utcMidnight(to).getTime() + 24 * 60 * 60 * 1000 - 1);
  const result = await db.query<{ day: Date; low: string; high: string }>(
    `SELECT date_trunc('day', time) AS day,
            MIN(ltp)::text         AS low,
            MAX(ltp)::text         AS high
     FROM market_ticks
     WHERE symbol = $1
       AND time >= $2
       AND time <= $3
     GROUP BY day
     ORDER BY day`,
    [indexSymbol, fromStart.toISOString(), toEnd.toISOString()],
  );
  return result.rows.map((r) => ({
    day: utcMidnight(new Date(r.day)),
    low: Number.parseFloat(r.low),
    high: Number.parseFloat(r.high),
  }));
}

// ---------------------------------------------------------------------------
// Pure planning helpers (heavily unit-tested)
// ---------------------------------------------------------------------------

/**
 * From a set of daily-OHLC rows, produce one LegPlan per unique (expiry, strike,
 * type) tuple. Pure — no DB or network access.
 *
 * Window for each leg: the expiry week (from = expiry − 6 days, to = expiry),
 * clipped to the orchestrator's [runFrom, runTo].
 */
export function planLegs(
  daily: ReadonlyArray<DailyOHLC>,
  underlying: Underlying,
  runFrom: Date,
  runTo: Date,
  bufferAbove: number,
  bufferBelow: number,
): LegPlan[] {
  const interval = STRIKE_INTERVALS[underlying];

  // Group strikes by expiry ISO-date string for dedup.
  const strikesByExpiry: Map<string, Set<number>> = new Map();

  for (const { day, low, high } of daily) {
    const expiry = getCurrentWeeklyExpiry(underlying, day);
    const expiryKey = expiry.toISOString().slice(0, 10);

    // Compute the strike band touched today (rounded ATM at endpoints + buffer).
    const lowAtm = getAtmStrike(underlying, low);
    const highAtm = getAtmStrike(underlying, high);
    const bandLow = lowAtm - bufferBelow * interval;
    const bandHigh = highAtm + bufferAbove * interval;

    let set = strikesByExpiry.get(expiryKey);
    if (!set) {
      set = new Set<number>();
      strikesByExpiry.set(expiryKey, set);
    }
    for (let s = bandLow; s <= bandHigh; s += interval) {
      set.add(s);
    }
  }

  // Materialise LegPlans for every (expiry, strike, type).
  const plans: LegPlan[] = [];
  const runFromMs = utcMidnight(runFrom).getTime();
  const runToMs = utcMidnight(runTo).getTime();

  for (const [expiryKey, strikes] of strikesByExpiry) {
    const expiry = new Date(`${expiryKey}T00:00:00.000Z`);
    const expiryMs = expiry.getTime();
    const weekStartMs = expiryMs - 6 * 24 * 60 * 60 * 1000;
    const fromMs = Math.max(weekStartMs, runFromMs);
    const toMs = Math.min(expiryMs, runToMs);
    if (fromMs > toMs) continue; // expiry entirely outside run window (defensive)
    const from = new Date(fromMs);
    const to = new Date(toMs);

    const sortedStrikes = [...strikes].sort((a, b) => a - b);
    for (const strike of sortedStrikes) {
      for (const type of ['CE', 'PE'] as const) {
        plans.push({
          expiry,
          strike,
          type,
          symbol: buildOptionSymbol(underlying, expiry, strike, type),
          from,
          to,
        });
      }
    }
  }

  // Stable ordering: by expiry then strike then type.
  plans.sort((a, b) => {
    if (a.expiry.getTime() !== b.expiry.getTime()) {
      return a.expiry.getTime() - b.expiry.getTime();
    }
    if (a.strike !== b.strike) return a.strike - b.strike;
    return a.type.localeCompare(b.type);
  });

  return plans;
}

// ---------------------------------------------------------------------------
// Orchestrator entry point
// ---------------------------------------------------------------------------

/**
 * Plan + execute option-leg backfill for the underlying's ATM CE/PE legs over
 * the given window. Sequential per-leg execution (matches runBackfill's own
 * sequential chunking and respects Fyers rate limits).
 *
 * Throws only on programmer errors (invalid options) — per-leg failures are
 * captured in the summary so a long run is not aborted by a single bad symbol.
 */
export async function backfillOptionLegs(
  db: Pool,
  options: OptionLegBackfillOptions,
): Promise<OptionLegBackfillSummary> {
  const {
    underlying,
    from,
    to,
    resolution,
    bufferStrikesAbove = 1,
    bufferStrikesBelow = 1,
    queryDailyOHLC = queryDailyOhlcFromMarketTicks,
    runBackfillFn = runBackfill,
  } = options;

  if (from > to) {
    throw new Error(
      `backfillOptionLegs: 'from' (${from.toISOString()}) must not be after 'to' (${to.toISOString()})`,
    );
  }

  // --- 1. Read intraday low/high per day from market_ticks -----------------
  const indexSymbol = UNDERLYING_SYMBOLS[underlying];
  const daily = await queryDailyOHLC(db, indexSymbol, from, to);

  if (daily.length === 0) {
    const exchange = EXCHANGE_BY_UNDERLYING[underlying];
    throw new Error(
      `backfillOptionLegs: no intraday index data found for ${indexSymbol} (${exchange}) in [${from.toISOString().slice(0, 10)}, ${to.toISOString().slice(0, 10)}]. Run the index backfill (Phase 2) first.`,
    );
  }

  // --- 2. Plan ------------------------------------------------------------
  const plans = planLegs(daily, underlying, from, to, bufferStrikesAbove, bufferStrikesBelow);

  const expiriesProcessed = new Set(plans.map((p) => p.expiry.toISOString().slice(0, 10))).size;

  console.log(
    `[OptionLegOrch] ${underlying}: ${daily.length} trading days → ` +
      `${expiriesProcessed} expiries → ${plans.length} legs to backfill ` +
      `(${plans.length / 2} strikes × 2 types).`,
  );

  // --- 3. Execute, accumulating results ------------------------------------
  const summary: OptionLegBackfillSummary = {
    legsAttempted: 0,
    legsCompleted: 0,
    legsPartial: [],
    legsFailed: [],
    totalRowsWritten: 0,
    expiriesProcessed,
    plans,
  };

  let i = 0;
  for (const p of plans) {
    i += 1;
    summary.legsAttempted += 1;
    console.log(
      `[OptionLegOrch]   leg ${i}/${plans.length}  ${p.symbol}  ${p.from.toISOString().slice(0, 10)}..${p.to.toISOString().slice(0, 10)}`,
    );
    try {
      const r = await runBackfillFn(db, {
        symbol: p.symbol,
        resolution,
        from: p.from,
        to: p.to,
      });
      // 'complete' or 'gapped' both count as success — gaps are intrinsic.
      if (r.status === 'complete' || r.status === 'gapped') {
        summary.legsCompleted += 1;
        summary.totalRowsWritten += r.rowsWritten;
      } else if (r.status === 'partial') {
        // FyersAuthError checkpoint propagated as a returned status by some paths.
        summary.legsPartial.push({ symbol: p.symbol, checkpointTs: null });
      } else {
        summary.legsFailed.push({ symbol: p.symbol, error: `status=${r.status}` });
      }
    } catch (err) {
      // BackfillResumeError (auth expiry mid-run) — record as partial; caller
      // refreshes the token and re-runs the orchestrator to resume.
      const isResume = err instanceof Error && err.constructor.name === 'BackfillResumeError';
      if (isResume) {
        summary.legsPartial.push({
          symbol: p.symbol,
          checkpointTs: (err as unknown as { checkpointTs: Date | null }).checkpointTs,
        });
        // Stop the whole run — every subsequent leg would hit the same stale token.
        console.warn(
          `[OptionLegOrch] auth expired on ${p.symbol} — stopping. Refresh FYERS_ACCESS_TOKEN and re-run; idempotent legs will short-circuit.`,
        );
        break;
      }
      summary.legsFailed.push({
        symbol: p.symbol,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  console.log(
    `[OptionLegOrch] done: ${summary.legsCompleted}/${summary.legsAttempted} legs OK, ` +
      `${summary.legsPartial.length} partial, ${summary.legsFailed.length} failed, ` +
      `${summary.totalRowsWritten} candles written.`,
  );

  return summary;
}

// ---------------------------------------------------------------------------
// Tiny date helper
// ---------------------------------------------------------------------------

function utcMidnight(d: Date): Date {
  const r = new Date(d.getTime());
  r.setUTCHours(0, 0, 0, 0);
  return r;
}
