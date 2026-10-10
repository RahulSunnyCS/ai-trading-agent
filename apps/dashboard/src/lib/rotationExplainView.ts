/**
 * Pure helpers for the rotation "Why this pick?" and "Does rank predict results?" widgets. The
 * numbers are computed by the Python package (`rotation/explain.py`, `rotation/rankic.py`); this
 * file chooses how to read them: the stacked-bar segments, how thinly a fit is supported, the
 * provenance flags, the boundary sentences, the day stepping and the chart geometry. No network,
 * no `Math.random`, display formatting through `lib/format.ts`.
 */

import type {
  RotationBoundary,
  RotationCriterion,
  RotationCriterionRow,
  RotationExcluded,
  RotationExplain,
  RotationIc,
  RotationIcDay,
  RotationIcKey,
  RotationIcRunning,
  RotationIcSummary,
  RotationListKey,
  RotationPickRole,
  RotationVariantRef,
  RotationVariantRow,
} from '../types/rotationExplain';
import { EMPTY, formatDay, formatInr, formatInt, formatIstTime, formatNumber } from './format';

export const LIST_KEYS: readonly RotationListKey[] = ['A', 'B', 'C', 'REF'];

/** The order the criteria are shown in, as the composite lists them. */
export const CRITERIA: readonly RotationCriterion[] = ['recent', 'weekday', 'dte', 'vix', 'rfam'];

export const CRITERION_LABEL: Record<RotationCriterion, string> = {
  recent: 'Recent score',
  weekday: 'Weekday fit',
  dte: 'Days-to-expiry fit',
  vix: 'VIX-band fit',
  rfam: 'Family-band recent',
};

/** Short names for a narrow table column; the full name is the cell's tooltip. */
export const CRITERION_SHORT: Record<RotationCriterion, string> = {
  recent: 'Recent',
  weekday: 'Weekday',
  dte: 'Days to expiry',
  vix: 'VIX band',
  rfam: 'Family recent',
};

/** The criterion's name inside a sentence (lower case except the VIX acronym). */
export const CRITERION_PLAIN: Record<RotationCriterion, string> = {
  recent: 'recent score',
  weekday: 'weekday fit',
  dte: 'days-to-expiry fit',
  vix: 'VIX-band fit',
  rfam: 'family-band recent score',
};

export const CRITERION_HINT: Record<RotationCriterion, string> = {
  recent:
    "The variant's own results over the last ten trading days, the latest five counted double (2/3 and 1/3), in rupees per lot.",
  weekday:
    "The variant's average result per lot on the earlier days that fell on the same weekday as today, blended over the lookback windows.",
  dte: "The variant's average result per lot on earlier days with the same days-to-expiry for its own index, blended over the lookback windows.",
  vix: "The variant's average result per lot on earlier days in today's opening India VIX band, blended over the lookback windows.",
  rfam: 'The average recent score of the variant’s family band (strategy type × start band), so a whole family that is working lifts all its members.',
};

/** Colour class of each criterion's slice in a stacked bar: chart identity tokens only. */
export const CRITERION_FILL: Record<RotationCriterion, string> = {
  recent: 'bg-series-1',
  weekday: 'bg-series-2',
  dte: 'bg-series-3',
  vix: 'bg-series-4',
  rfam: 'bg-muted',
};

/** Fewer matching days than this and a fit is called thin. */
export const THIN_DAYS = 5;

// ---------------------------------------------------------------------------
// Composite: the stacked bar
// ---------------------------------------------------------------------------

export interface BarSegment {
  key: RotationCriterion;
  label: string;
  contribution: number;
  /** Width of the slice as a percentage of the full 0..1 track. */
  widthPct: number;
}

/** One slice per criterion that carries weight, as a share of the 0..1 composite track. */
export function stackSegments(row: Pick<RotationVariantRow, 'criteria'>): BarSegment[] {
  return CRITERIA.filter((k) => (row.criteria[k]?.weight ?? 0) > 0).map((key) => ({
    key,
    label: CRITERION_LABEL[key],
    contribution: row.criteria[key].contribution,
    widthPct: Math.max(0, Math.min(100, row.criteria[key].contribution * 100)),
  }));
}

/** The criterion that put the most points into the composite, and its share of it. */
export function dominantCriterion(
  row: Pick<RotationVariantRow, 'criteria' | 'composite'>,
): { key: RotationCriterion; label: string; share: number } | null {
  let best: RotationCriterion | null = null;
  for (const k of CRITERIA) {
    const c = row.criteria[k];
    if (!c || c.weight <= 0) continue;
    if (best === null || c.contribution > row.criteria[best].contribution) best = k;
  }
  if (best === null || row.composite <= 0) return null;
  return {
    key: best,
    label: CRITERION_LABEL[best],
    share: row.criteria[best].contribution / row.composite,
  };
}

export interface Support {
  /** Matching days in the longest lookback window. */
  days: number;
  /** Lookback windows (of those listed) that contain at least one matching day. */
  windowsWithDays: number;
  windows: number;
  thin: boolean;
}

/** How many earlier days stand behind a fit criterion; `null` for a criterion with no days. */
export function supportOf(c: RotationCriterionRow | undefined): Support | null {
  if (!c?.windows) return null;
  const days = Math.max(0, ...c.windows.map((w) => w.matching_days));
  const withDays = c.windows.filter((w) => w.matching_days > 0).length;
  return { days, windowsWithDays: withDays, windows: c.windows.length, thin: days < THIN_DAYS };
}

/** Plain words: what lifted the pick and how well that rests on the data. */
export function whyLine(row: RotationVariantRow): string {
  const dom = dominantCriterion(row);
  if (!dom) return 'No criterion carries this composite.';
  const parts = [
    `Mostly ${CRITERION_PLAIN[dom.key]} (${formatNumber(row.criteria[dom.key].contribution, 2)} of ${formatNumber(row.composite, 2)})`,
  ];
  const sup = supportOf(row.criteria[dom.key]);
  if (sup) {
    parts.push(
      sup.thin
        ? `resting on only ${formatInt(sup.days)} matching ${sup.days === 1 ? 'day' : 'days'}`
        : `${formatInt(sup.days)} matching days`,
    );
  }
  const thin = (['weekday', 'dte', 'vix'] as const).filter(
    (k) => k !== dom.key && (row.criteria[k]?.weight ?? 0) > 0 && supportOf(row.criteria[k])?.thin,
  );
  if (thin.length) {
    parts.push(`thin: ${thin.map((k) => CRITERION_PLAIN[k]).join(', ')}`);
  }
  return `${parts.join(', ')}.`;
}

/** The days in a fit's windows that count as "none in this window": a window with no match. */
export function windowCell(w: { matching_days: number; mean: number | null }): string {
  return w.matching_days > 0 ? formatInt(w.matching_days) : '0';
}

export const ROLE_LABEL: Record<RotationPickRole, string> = {
  core: 'Core',
  core_override: 'Swapped in',
  buy: 'Buy',
  other: '',
};

/**
 * The role column: a pick says what it is; a strategy the Widesl minimum took out says so; the
 * rest of the top of the ranking is simply not picked.
 */
export function roleLabel(
  row: Pick<RotationVariantRow, 'role' | 'variant' | 'kind'>,
  boundary: Pick<RotationBoundary, 'override'>,
): string {
  if (row.role !== 'other') return ROLE_LABEL[row.role];
  const displaced = boundary.override.swaps.some((s) => s.dropped.variant === row.variant);
  return displaced ? 'Displaced' : EMPTY;
}

/** Picks first (core in rank order, then Buy), then the best-ranked strategies they beat. */
export function orderedRows(
  picks: readonly RotationVariantRow[],
  top: readonly RotationVariantRow[],
): RotationVariantRow[] {
  const rank = (a: RotationVariantRow, b: RotationVariantRow) => a.rank - b.rank;
  return [...[...picks].sort(rank), ...[...top].sort(rank)];
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export type FlagTone = 'positive' | 'warning' | 'info' | 'neutral';

export interface ProvenanceFlag {
  id: string;
  tone: FlagTone;
  label: string;
  detail: string;
}

/**
 * What to say about where this explanation comes from. A day in the journal is "Recorded" (the
 * picks and composites are the entry's) and its breakdown, which the journal does not store, is
 * rebuilt and checked against the entry; a day with no entry is wholly reconstructed.
 */
export function provenanceFlags(
  e: Pick<RotationExplain, 'reconstruction' | 'provenance'>,
): ProvenanceFlag[] {
  const { reconstruction: r, provenance: p } = e;
  if (r.source !== 'recorded') {
    return [
      {
        id: 'reconstructed',
        tone: 'info',
        label: 'Reconstructed',
        detail:
          'No journal entry for this day. The ranking is rebuilt from the stored results before it, the same way the 09:16 entry computes it.',
      },
    ];
  }
  const flags: ProvenanceFlag[] = [];
  const time = p.recorded_at ? formatIstTime(p.recorded_at) : EMPTY;
  const late = p.before_first_entry === false;
  flags.push({
    id: 'recorded',
    tone: late ? 'warning' : 'positive',
    label: late ? `Recorded ${time}, late` : `Recorded ${time}`,
    detail: late
      ? 'Recorded after 09:17: this entry is not a forward day and is left out of forward statistics.'
      : 'The picks and composites are the journal entry’s, written before the first entry time.',
  });
  const changed = r.inputs_match === false || r.matches === false;
  if (changed) {
    flags.push({
      id: 'changed',
      tone: 'warning',
      label: 'Reconstructed, inputs changed since recording',
      detail:
        r.inputs_match === false
          ? 'Stored results for earlier days differ from what the entry was scored on (repaired later), so this rebuild may not give the recorded picks.'
          : 'The rebuilt picks or composites differ from the entry.',
    });
  } else if (r.matches === true) {
    flags.push({
      id: 'matches',
      tone: 'positive',
      label: 'Reconstructed, matches the entry',
      detail: 'The rebuilt picks and composites equal the entry’s, to four decimals.',
    });
  } else {
    flags.push({
      id: 'unchecked',
      tone: 'neutral',
      label: 'Reconstructed, not checked',
      detail: r.note ?? 'The entry has no record for this list to compare with.',
    });
  }
  return flags;
}

// ---------------------------------------------------------------------------
// Boundary
// ---------------------------------------------------------------------------

export interface BoundaryLine {
  id: string;
  tone: FlagTone;
  text: string;
}

function ref(v: RotationVariantRef): string {
  return `${v.variant} (rank ${formatInt(v.rank)})`;
}

function excludedText(x: RotationExcluded): string {
  const gap = formatNumber(Math.abs(x.gap), 3);
  if (x.gap < 0) {
    return `${ref(x)} scored ${gap} above the weakest pick and was left out by the Widesl minimum.`;
  }
  return `Best left out: ${ref(x)}, ${gap} below the weakest pick.`;
}

/** The boundary facts as sentences: the Widesl minimum, the nearest alternative, the Buy test. */
export function boundaryLines(b: RotationBoundary): BoundaryLine[] {
  const lines: BoundaryLine[] = [];
  if (b.override.fired) {
    const swaps = b.override.swaps
      .map((s) => `${ref(s.dropped)} replaced by ${ref(s.added)}`)
      .join('; ');
    lines.push({
      id: 'override',
      tone: 'warning',
      text: `Widesl minimum overrode rank: the top ${formatInt(b.n_core)} held ${formatInt(b.override.wide_in_unconstrained)} Widesl and ${formatInt(b.min_wide)} are required. ${swaps}.`,
    });
  } else {
    lines.push({
      id: 'override',
      tone: 'neutral',
      text: `Rank decided the core: the top ${formatInt(b.n_core)} already held ${formatInt(b.override.wide_in_unconstrained)} Widesl (${formatInt(b.min_wide)} required).`,
    });
  }
  if (b.best_excluded) {
    lines.push({
      id: 'excluded',
      tone: b.best_excluded.gap < 0 ? 'warning' : 'neutral',
      text: excludedText(b.best_excluded),
    });
  }
  const buy = b.buy;
  if (buy.qualified && buy.picked[0]) {
    lines.push({
      id: 'buy',
      tone: 'positive',
      text: `Buy qualified: ${ref(buy.picked[0])} is inside the overall top ${formatInt(buy.top)}.`,
    });
  } else if (buy.best_buy) {
    const short =
      buy.gap_to_top === null
        ? ''
        : `, ${formatNumber(buy.gap_to_top, 3)} short of the top ${formatInt(buy.top)}`;
    lines.push({
      id: 'buy',
      tone: 'neutral',
      text: `No Buy: the best Buy variant, ${ref(buy.best_buy)}, is outside the overall top ${formatInt(buy.top)}${short}.`,
    });
  } else {
    lines.push({ id: 'buy', tone: 'neutral', text: 'No Buy variant has a composite today.' });
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Day stepping
// ---------------------------------------------------------------------------

/** The latest explainable day on or before `wanted`; the first one if `wanted` is before them all. */
export function snapDay(days: readonly string[], wanted: string): string | null {
  if (days.length === 0) return null;
  let best: string | null = null;
  for (const d of days) {
    if (d <= wanted) best = d;
    else break;
  }
  return best ?? days[0] ?? null;
}

/** The explainable day before / after `current`; `current` itself at either end. */
export function stepDay(
  days: readonly string[],
  current: string,
  direction: -1 | 1,
): string | null {
  if (days.length === 0) return null;
  const at = days.indexOf(current);
  if (at === -1) return snapDay(days, current);
  const next = Math.max(0, Math.min(days.length - 1, at + direction));
  return days[next] ?? null;
}

// ---------------------------------------------------------------------------
// Rank correlation
// ---------------------------------------------------------------------------

/** Rows of the criterion table, in the order BL-081's calibration listed them. */
export const IC_KEYS: readonly RotationIcKey[] = [
  'weekday',
  'dte',
  'vix',
  'recent',
  'rfam',
  'composite',
];

export const IC_LABEL: Record<RotationIcKey, string> = {
  ...CRITERION_LABEL,
  composite: 'Composite',
};

export interface IcRow {
  key: RotationIcKey;
  label: string;
  summary: RotationIcSummary;
  /** The research reference value (list A only), when there is one for this key. */
  reference: number | null;
  /** True when the 95% band includes zero (or there is no band yet). */
  includesZero: boolean | null;
}

export function bandIncludesZero(s: RotationIcSummary): boolean | null {
  if (s.lo === null || s.hi === null) return null;
  return s.lo <= 0 && s.hi >= 0;
}

export function icRows(ic: RotationIc): IcRow[] {
  return IC_KEYS.map((key) => {
    const summary = ic.summary[key];
    return {
      key,
      label: IC_LABEL[key],
      summary,
      reference: ic.reference?.values[key] ?? null,
      includesZero: bandIncludesZero(summary),
    };
  });
}

/** The least number of scored days before a forward mean is read as more than a first look. */
export const MIN_DAYS_FOR_READING = 20;

/** One plain sentence on what the composite's correlation says so far. */
export function icVerdict(s: RotationIcSummary): string {
  if (s.n === 0) return 'No day to read yet.';
  if (s.n < MIN_DAYS_FOR_READING) {
    return `${formatInt(s.n)} ${s.n === 1 ? 'day' : 'days'}: too few to read; the band is wide.`;
  }
  const zero = bandIncludesZero(s);
  if (zero === null) return `${formatInt(s.n)} days, no band yet.`;
  if (zero)
    return `${formatInt(s.n)} days: the band includes zero, so the ranking is not yet distinguishable from chance.`;
  return s.lo !== null && s.lo > 0
    ? `${formatInt(s.n)} days: the whole band is above zero; the ranking ordered the days' results.`
    : `${formatInt(s.n)} days: the whole band is below zero; the ranking ordered the results backwards.`;
}

/** A correlation to three places with its sign, or the empty mark. */
export function formatIc(value: number | null | undefined): string {
  return formatNumber(value, 3, { sign: true });
}

export interface IcDomain {
  min: number;
  max: number;
}

/** A symmetric y-range round numbers wide that holds every bar and the band. */
export function icDomain(
  days: readonly RotationIcDay[],
  running: readonly RotationIcRunning[],
): IcDomain {
  let m = 0;
  for (const d of days) if (d.composite !== null) m = Math.max(m, Math.abs(d.composite));
  for (const r of running) {
    if (r.lo !== null) m = Math.max(m, Math.abs(r.lo));
    if (r.hi !== null) m = Math.max(m, Math.abs(r.hi));
  }
  const rounded = Math.max(0.1, Math.ceil(m / 0.1) * 0.1);
  return { min: -rounded, max: rounded };
}

export interface ChartSize {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface IcBar {
  i: number;
  day: string;
  kind: RotationIcDay['kind'];
  value: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface IcLayout {
  bars: IcBar[];
  zeroY: number;
  /** Polyline points of the running mean and the polygon of its band ('' when fewer than 2 days). */
  line: string;
  band: string;
  yFor: (v: number) => number;
  xFor: (i: number) => number;
  /** Where a research reference value sits (null when out of range). */
  referenceY: (v: number | null) => number | null;
  ticks: number[];
}

/** Geometry of the daily bars with the running mean and its band, in SVG units. */
export function icLayout(
  days: readonly RotationIcDay[],
  running: readonly RotationIcRunning[],
  size: ChartSize,
  domain: IcDomain = icDomain(days, running),
): IcLayout {
  const plotW = size.width - size.left - size.right;
  const plotH = size.height - size.top - size.bottom;
  const n = Math.max(days.length, 1);
  const slot = plotW / n;
  const yFor = (v: number) => size.top + ((domain.max - v) / (domain.max - domain.min)) * plotH;
  const xFor = (i: number) => size.left + slot * (i + 0.5);
  const zeroY = yFor(0);
  const barW = Math.max(1, Math.min(slot * 0.7, 14));
  const bars = days.map((d, i): IcBar => {
    const value = d.composite;
    const y = value === null ? zeroY : Math.min(yFor(value), zeroY);
    const height = value === null ? 0 : Math.abs(yFor(value) - zeroY);
    return { i, day: d.day, kind: d.kind, value, x: xFor(i) - barW / 2, y, width: barW, height };
  });
  const have = running.filter((r) => r.mean !== null);
  const line =
    have.length >= 2
      ? running
          .map((r, i) => (r.mean === null ? null : `${xFor(i)},${yFor(r.mean)}`))
          .filter(Boolean)
          .join(' ')
      : '';
  const banded = running
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => r.lo !== null && r.hi !== null);
  const band =
    banded.length >= 2
      ? [
          ...banded.map(({ r, i }) => `${xFor(i)},${yFor(r.hi as number)}`),
          ...[...banded].reverse().map(({ r, i }) => `${xFor(i)},${yFor(r.lo as number)}`),
        ].join(' ')
      : '';
  const half = domain.max;
  const ticks = [half, half / 2, 0, -half / 2, -half].map((t) => Math.round(t * 1000) / 1000);
  return {
    bars,
    zeroY,
    line,
    band,
    yFor,
    xFor,
    referenceY: (v) => (v === null || v < domain.min || v > domain.max ? null : yFor(v)),
    ticks,
  };
}

/** The nearest bar to an x position in the plot (SVG units). */
export function nearestBar(layout: IcLayout, x: number): IcBar | null {
  let best: IcBar | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const b of layout.bars) {
    const dist = Math.abs(b.x + b.width / 2 - x);
    if (dist < bestDist) {
      best = b;
      bestDist = dist;
    }
  }
  return best;
}

/** Mean gross per lot of the top and bottom 30, as a short sentence for the tooltip. */
export function spreadText(d: RotationIcDay, n: number): string {
  if (d.spread === null) return EMPTY;
  return `top ${n} ${formatInr(d.top)} − bottom ${n} ${formatInr(d.bottom)} = ${formatInr(d.spread, { sign: true })}`;
}

export function dayLabel(day: string): string {
  return formatDay(day);
}
