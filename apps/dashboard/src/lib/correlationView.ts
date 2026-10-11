/**
 * Pure helpers for Options Lab › Correlation (BL-090). The statistics are computed by the
 * Python package (`analytics/correlation.py`, the same code `obt rotation corr` runs); this file
 * only chooses what to ask for and how to read the answer: the selector text, the heatmap's
 * colour bands, the order, and short plain-words summaries. No `Math.random`, no network.
 */

import type {
  CorrelationMatrix,
  CorrelationMeasure,
  CorrelationResponse,
  CorrelationRollingRow,
} from '../types/legwise';

export const ANY = 'any';

/** What the filters bar holds. `names` are strategies added by hand on top of the filter. */
export interface CorrelationFilters {
  slot: string;
  family: string;
  index: string;
  kind: string;
  names: string[];
}

/** 09:17 across both indices and every family: the rotation's first slot, ten strategies. */
export const DEFAULT_FILTERS: CorrelationFilters = {
  slot: '0917',
  family: ANY,
  index: ANY,
  kind: ANY,
  names: [],
};

/**
 * The `selectors` text the API takes. The filters are one AND group (`slot:0917+index:N`);
 * names added by hand are separate selectors, so they join the group's strategies. With
 * nothing chosen at all it is `all`, which the API refuses when it is too many to compare.
 */
export function buildSelectors(f: CorrelationFilters): string {
  // Slot, family and index describe rotation variants; a live strategy has none of them, so with
  // Kind = live they are ignored (ANDing them in would match nothing).
  const variantOnly = f.kind !== 'legwise';
  const group = (
    [
      ['slot', variantOnly ? f.slot : ANY],
      ['family', variantOnly ? f.family : ANY],
      ['index', variantOnly ? f.index : ANY],
      ['kind', f.kind],
    ] as const
  )
    .filter(([, value]) => value !== ANY && value !== '')
    .map(([key, value]) => `${key}:${value}`)
    .join('+');
  const parts = [...(group ? [group] : f.names.length === 0 ? ['all'] : []), ...f.names];
  return parts.join(',');
}

/** "0917" → "09:17"; anything else is returned as it came. */
export function slotLabel(slot: string): string {
  return /^\d{4}$/.test(slot) ? `${slot.slice(0, 2)}:${slot.slice(2)}` : slot;
}

const FAMILY_LABEL: Record<string, string> = {
  wide: 'Widesl (all, incl. closest premium)',
  dir: 'Dir (all)',
  buy: 'Buy',
  ditm1: 'Dir ITM1',
};

/** A family token as a reader would say it: `p80` is Widesl at closest premium 80. */
export function familyLabel(token: string): string {
  const fixed = FAMILY_LABEL[token];
  if (fixed) return fixed;
  const premium = /^p(\d+)$/.exec(token);
  return premium ? `Widesl, closest premium ${premium[1]}` : token;
}

// --- the heatmap's colour bands -----------------------------------------------------------

/** 4 = very alike ... 0 = unrelated ... -2 = clearly opposite; 'na' = cannot be computed. */
export type Band = 4 | 3 | 2 | 1 | 0 | -1 | -2 | 'na';

export function bandOf(value: number | null | undefined): Band {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'na';
  if (value >= 0.8) return 4;
  if (value >= 0.6) return 3;
  if (value >= 0.4) return 2;
  if (value >= 0.2) return 1;
  if (value > -0.2) return 0;
  if (value > -0.4) return -1;
  return -2;
}

/** SVG fill per band. Alike is the primary tint; opposite is series-2, never positive/negative
 * (those mean profit and loss elsewhere on the page). */
export const BAND_FILL: Record<string, string> = {
  '4': 'fill-primary/70',
  '3': 'fill-primary/50',
  '2': 'fill-primary/30',
  '1': 'fill-primary/15',
  '0': 'fill-surface-2',
  '-1': 'fill-series-2/20',
  '-2': 'fill-series-2/40',
  na: 'fill-border',
};

/** The same bands as background classes, for the legend. */
export const BAND_BG: Record<string, string> = {
  '4': 'bg-primary/70',
  '3': 'bg-primary/50',
  '2': 'bg-primary/30',
  '1': 'bg-primary/15',
  '0': 'bg-surface-2',
  '-1': 'bg-series-2/20',
  '-2': 'bg-series-2/40',
  na: 'bg-border',
};

export const LEGEND: { band: Band; label: string }[] = [
  { band: -2, label: 'opposite' },
  { band: -1, label: 'a little opposite' },
  { band: 0, label: 'unrelated' },
  { band: 1, label: 'a little alike' },
  { band: 2, label: 'alike' },
  { band: 3, label: 'very alike' },
  { band: 4, label: 'near copies' },
];

// --- reading a response -----------------------------------------------------------------------

export const MEASURE_LABEL: Record<CorrelationMeasure, string> = {
  pearson: 'Daily P&L',
  spearman: 'Rank of daily P&L',
  loss: 'Loss days',
};

/** What each matrix says, in one sentence a reader can act on. */
export const MEASURE_NOTE: Record<CorrelationMeasure, string> = {
  pearson:
    'How closely two strategies’ daily P&L rise and fall together. 1 = always, 0 = unrelated, −1 = opposite.',
  spearman: 'The same on ranks, so a few huge days do not decide it.',
  loss: 'Pearson on the days either lost: do they crash together?',
};

export function matrixOf(r: CorrelationResponse, measure: CorrelationMeasure): CorrelationMatrix {
  return measure === 'pearson' ? r.pearson : measure === 'spearman' ? r.spearman : r.loss_corr;
}

/** Rows and columns of `m` (and `names`) in `order`; an order that is not a permutation is ignored. */
export function reorder<T>(
  m: (T | null)[][],
  names: readonly string[],
  order: readonly number[],
): { m: (T | null)[][]; names: string[]; index: number[] } {
  const k = names.length;
  const valid =
    order.length === k && new Set(order).size === k && order.every((i) => i >= 0 && i < k);
  const index = valid ? [...order] : names.map((_, i) => i);
  return {
    m: index.map((i) => index.map((j) => m[i]?.[j] ?? null)),
    names: index.map((i) => names[i] ?? ''),
    index,
  };
}

function upper(m: CorrelationMatrix): { i: number; j: number; v: number }[] {
  const out: { i: number; j: number; v: number }[] = [];
  for (let i = 0; i < m.length; i++) {
    for (let j = i + 1; j < m.length; j++) {
      const v = m[i]?.[j];
      if (typeof v === 'number' && Number.isFinite(v)) out.push({ i, j, v });
    }
  }
  return out;
}

/** Mean correlation over all pairs, or null with fewer than two strategies. */
export function averagePairwise(m: CorrelationMatrix): number | null {
  const pairs = upper(m);
  return pairs.length === 0 ? null : pairs.reduce((s, p) => s + p.v, 0) / pairs.length;
}

export interface PairRef {
  a: string;
  b: string;
  value: number;
}

/** The most alike and the least alike pair (ties: the earlier pair). */
export function extremePairs(
  m: CorrelationMatrix,
  names: readonly string[],
): { alike: PairRef | null; apart: PairRef | null } {
  let alike: PairRef | null = null;
  let apart: PairRef | null = null;
  for (const { i, j, v } of upper(m)) {
    const ref = { a: names[i] ?? '', b: names[j] ?? '', value: v };
    if (alike === null || v > alike.value) alike = ref;
    if (apart === null || v < apart.value) apart = ref;
  }
  return { alike, apart };
}

/** How many pairs sit at or above `cut`, of all pairs. */
export function pairsAtOrAbove(m: CorrelationMatrix, cut: number): { n: number; of: number } {
  const pairs = upper(m);
  return { n: pairs.filter((p) => p.v >= cut).length, of: pairs.length };
}

export interface PairReadout {
  a: string;
  b: string;
  pearson: number | null;
  spearman: number | null;
  lossCorr: number | null;
  /** Of the days a lost, the share b lost too, and the reverse. */
  bLostWhenALost: number | null;
  aLostWhenBLost: number | null;
  daysALost: number;
  daysBLost: number;
  daysBothLost: number;
  days: number;
}

export function pairReadout(r: CorrelationResponse, i: number, j: number): PairReadout {
  return {
    a: r.names[i] ?? '',
    b: r.names[j] ?? '',
    pearson: r.pearson[i]?.[j] ?? null,
    spearman: r.spearman[i]?.[j] ?? null,
    lossCorr: r.loss_corr[i]?.[j] ?? null,
    bLostWhenALost: r.loss_overlap[i]?.[j] ?? null,
    aLostWhenBLost: r.loss_overlap[j]?.[i] ?? null,
    daysALost: r.both_lose_days[i]?.[i] ?? 0,
    daysBLost: r.both_lose_days[j]?.[j] ?? 0,
    daysBothLost: r.both_lose_days[i]?.[j] ?? 0,
    days: r.n_days,
  };
}

/** Words for the basket-drawdown ratio: below 1 the basket draws down less than its parts. */
export function diversificationNote(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return 'Not enough drawdown to compare.';
  const pct = Math.round(Math.abs(1 - ratio) * 100);
  if (pct === 0)
    return 'The basket draws down about as much as its parts added up: no diversification.';
  return ratio < 1
    ? `The basket draws down ${pct}% less than its parts added up.`
    : `The basket draws down ${pct}% more than its parts added up.`;
}

/** Points for the drift chart: one per block, the block's mean pairwise correlation and range. */
export function driftPoints(rows: readonly CorrelationRollingRow[]): {
  label: string;
  mean: number | null;
  min: number | null;
  max: number | null;
}[] {
  return rows.map((r) => ({ label: r.end, mean: r.mean, min: r.min, max: r.max }));
}
