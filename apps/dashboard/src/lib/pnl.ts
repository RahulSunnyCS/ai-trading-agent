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
 *    which formats with the `Asia/Kolkata` time zone.
 *  - An optional `today` parameter lets tests inject a specific IST date
 *    string (YYYY-MM-DD) so the IST-boundary logic is verifiable without
 *    relying on wall-clock time.
 */

import type { PaperTrade, Personality } from '../types/trading';
import { istToday, toNumberOrNull } from './format';

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
 * One point per IST day: trades that close on the same day are folded into a
 * single end-of-day cumulative value.  Lightweight Charts requires strictly
 * ascending time keys and throws on a duplicate day, so the series must never
 * carry two points for one date.  If intraday resolution is needed later,
 * switch time to a UNIX timestamp.
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
   * Cumulative-P&L series for closed trades, one point per IST exit day in
   * ascending order.  Each point's `value` is the running total at the end of
   * that day.  Trades with null exit_time or null net_pnl are excluded.
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
 * Build a cumulative P&L series from closed trades, one point per IST day.
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

    // Use IST date for the chart's horizontal axis so day boundaries align
    // with Indian market hours.  A later trade on the same IST day overwrites
    // that day's point, leaving one end-of-day cumulative value per date.
    const time = exitTimeToIstDate(trade.exit_time);
    const last = series[series.length - 1];
    if (last !== undefined && last.time === time) {
      last.value = runningTotal;
    } else {
      series.push({ time, value: runningTotal });
    }
  }

  return series;
}

// ---------------------------------------------------------------------------
// BL-013 Phase 8: range, daily bars, risk metrics, per-personality table
//
// Same money-math rules as above: a closed trade whose net_pnl is null / NaN is skipped (never
// counted as 0), and every day is an IST calendar day of the exit.
// ---------------------------------------------------------------------------

export const PNL_RANGES = ['7d', '30d', '90d', 'all'] as const;
export type PnlRange = (typeof PNL_RANGES)[number];

const RANGE_DAYS: Record<Exclude<PnlRange, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90 };

export function parsePnlRange(raw: string | null | undefined): PnlRange {
  return PNL_RANGES.find((range) => range === raw) ?? 'all';
}

/** YYYY-MM-DD minus `days` calendar days (no time zone involved: the input is already a day). */
function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/** The first IST day a range covers (today counts as one of its days); null for 'all'. */
export function rangeStartDay(range: PnlRange, today: string = istToday()): string | null {
  return range === 'all' ? null : shiftDay(today, RANGE_DAYS[range] - 1);
}

/**
 * The trades a range covers: closed trades whose IST exit day falls in the window, plus every
 * open trade (an open position is "now", which every window includes). A closed trade with no
 * exit_time is kept only by 'all'.
 */
export function filterTradesByRange(
  trades: readonly PaperTrade[],
  range: PnlRange,
  today: string = istToday(),
): PaperTrade[] {
  const start = rangeStartDay(range, today);
  if (start === null) return [...trades];
  return trades.filter((trade) => {
    if (trade.status === 'open') return true;
    if (trade.exit_time === null) return false;
    const day = exitTimeToIstDate(trade.exit_time);
    return day >= start && day <= today;
  });
}

/** Closed trades with a usable exit_time and net_pnl, as (day, net) pairs in exit order. */
function closedNets(trades: readonly PaperTrade[]): Array<{ day: string; net: number }> {
  const out: Array<{ day: string; exit: string; net: number }> = [];
  for (const trade of trades) {
    if (trade.status !== 'closed' || trade.exit_time === null) continue;
    const net = toNumberOrNull(trade.net_pnl);
    if (net === null) continue;
    out.push({ day: exitTimeToIstDate(trade.exit_time), exit: trade.exit_time, net });
  }
  out.sort((a, b) => a.exit.localeCompare(b.exit));
  return out.map(({ day, net }) => ({ day, net }));
}

export interface DailyPnlPoint {
  /** IST exit day, YYYY-MM-DD (Lightweight Charts' business-day key). */
  time: string;
  /** Net P&L of the trades that closed that day. */
  value: number;
  /** How many trades closed that day (with a usable net_pnl). */
  trades: number;
}

/** One bar per IST exit day, ascending; days with no closed trade are not listed. */
export function computeDailyPnl(trades: readonly PaperTrade[]): DailyPnlPoint[] {
  const days: DailyPnlPoint[] = [];
  for (const { day, net } of closedNets(trades)) {
    const last = days[days.length - 1];
    if (last !== undefined && last.time === day) {
      last.value += net;
      last.trades += 1;
    } else {
      days.push({ time: day, value: net, trades: 1 });
    }
  }
  return days;
}

export interface Drawdown {
  /** The largest fall from a running peak of end-of-day cumulative P&L, in ₹ (≥ 0). */
  amount: number;
  /** The day the running peak was set (null when the peak is the starting zero). */
  peakDay: string | null;
  /** The day the deepest point was reached; null when there was no drawdown. */
  troughDay: string | null;
}

/**
 * Maximum drawdown over end-of-day cumulative P&L, measured from a starting balance of zero, so
 * a first losing day counts as a drawdown from the start.
 */
export function computeMaxDrawdown(daily: readonly DailyPnlPoint[]): Drawdown {
  let equity = 0;
  let peak = 0;
  let peakDay: string | null = null;
  let worst: Drawdown = { amount: 0, peakDay: null, troughDay: null };
  for (const point of daily) {
    equity += point.value;
    if (equity > peak) {
      peak = equity;
      peakDay = point.time;
    }
    const drop = peak - equity;
    if (drop > worst.amount) worst = { amount: drop, peakDay, troughDay: point.time };
  }
  return worst;
}

export interface PnlStats {
  /** Closed trades with a usable net_pnl. */
  tradeCount: number;
  wins: number;
  losses: number;
  /** Sum of winning trades' net P&L. */
  grossProfit: number;
  /** Sum of losing trades' net P&L, as a positive number. */
  grossLoss: number;
  /** grossProfit ÷ grossLoss; null when there is no losing trade (undefined, not infinite). */
  profitFactor: number | null;
  /** Mean net P&L of winning trades; null with none. */
  avgWin: number | null;
  /** Mean net P&L of losing trades (negative); null with none. */
  avgLoss: number | null;
  /** Mean net P&L per trade; null with no trades. */
  expectancy: number | null;
  bestDay: DailyPnlPoint | null;
  worstDay: DailyPnlPoint | null;
  maxDrawdown: Drawdown;
  daily: DailyPnlPoint[];
}

/** Risk and distribution metrics over the closed trades in `trades` (open ones are ignored). */
export function computePnlStats(trades: readonly PaperTrade[]): PnlStats {
  let wins = 0;
  let losses = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let total = 0;
  const nets = closedNets(trades);
  for (const { net } of nets) {
    total += net;
    if (net > 0) {
      wins += 1;
      grossProfit += net;
    } else if (net < 0) {
      losses += 1;
      grossLoss += -net;
    }
  }
  const daily = computeDailyPnl(trades);
  let bestDay: DailyPnlPoint | null = null;
  let worstDay: DailyPnlPoint | null = null;
  for (const point of daily) {
    if (bestDay === null || point.value > bestDay.value) bestDay = point;
    if (worstDay === null || point.value < worstDay.value) worstDay = point;
  }
  return {
    tradeCount: nets.length,
    wins,
    losses,
    grossProfit,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    avgWin: wins > 0 ? grossProfit / wins : null,
    avgLoss: losses > 0 ? -grossLoss / losses : null,
    expectancy: nets.length > 0 ? total / nets.length : null,
    bestDay,
    worstDay,
    maxDrawdown: computeMaxDrawdown(daily),
    daily,
  };
}

// ---------------------------------------------------------------------------
// Per-personality P&L with Beat-Clockwork Δ
// ---------------------------------------------------------------------------

/** The frozen benchmark personality: the one named Clockwork, else the first frozen one. */
export function findClockwork<P extends Pick<Personality, 'id' | 'name' | 'is_frozen'>>(
  personalities: readonly P[],
): P | null {
  return (
    personalities.find((p) => p.name.trim().toLowerCase() === 'clockwork') ??
    personalities.find((p) => p.is_frozen) ??
    null
  );
}

export interface PersonalityPnlRow {
  /** personality_configs.id, or null for trades with no (or an unknown) personality. */
  personalityId: string | null;
  name: string;
  isClockwork: boolean;
  /** Closed trades in the window. */
  trades: number;
  wins: number;
  /** wins ÷ closed trades (the same definition as computePnlSummary's winRate). */
  winRate: number;
  /** Sum of net P&L (null values skipped). */
  net: number;
  /**
   * net − Clockwork's net over the same trades. Null for Clockwork itself, and for everyone when
   * Clockwork is unknown or closed no trade in the window (a comparison with nothing).
   */
  beatClockwork: number | null;
}

/**
 * One row per personality with at least one closed trade in `trades`, plus "Unassigned" for
 * trades whose personality_id is null or not in `personalities`. Rows are ordered by net,
 * highest first.
 */
export function computePersonalityPnl(
  trades: readonly PaperTrade[],
  personalities: readonly Personality[],
): PersonalityPnlRow[] {
  const byId = new Map(personalities.map((p) => [p.id, p]));
  const clockwork = findClockwork(personalities);
  const buckets = new Map<string | null, { trades: number; wins: number; net: number }>();

  for (const trade of trades) {
    if (trade.status !== 'closed') continue;
    const rawId = trade.personality_id ?? null;
    const id = rawId !== null && byId.has(rawId) ? rawId : null;
    const bucket = buckets.get(id) ?? { trades: 0, wins: 0, net: 0 };
    bucket.trades += 1;
    const net = toNumberOrNull(trade.net_pnl);
    if (net !== null) {
      bucket.net += net;
      if (net > 0) bucket.wins += 1;
    }
    buckets.set(id, bucket);
  }

  const clockworkBucket = clockwork ? buckets.get(clockwork.id) : undefined;
  const benchmark = clockworkBucket ? clockworkBucket.net : null;

  const rows: PersonalityPnlRow[] = [];
  for (const [id, bucket] of buckets) {
    const personality = id === null ? undefined : byId.get(id);
    const isClockwork = clockwork !== null && id === clockwork.id;
    rows.push({
      personalityId: id,
      name: personality ? personality.display_name || personality.name : 'Unassigned',
      isClockwork,
      trades: bucket.trades,
      wins: bucket.wins,
      winRate: bucket.trades === 0 ? 0 : bucket.wins / bucket.trades,
      net: bucket.net,
      beatClockwork: isClockwork || benchmark === null ? null : bucket.net - benchmark,
    });
  }
  return rows.sort((a, b) => b.net - a.net);
}

export type PersonalitySortKey = 'name' | 'trades' | 'winRate' | 'net' | 'beatClockwork';

export interface PersonalitySort {
  key: PersonalitySortKey;
  dir: 'asc' | 'desc';
}

export const DEFAULT_PERSONALITY_SORT: PersonalitySort = { key: 'net', dir: 'desc' };

/** Sorted copy; a null Δ goes last in both directions and ties keep the input order. */
export function sortPersonalityPnl(
  rows: readonly PersonalityPnlRow[],
  sort: PersonalitySort,
): PersonalityPnlRow[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      if (sort.key === 'name') {
        const cmp = a.row.name.localeCompare(b.row.name);
        return cmp !== 0 ? cmp * sign : a.index - b.index;
      }
      const av = a.row[sort.key];
      const bv = b.row[sort.key];
      if (av === null || bv === null) {
        if (av === bv) return a.index - b.index;
        return av === null ? 1 : -1;
      }
      return av !== bv ? (av - bv) * sign : a.index - b.index;
    })
    .map((entry) => entry.row);
}

export function nextPersonalitySort(
  current: PersonalitySort,
  key: PersonalitySortKey,
): PersonalitySort {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'name' ? 'asc' : 'desc' };
}
