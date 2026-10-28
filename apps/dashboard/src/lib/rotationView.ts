/**
 * The Rotation page's pure view logic (BL-058 Phase 4): which benchmark a headline number is
 * set against, the hero chart's series, and the read-out banner. No React, so it is unit-tested.
 *
 * Everything is gross, in ₹. Lists are alternative baskets, never added together. Per lot-day is
 * the unit that compares lists, because a list holds 3 strategies, or 4 on a day its Buy add-on
 * fires. The page asks for rupee totals at 1 lot a strategy (`lots=1`); the per-lot figures are
 * the same at any lots.
 */

import type {
  RotationBase,
  RotationListKey,
  RotationListStats,
  RotationSummary,
} from '../types/rotation';
import { VISIBLE_LIST_KEYS, isVisibleList, listName } from './rotationListNames';

/** The lists the page shows (`VISIBLE_LIST_KEYS`); the read-out still carries all four. */
export const LIST_KEYS: readonly RotationListKey[] = VISIBLE_LIST_KEYS;

export type RotationBenchmark = 'REF' | 'base' | 'random';

/** The benchmarks the picker offers: Baseline (REF) only while that list is shown. */
export const BENCHMARKS: readonly RotationBenchmark[] = isVisibleList('REF')
  ? ['base', 'REF', 'random']
  : ['base', 'random'];

export const BENCHMARK_LABEL: Record<RotationBenchmark, string> = {
  REF: listName('REF'),
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
  /** The drawdown of the per-lot series: what the registered rule compares. */
  maxDrawdownPerLot: number | null;
  perLotDay: number | null;
  /** Lots the benchmark holds a day (a list: 6, or 8 on Buy days; the base: 6). */
  lotsPerDay: number | null;
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
      label: listName('REF'),
      total: ref?.total ?? null,
      maxDrawdown: ref?.max_drawdown ?? null,
      maxDrawdownPerLot: ref?.max_drawdown_per_lot ?? null,
      perLotDay: ref?.per_lot_day ?? null,
      lotsPerDay: ref?.lots_per_day ?? null,
      beatsRandom: ref?.beats_random_pct ?? null,
    };
  }
  if (pick === 'base') {
    const b: RotationBase | null = summary.base;
    return {
      label: 'Base',
      total: b?.total ?? null,
      maxDrawdown: b?.max_drawdown ?? null,
      maxDrawdownPerLot: b?.max_drawdown_per_lot ?? null,
      perLotDay: b?.per_lot_day ?? null,
      lotsPerDay: b?.lots_per_day ?? null,
      beatsRandom: null,
    };
  }
  const f = summary.lists[focus];
  const days = summary.n_days;
  return {
    label: 'Random median',
    total: f?.random.p50 ?? null,
    maxDrawdown: null,
    maxDrawdownPerLot: null,
    lotsPerDay: f?.lots_per_day ?? null,
    perLotDay: f && f.lots_per_day > 0 && days > 0 ? f.random.p50 / (f.lots_per_day * days) : null,
    beatsRandom: 50,
  };
}

/** "1 lot", "2 lots": the lots a strategy behind the read-out's rupee totals (the page asks for
 * 1; the registered read-out holds 2). Unknown is the registered 2. */
export function lotsWord(n: number | null | undefined): string {
  const v = typeof n === 'number' && n > 0 ? n : 2;
  return `${v} lot${v === 1 ? '' : 's'}`;
}

export interface VerdictLine {
  /** What is being compared, e.g. "Adaptive minus the fixed base". */
  label: string;
  mean: number;
  lower: number;
  upper: number;
  /** Only the base has a pass rule; REF is shown as a difference. */
  rule: null | { drawdownNoWorse: boolean; beats: boolean };
}

export interface Verdict {
  readable: boolean;
  nDays: number;
  minDays: number;
  lines: VerdictLine[];
}

/** The registered comparisons for the focus list, in ₹ per lot-day with their 90% intervals. */
export function verdict(summary: RotationSummary, focus: RotationListKey, minDays = 10): Verdict {
  const f = summary.lists[focus];
  const lines: VerdictLine[] = [];
  if (f) {
    // The fixed base first: it is what the page compares with by default and it carries the rule.
    lines.push({
      label: `${listName(focus)} minus the fixed base`,
      mean: f.vs_base.mean,
      lower: f.vs_base.lower,
      upper: f.vs_base.upper,
      rule: { drawdownNoWorse: f.vs_base.drawdown_no_worse, beats: f.vs_base.beats_base },
    });
    if (f.vs_ref && isVisibleList('REF'))
      lines.push({ label: `${listName(focus)} minus ${listName('REF')}`, ...f.vs_ref, rule: null });
  }
  return { readable: summary.n_days >= minDays, nDays: summary.n_days, minDays, lines };
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
  /** Cumulative 2-lot gross per shown list; the base is a line of its own. */
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

/** The index of the point nearest to x in a series of `n` evenly spaced points over [x0, x1]. */
export function nearestIndex(x: number, x0: number, x1: number, n: number): number {
  if (n <= 1) return 0;
  const t = (x - x0) / (x1 - x0);
  return Math.min(n - 1, Math.max(0, Math.round(t * (n - 1))));
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
