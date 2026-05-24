/**
 * Pure P&L computation functions for the trading dashboard.
 *
 * All functions take PaperTrade[] and return plain values — no React, no
 * fetch, no side effects.  This makes them trivially testable and reusable
 * across components or server-side scripts if needed.
 *
 * Money math safety:
 *  - All NUMERIC DB fields arrive as `string | null`.
 *  - We use `toNumberOrNull` from format.ts for every coercion.
 *  - A null / NaN result is SKIPPED (not treated as 0) in sums and win-rate
 *    counts, so malformed rows never silently pull totals toward zero.
 *
 * Timezone correctness:
 *  - "Today" is always IST, not UTC.  We delegate to `istToday` from format.ts
 *    which uses `Intl.DateTimeFormat` with `timeZone: 'Asia/Kolkata'`.
 *  - An optional `today` parameter lets tests inject a specific IST date
 *    string (YYYY-MM-DD) so the IST-boundary logic is verifiable without
 *    relying on wall-clock time.
 */

import type { PaperTrade } from '../types/trading.js';
import { istToday, toNumberOrNull } from './format.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single point in the cumulative P&L series.
 *
 * Shape matches what Lightweight Charts `LineData` expects:
 *  - `time`  : ISO-8601 date string (YYYY-MM-DD) derived from exit_time in
 *              IST.  Lightweight Charts also accepts a UNIX timestamp (seconds)
 *              but ISO date strings work naturally here and avoid the ms/s
 *              confusion with `UTCTimestamp`.
 *  - `value` : running cumulative net P&L up to and including this point.
 *
 * Note: multiple trades may share the same IST exit date.  Each trade produces
 * its own point (the running total at the moment it closed).  Lightweight
 * Charts handles duplicate time keys by replacing earlier values with later
 * ones for the same key, so if two trades close on the same day the last one
 * wins.  This is intentional: the chart is a "last value of the day" view,
 * not a tick-level chart.  If intraday resolution is needed later, switch
 * time to a UNIX timestamp.
 */
export interface PnlSeriesPoint {
  time: string; // YYYY-MM-DD in IST
  value: number; // cumulative net P&L at this point
}

/**
 * All P&L aggregates for a trade set.
 * Returned by `computePnlSummary` as a single object so callers destructure
 * what they need without calling multiple functions.
 */
export interface PnlSummary {
  /** Sum of net_pnl over ALL closed trades (null values skipped). */
  totalRealizedPnl: number;
  /** Sum of net_pnl over closed trades that exited IST-today (null skipped). */
  todayRealizedPnl: number;
  /**
   * Winners (net_pnl > 0) / closed-count.
   * 0 when there are no closed trades (guard against divide-by-zero).
   */
  winRate: number;
  /** Count of trades with status === 'open'. */
  openCount: number;
  /** Count of trades with status === 'closed'. */
  closedCount: number;
  /**
   * Cumulative-P&L series for closed trades ordered by exit_time ascending.
   * Each point's `value` is the running total at that point.
   * Trades with null exit_time or null net_pnl are excluded.
   */
  cumulativeSeries: PnlSeriesPoint[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Derive the IST calendar date (YYYY-MM-DD) from an ISO-8601 exit_time string.
 *
 * We reuse the same Intl-based approach as `istToday` so both functions agree
 * on where day boundaries fall (IST midnight = UTC 18:30 the previous day).
 *
 * Returns null if the input is null (open trades have no exit_time).
 */
function exitTimeToIstDate(exitTime: string): string {
  // Re-use istToday's internal logic by passing the parsed Date.
  // This means the timezone handling is identical — no separate offset math.
  return istToday(new Date(exitTime));
}

// ---------------------------------------------------------------------------
// Exported pure functions
// ---------------------------------------------------------------------------

/**
 * Compute all P&L aggregates in a single pass over the trades array.
 *
 * @param trades  The trade list from usePaperTrades (may be empty).
 * @param today   Optional IST date string (YYYY-MM-DD) used as "today" for
 *                the today-realized filter.  Defaults to `istToday()` (wall
 *                clock).  Inject a fixed value in tests for determinism.
 */
export function computePnlSummary(trades: PaperTrade[], today?: string): PnlSummary {
  // Resolve today once so every trade comparison uses the same reference.
  // Default: real wall-clock IST date.
  const istDate = today ?? istToday();

  let totalRealizedPnl = 0;
  let todayRealizedPnl = 0;
  let winnerCount = 0;
  let openCount = 0;
  let closedCount = 0;

  // We build the series in a second pass (after sorting) so keep raw closed
  // trades for that step.
  const closedTrades: PaperTrade[] = [];

  for (const trade of trades) {
    if (trade.status === 'open') {
      openCount++;
      // Open trades never contribute to realized P&L — no exit_time means no
      // exit event.  We count them but skip all P&L math.
      continue;
    }

    // status === 'closed'
    closedCount++;
    closedTrades.push(trade);

    const pnl = toNumberOrNull(trade.net_pnl);

    // Skip null/NaN — never count as 0.  A malformed or missing value should
    // not move the total toward zero, and it should not count as a win or loss.
    if (pnl === null) continue;

    totalRealizedPnl += pnl;

    if (pnl > 0) winnerCount++;

    // Today filter: only closed trades whose exit_time falls on IST-today.
    // exit_time is null for open trades but we already skipped those above.
    if (trade.exit_time !== null) {
      const tradeDate = exitTimeToIstDate(trade.exit_time);
      if (tradeDate === istDate) {
        todayRealizedPnl += pnl;
      }
    }
  }

  // Divide-by-zero guard: if no closed trades, win rate is 0 (not NaN).
  const winRate = closedCount === 0 ? 0 : winnerCount / closedCount;

  // Build the cumulative series.
  // We sort closed trades by exit_time ascending to get chronological order.
  // Trades with null exit_time are excluded (cannot plot without a timestamp).
  const cumulativeSeries = buildCumulativeSeries(closedTrades);

  return {
    totalRealizedPnl,
    todayRealizedPnl,
    winRate,
    openCount,
    closedCount,
    cumulativeSeries,
  };
}

/**
 * Build a cumulative P&L series from closed trades.
 *
 * Sorting rationale: we sort by exit_time ascending because the series must be
 * monotonically increasing in time for Lightweight Charts.  Passing an
 * unsorted array to `lineSeries.setData` causes a runtime error.
 *
 * Null exit_time exclusion: a closed trade with no exit_time is a data
 * integrity anomaly — we skip it rather than inventing a timestamp.
 *
 * Null net_pnl exclusion: same as the main aggregates — skip, never treat
 * as 0.  This means the running sum reflects only trades with valid P&L data.
 */
function buildCumulativeSeries(closedTrades: PaperTrade[]): PnlSeriesPoint[] {
  // Filter to only trades that have both an exit_time and a valid net_pnl.
  const plottable = closedTrades.filter(
    (t): t is PaperTrade & { exit_time: string } =>
      t.exit_time !== null && toNumberOrNull(t.net_pnl) !== null,
  );

  // Sort ascending by exit_time (ISO-8601 strings sort lexicographically
  // correctly, so string comparison is sufficient and avoids Date construction).
  plottable.sort((a, b) => a.exit_time.localeCompare(b.exit_time));

  let runningTotal = 0;
  const series: PnlSeriesPoint[] = [];

  for (const trade of plottable) {
    // toNumberOrNull is non-null here because we already filtered above, but
    // the assertion is needed to satisfy TypeScript's strict null checks.
    const pnl = toNumberOrNull(trade.net_pnl) as number;
    runningTotal += pnl;

    series.push({
      // Use IST date for the chart's horizontal axis so day boundaries align
      // with Indian market hours.  Multiple trades on the same IST day will
      // produce multiple points with the same date — Lightweight Charts renders
      // the last one at that x position, which is the correct EOD cumulative.
      time: exitTimeToIstDate(trade.exit_time),
      value: runningTotal,
    });
  }

  return series;
}
