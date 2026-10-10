/**
 * The Rotation page's pure view logic (BL-058 Phase 4): which benchmark a headline number is
 * set against, the hero chart's series, and the read-out banner. No React, so it is unit-tested.
 *
 * Everything is gross, in ₹. Lists are alternative baskets, never added together. Per lot-day is
 * the unit that compares lists, because a list holds 6 lots, or 8 on a day its Buy add-on fires.
 */

import type {
  RotationBase,
  RotationListKey,
  RotationListStats,
  RotationSummary,
} from '../types/rotation';

export const LIST_KEYS: readonly RotationListKey[] = ['A', 'B', 'C', 'REF'];

export type RotationBenchmark = 'REF' | 'base' | 'random';

export const BENCHMARK_LABEL: Record<RotationBenchmark, string> = {
  REF: 'REF',
  base: 'Fixed base',
  random: 'Random median',
};

export const BENCHMARK_NOTE: Record<RotationBenchmark, string> = {
  REF: 'The live rule before the new weightings: did they beat it?',
  base: '2 × Widesl OTM1 09:17 + 1 × Dir ATM 09:24 every day, no ranking: does rotating beat the simple rule?',
  random: '1,000 random baskets of the same shape each day: does the list beat luck at all?',
};

export interface BenchmarkFigures {
  label: string;
  total: number | null;
  maxDrawdown: number | null;
  perLotDay: number | null;
  /** Share of random baskets the benchmark itself beats; null where that does not apply. */
  beatsRandom: number | null;
}

/** The figures a headline is compared with, for the benchmark the reader picked. */
export function benchmarkFigures(
  summary: RotationSummary,
  pick: RotationBenchmark,
  focus: RotationListKey,
): BenchmarkFigures {
  if (pick === 'REF') {
    const ref = summary.lists.REF;
    return {
      label: 'REF',
      total: ref?.total ?? null,
      maxDrawdown: ref?.max_drawdown ?? null,
      perLotDay: ref?.per_lot_day ?? null,
      beatsRandom: ref?.beats_random_pct ?? null,
    };
  }
  if (pick === 'base') {
    const b: RotationBase | null = summary.base;
    return {
      label: 'Base',
      total: b?.total ?? null,
      maxDrawdown: b?.max_drawdown ?? null,
      perLotDay: b?.per_lot_day ?? null,
      beatsRandom: null,
    };
  }
  const f = summary.lists[focus];
  const days = summary.n_days;
  return {
    label: 'Random median',
    total: f?.random.p50 ?? null,
    maxDrawdown: null,
    perLotDay: f && f.lots_per_day > 0 && days > 0 ? f.random.p50 / (f.lots_per_day * days) : null,
    beatsRandom: 50,
  };
}

export type HeadlineTone = 'positive' | 'negative' | 'default';

export interface HeadlineFigure {
  id: 'total' | 'drawdown' | 'perLotDay' | 'random' | 'sessions';
  label: string;
  value: number;
  unit: 'inr' | 'pct' | 'count';
  /** The benchmark's own figure, or null where there is none to compare. */
  benchmark: number | null;
  /** value - benchmark, in the figure's unit. */
  gap: number | null;
  /** Whether a positive gap is good: a drawdown nearer zero is, so the sign flips there. */
  tone: HeadlineTone;
  hint: string;
}

function toneOf(gap: number | null, higherIsBetter = true): HeadlineTone {
  if (gap === null || gap === 0) return 'default';
  return gap > 0 === higherIsBetter ? 'positive' : 'negative';
}

/** The five numbers that say whether the focus list is good, each against the benchmark. */
export function headline(
  summary: RotationSummary,
  focus: RotationListKey,
  pick: RotationBenchmark,
  readoutDays: number,
): HeadlineFigure[] {
  const f: RotationListStats | undefined = summary.lists[focus];
  if (!f) return [];
  const b = benchmarkFigures(summary, pick, focus);
  const gap = (v: number, ref: number | null) => (ref === null ? null : v - ref);
  return [
    {
      id: 'total',
      label: 'Cumulative gross',
      value: f.total,
      unit: 'inr',
      benchmark: b.total,
      gap: gap(f.total, b.total),
      tone: toneOf(gap(f.total, b.total)),
      hint: `At ${f.lots_per_day} lots a day on average. Totals are not comparable across lists that hold different lots; use per lot-day for that.`,
    },
    {
      id: 'drawdown',
      label: 'Max drawdown',
      value: f.max_drawdown,
      unit: 'inr',
      benchmark: b.maxDrawdown,
      gap: gap(f.max_drawdown, b.maxDrawdown),
      // drawdowns are negative: a larger (nearer zero) value is the better one
      tone: toneOf(gap(f.max_drawdown, b.maxDrawdown)),
      hint: 'The largest fall of the cumulative gross from its running peak, the peak starting at zero.',
    },
    {
      id: 'perLotDay',
      label: '₹ per lot-day',
      value: f.per_lot_day,
      unit: 'inr',
      benchmark: b.perLotDay,
      gap: gap(f.per_lot_day, b.perLotDay),
      tone: toneOf(gap(f.per_lot_day, b.perLotDay)),
      hint: 'Average gross per lot per day: the fair way to compare a 6-lot and an 8-lot day.',
    },
    {
      id: 'random',
      label: 'Beats random baskets',
      value: f.beats_random_pct,
      unit: 'pct',
      benchmark: b.beatsRandom,
      gap: gap(f.beats_random_pct, b.beatsRandom),
      tone: toneOf(gap(f.beats_random_pct, b.beatsRandom)),
      hint: 'Share of 1,000 random same-shape baskets (3 strategies, at least 2 Widesl, the list’s own Buy add-on) this list’s cumulative gross is above.',
    },
    {
      id: 'sessions',
      label: 'Sessions scored',
      value: summary.n_days,
      unit: 'count',
      benchmark: readoutDays,
      gap: null,
      tone: 'default',
      hint: 'Scored forward sessions against the registered read-out point.',
    },
  ];
}

/** How far through the registered read-out the forward test is. */
export function readoutProgress(
  n: number,
  total: number,
): { n: number; total: number; fraction: number; done: boolean } {
  const fraction = total > 0 ? Math.min(1, Math.max(0, n / total)) : 0;
  return { n, total, fraction, done: n >= total };
}

export interface HeroPoint {
  day: string;
  base: number;
  /** Cumulative 2-lot gross per list; REF and the base are lines of their own. */
  lists: Partial<Record<RotationListKey, number>>;
  band: { p10: number; p50: number; p90: number } | null;
}

/** Cumulative series for the hero chart, one point per scored day. The band is the focus list's. */
export function heroSeries(summary: RotationSummary, focus: RotationListKey): HeroPoint[] {
  const rows = summary.days ?? [];
  const keys = LIST_KEYS.filter((k) => summary.lists[k]);
  const run: Record<string, number> = {};
  let baseRun = 0;
  const band = summary.lists[focus]?.random_path ?? null;
  return rows.map((row, i) => {
    const lists: Partial<Record<RotationListKey, number>> = {};
    for (const k of keys) {
      const v = row[`${k}_total`];
      run[k] = (run[k] ?? 0) + (typeof v === 'number' ? v : 0);
      lists[k] = run[k];
    }
    baseRun += row.base_total;
    return {
      day: row.day,
      base: baseRun,
      lists,
      band: band ? { p10: band.p10[i] ?? 0, p50: band.p50[i] ?? 0, p90: band.p90[i] ?? 0 } : null,
    };
  });
}

/** Tooltip placement: centred about 40 px below the cursor, flipped above near the bottom edge,
 *  clamped at the sides (Analytics page pattern, rule 7). All numbers are in the chart's box. */
export function tooltipPlacement(
  cursor: { x: number; y: number },
  tip: { w: number; h: number },
  box: { w: number; h: number },
  gap = 40,
): { left: number; top: number } {
  const left = Math.min(Math.max(cursor.x - tip.w / 2, 4), Math.max(4, box.w - tip.w - 4));
  const below = cursor.y + gap;
  const top = below + tip.h > box.h ? Math.max(4, cursor.y - gap - tip.h) : below;
  return { left, top };
}

/** The index of the point nearest to x in a series of `n` evenly spaced points over [x0, x1]. */
export function nearestIndex(x: number, x0: number, x1: number, n: number): number {
  if (n <= 1) return 0;
  const t = (x - x0) / (x1 - x0);
  return Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))));
}

export function startLabel(start: string): string {
  return start;
}

/** Axis ticks at round rupee values covering [min, max], at most about `count` of them. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  const lo = Math.min(min, 0);
  const hi = Math.max(max, 0);
  const span = hi - lo || 1;
  const rough = span / Math.max(1, count - 1);
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag;
  const out: number[] = [];
  const end = Math.ceil(hi / step) * step;
  for (let t = Math.floor(lo / step) * step; t <= end + 1e-9; t += step) out.push(Math.round(t));
  return out;
}
