/**
 * Joins a strategy's per-day P&L to the market's day type (legwise/anatomy.py), to
 * answer "when does this strategy work?".
 *
 * Source-agnostic on purpose: it takes plain `{day, net}` rows, so saved leg-wise
 * results today — and re-run AlgoTest-history (DSL) sessions later — use the same code.
 *
 * Two lenses, kept separate because they mean different things:
 *   - SAME DAY ("today's label"): explanatory. The label is only known after the day.
 *   - LAG 1 ("previous day's label"): the only reading you could act on in advance.
 */

import type { DayAnatomy } from '../types/legwise';

export type Lens = 'same' | 'lag1';

export interface PnlDay {
  day: string;
  /** ₹ per lot. */
  net: number;
}

export interface Bucket {
  label: string;
  n: number;
  mean: number | null;
  /** Share of days with net > 0. */
  winRate: number | null;
  total: number;
}

/** A bucket with fewer days than this is shown greyed — it is an anecdote, not a pattern. */
export const MIN_BUCKET_N = 5;

function labelOf(a: DayAnatomy | undefined, series: number): string | null {
  const s = a ? (series < 0 ? a.whole : a.segments[series]) : null;
  return s && s.label !== 'UNKNOWN' ? s.label : null;
}

/**
 * Group `pnl` days by the day-type label of `series` (-1 = whole day, else a segment
 * index). `lag1` uses the previous COLLECTED index day's label — a day with no
 * predecessor is dropped, never matched to a stale or invented one.
 */
export function bucketByLabel(
  pnl: PnlDay[],
  anatomy: DayAnatomy[],
  series: number,
  lens: Lens,
  states: string[],
): Bucket[] {
  const sorted = [...anatomy].sort((a, b) => a.day.localeCompare(b.day));
  const idx = new Map(sorted.map((a, i) => [a.day, i]));
  const groups = new Map<string, number[]>(states.map((s) => [s, []]));

  for (const row of pnl) {
    const i = idx.get(row.day);
    if (i === undefined) continue;
    const anchor = lens === 'same' ? sorted[i] : i > 0 ? sorted[i - 1] : undefined;
    const label = labelOf(anchor, series);
    if (label === null) continue;
    groups.get(label)?.push(row.net);
  }

  return states.map((label) => {
    const xs = groups.get(label) ?? [];
    const total = xs.reduce((a, b) => a + b, 0);
    return {
      label,
      n: xs.length,
      mean: xs.length ? total / xs.length : null,
      winRate: xs.length ? xs.filter((x) => x > 0).length / xs.length : null,
      total,
    };
  });
}

export interface ScatterPoint {
  day: string;
  x: number;
  y: number;
}

/** Day ₹/lot against how much the market moved relative to VIX (range ÷ implied range). */
export function scatterPoints(
  pnl: PnlDay[],
  anatomy: DayAnatomy[],
  series: number,
): ScatterPoint[] {
  const byDay = new Map(anatomy.map((a) => [a.day, a]));
  const out: ScatterPoint[] = [];
  for (const row of pnl) {
    const a = byDay.get(row.day);
    const s = a ? (series < 0 ? a.whole : a.segments[series]) : null;
    if (s && s.range_over_implied !== null)
      out.push({ day: row.day, x: s.range_over_implied, y: row.net });
  }
  return out;
}

export interface ProxyPoint {
  time: string;
  /** Rolling sum, in % of spot. */
  value: number;
}

/**
 * Market-only stand-ins for the two styles, over the FULL index history (not just the
 * days a strategy ran). They are proxies, not P&L:
 *   - short premium: implied move − |realised move|   (a straddle seller's payoff shape)
 *   - directional:   efficiency ratio × |realised move| (rewards a big move that stayed clean)
 * Rolling sums over `window` days; a day missing the series is skipped.
 */
export function styleProxies(
  anatomy: DayAnatomy[],
  series: number,
  window: number,
): { premium: ProxyPoint[]; directional: ProxyPoint[] } {
  const premium: { day: string; v: number }[] = [];
  const directional: { day: string; v: number }[] = [];
  for (const a of anatomy) {
    const s = series < 0 ? a.whole : a.segments[series];
    if (!s || s.implied_pct === null) continue;
    premium.push({ day: a.day, v: s.implied_pct - Math.abs(s.ret_pct) });
    directional.push({ day: a.day, v: s.er * Math.abs(s.ret_pct) });
  }
  const roll = (xs: { day: string; v: number }[]): ProxyPoint[] =>
    xs.flatMap((_, i) =>
      i + 1 < window
        ? []
        : [
            {
              time: (xs[i] as { day: string }).day,
              value: xs.slice(i + 1 - window, i + 1).reduce((acc, x) => acc + x.v, 0),
            },
          ],
    );
  return { premium: roll(premium), directional: roll(directional) };
}

/**
 * Standardise a series against ITS OWN history (mean 0, sd 1) so two proxies in different
 * units can share an axis. Loses the absolute level on purpose: the question is only
 * whether the two take turns. A flat series (sd 0) maps to all zeros, never NaN.
 */
export function zscore(points: ProxyPoint[]): ProxyPoint[] {
  if (points.length === 0) return [];
  const mean = points.reduce((a, p) => a + p.value, 0) / points.length;
  const sd = Math.sqrt(points.reduce((a, p) => a + (p.value - mean) ** 2, 0) / points.length);
  return points.map((p) => ({ time: p.time, value: sd > 0 ? (p.value - mean) / sd : 0 }));
}
