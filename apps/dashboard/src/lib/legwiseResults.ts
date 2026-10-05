/**
 * Options Lab › Daily results: the pure parts of the page (date-range filter, which
 * underlying a set of strategies trades, the strategy comparison table's rows and sorting,
 * and the sparkline geometry). No React and no chart library, so it runs under the
 * dashboard's node vitest env. Per-day statistics themselves stay in `legwiseStats.ts`.
 */

import { type StrategyStats, statsOf } from './legwiseStats';

// ---------------------------------------------------------------------------
// Date range
// ---------------------------------------------------------------------------

/** Inclusive ISO days ("2026-10-05"). A blank or missing end is open. */
export interface DayRange {
  from?: string | undefined;
  to?: string | undefined;
}

export function hasRange(range: DayRange): boolean {
  return Boolean(range.from) || Boolean(range.to);
}

/**
 * The rows whose `day` falls inside `range`, both ends inclusive. ISO days compare as
 * strings. A range typed backwards (from after to) is read as the same span, not as empty.
 */
export function filterByRange<T extends { day: string }>(rows: readonly T[], range: DayRange): T[] {
  let from = range.from || undefined;
  let to = range.to || undefined;
  if (from && to && from > to) [from, to] = [to, from];
  return rows.filter((r) => (!from || r.day >= from) && (!to || r.day <= to));
}

/** The distinct days of `rows`, newest first. */
export function daysOf(rows: readonly { day: string }[]): string[] {
  return [...new Set(rows.map((r) => r.day))].sort((a, b) => b.localeCompare(a));
}

// ---------------------------------------------------------------------------
// Underlying
// ---------------------------------------------------------------------------

/**
 * The underlyings the shown strategies trade, most strategies first (ties by name), so the
 * first entry is the sensible default. A strategy with no known underlying is not counted.
 */
export function underlyingsOf(
  strategyIds: readonly string[],
  underlyingById: ReadonlyMap<string, string>,
): string[] {
  const counts = new Map<string, number>();
  for (const id of strategyIds) {
    const u = underlyingById.get(id);
    if (u) counts.set(u, (counts.get(u) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([u]) => u);
}

/**
 * The strategies to show for `underlying`. One whose underlying is unknown (its file is not
 * in the saved list) stays visible under every choice instead of disappearing.
 */
export function strategiesFor<T extends { id: string }>(
  strategies: readonly T[],
  underlyingById: ReadonlyMap<string, string>,
  underlying: string | null,
): T[] {
  if (underlying === null) return [...strategies];
  return strategies.filter((s) => (underlyingById.get(s.id) ?? underlying) === underlying);
}

// ---------------------------------------------------------------------------
// Comparison table
// ---------------------------------------------------------------------------

export interface ComparisonInput {
  id: string;
  name: string;
  sha: string;
  /** The strategy's "one lot" (legwiseStats.lotsOf). */
  lots: number;
  /** Current-version results only, already filtered to the date range. */
  days: readonly { day: string; net: number; worst_mtm: number }[];
}

export interface ComparisonRow {
  id: string;
  name: string;
  sha: string;
  /** Position in the input list: the strategy's series colour everywhere on the page. */
  colorIndex: number;
  stats: StrategyStats;
  /** The deepest intraday mark-to-market on any day, ₹ per lot. null with no days. */
  worstMtm: number | null;
}

export function comparisonRows(inputs: readonly ComparisonInput[]): ComparisonRow[] {
  return inputs.map((s, colorIndex) => {
    const lots = s.lots > 0 ? s.lots : 1;
    return {
      id: s.id,
      name: s.name,
      sha: s.sha,
      colorIndex,
      stats: statsOf([...s.days], lots),
      worstMtm: s.days.length ? Math.min(...s.days.map((d) => d.worst_mtm / lots)) : null,
    };
  });
}

export type SortKey =
  | 'name'
  | 'days'
  | 'total'
  | 'up'
  | 'winRate'
  | 'expectancy'
  | 'profitFactor'
  | 'worst'
  | 'worstMtm'
  | 'maxDrawdown';

export type SortDir = 'asc' | 'desc';

export interface SortState {
  key: SortKey;
  dir: SortDir;
}

/** Ranked by Net / lot, best first. */
export const DEFAULT_SORT: SortState = { key: 'total', dir: 'desc' };

function sortValue(row: ComparisonRow, key: SortKey): number | string | null {
  switch (key) {
    case 'name':
      return row.name;
    case 'worstMtm':
      return row.worstMtm;
    default:
      // A strategy with no days has a 0 total; rank it as "no value", not as break-even.
      return row.stats.days === 0 && key !== 'days' ? null : row.stats[key];
  }
}

/**
 * A sorted copy. Rows with no value for the column (null: no days, or no losing day for
 * profit factor) go last in BOTH directions, and ties keep the input order.
 */
export function sortComparison(rows: readonly ComparisonRow[], sort: SortState): ComparisonRow[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, value: sortValue(row, sort.key) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        if (a.value === b.value) return a.index - b.index;
        return a.value === null ? 1 : -1;
      }
      const cmp =
        typeof a.value === 'string' || typeof b.value === 'string'
          ? String(a.value).localeCompare(String(b.value))
          : a.value - b.value;
      return cmp !== 0 ? cmp * sign : a.index - b.index;
    })
    .map((x) => x.row);
}

/**
 * The sort after a header click: the same column flips direction; a new column starts
 * descending (biggest first), except the name, which starts A to Z.
 */
export function nextSort(current: SortState, key: SortKey): SortState {
  if (current.key === key) return { key, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { key, dir: key === 'name' ? 'asc' : 'desc' };
}

export function ariaSort(current: SortState, key: SortKey): 'ascending' | 'descending' | 'none' {
  if (current.key !== key) return 'none';
  return current.dir === 'asc' ? 'ascending' : 'descending';
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

export interface Sparkline {
  /** SVG path data for the line, or '' with no points. */
  path: string;
  /** y of the zero line inside the box (the line starts from zero), or null with no points. */
  zeroY: number | null;
}

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * A cumulative series as an SVG path inside a `width` × `height` box with `pad` px kept
 * clear on every side. The line starts from zero (before the first day), so one day still
 * draws a segment and the picture reads as "from flat to here". A flat series sits mid-box.
 */
export function sparkline(
  values: readonly number[],
  width: number,
  height: number,
  pad = 2,
): Sparkline {
  if (values.length === 0) return { path: '', zeroY: null };
  const series = [0, ...values];
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min;
  const innerW = width - 2 * pad;
  const innerH = height - 2 * pad;
  const x = (i: number) => round1(pad + (i / (series.length - 1)) * innerW);
  const y = (v: number) => round1(span === 0 ? height / 2 : pad + ((max - v) / span) * innerH);
  const path = series.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)} ${y(v)}`).join(' ');
  return { path, zeroY: y(0) };
}

// ---------------------------------------------------------------------------
// Day grid
// ---------------------------------------------------------------------------

/** "Expiry" on an expiry day, the days-to-expiry count otherwise, null when unknown. */
export function dteText(
  a: { dte: number | null; is_expiry: boolean | null } | undefined,
): string | null {
  if (!a || a.dte === null) return null;
  return a.is_expiry ? 'Expiry' : String(a.dte);
}

/** Segment captions from the cut times: ['09:15–10:30', '10:30–13:30', '13:30–15:30']. */
export function segmentNames(cuts: readonly string[]): string[] {
  const edges = ['09:15', ...cuts, '15:30'];
  return edges.slice(1).map((end, i) => `${edges[i]}–${end}`);
}
