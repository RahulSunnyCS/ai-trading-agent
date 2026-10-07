/**
 * Pure helpers behind the Momentum backtest result views: range slicing and rebasing for the
 * equity chart, rotation-marker thinning, monthly / yearly resampling for the heatmap, the
 * timeline's "longest held" cap and the one tone map for signal actions. No React, no DOM.
 */

type Series = ReadonlyArray<number | null | undefined>;

// ---------------------------------------------------------------------------
// Equity chart: range + rebase
// ---------------------------------------------------------------------------

export type EquityRange = '1y' | '3y' | '5y' | 'all';

export const EQUITY_RANGES: ReadonlyArray<{ value: EquityRange; label: string }> = [
  { value: '1y', label: '1Y' },
  { value: '3y', label: '3Y' },
  { value: '5y', label: '5Y' },
  { value: 'all', label: 'All' },
];

const RANGE_YEARS: Record<EquityRange, number | null> = { '1y': 1, '3y': 3, '5y': 5, all: null };

/** What every line is re-based to at the first visible week. */
export const REBASE_VALUE = 100_000;

/**
 * The calendar day a range starts on: the last date minus N years ("2026-10-02" → "2025-10-02").
 * Null for 'all', or when there are no dates.
 */
export function rangeCutoff(dates: ReadonlyArray<string>, range: EquityRange): string | null {
  const years = RANGE_YEARS[range];
  const last = dates.at(-1);
  if (years === null || last === undefined) return null;
  const day = last.slice(0, 10);
  const year = Number(day.slice(0, 4));
  if (!Number.isFinite(year)) return null;
  return `${String(year - years).padStart(4, '0')}${day.slice(4)}`;
}

/** Index of the first date on or after `cutoff`; 0 when cutoff is null or precedes the data. */
export function startIndexFor(dates: ReadonlyArray<string>, cutoff: string | null): number {
  if (cutoff === null) return 0;
  const index = dates.findIndex((date) => date.slice(0, 10) >= cutoff);
  // A cutoff after every date cannot happen for a cutoff derived from these dates; show all.
  return index < 0 ? 0 : index;
}

/** First visible index for a range. A range longer than the data returns 0 (everything). */
export function rangeStartIndex(dates: ReadonlyArray<string>, range: EquityRange): number {
  return startIndexFor(dates, rangeCutoff(dates, range));
}

/**
 * The multiplier that re-bases a value series to `base` at the first usable (non-null,
 * positive) value on or after `start`. Null when there is no such value.
 */
export function rebaseFactor(values: Series, start: number, base = REBASE_VALUE): number | null {
  for (let i = Math.max(start, 0); i < values.length; i += 1) {
    const value = values[i];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return base / value;
  }
  return null;
}

/**
 * The series from `start` on, re-based so its first usable value equals `base`. Ratios between
 * any two points are unchanged; nulls stay null. `start` 0 returns the values unscaled (the
 * full run already starts at its own base), and a series with no usable value is only sliced.
 */
export function rebaseSeries(
  values: Series,
  start: number,
  base = REBASE_VALUE,
): Array<number | null> {
  const from = Math.max(start, 0);
  const factor = from === 0 ? 1 : (rebaseFactor(values, from, base) ?? 1);
  return values.slice(from).map((value) => (typeof value === 'number' ? value * factor : null));
}

/** The series from `start` on, unscaled (drawdown, edge, counts). */
export function sliceSeries<T>(values: ReadonlyArray<T>, start: number): T[] {
  return values.slice(Math.max(start, 0));
}

// ---------------------------------------------------------------------------
// Equity chart: rotation markers
// ---------------------------------------------------------------------------

/** Above this many visible weeks the chart is "zoomed out" and markers are thinned. */
export const ROTATION_THIN_ABOVE_WEEKS = 150;
/** The most markers a zoomed-out chart draws. */
export const ROTATION_MAX_MARKERS = 80;

interface RotationLike {
  outs: ReadonlyArray<unknown>;
  ins: ReadonlyArray<{ top_up?: boolean }>;
  parked: boolean;
}

/** A rotation that changed what is held: a sale, a new name (not a top-up) or a park. */
export function isRealRotation(rotation: RotationLike): boolean {
  return rotation.parked || rotation.outs.length > 0 || rotation.ins.some((row) => !row.top_up);
}

/**
 * Which rotations get a marker. Zoomed in (`visibleWeeks` ≤ the threshold): all of them.
 * Zoomed out: only rotations with a real change, and if that is still more than
 * `maxMarkers`, every Nth of those (always keeping the first). Deterministic.
 */
export function thinRotations<T extends RotationLike>(
  rotations: ReadonlyArray<T>,
  visibleWeeks: number,
  options: { threshold?: number; maxMarkers?: number } = {},
): T[] {
  const threshold = options.threshold ?? ROTATION_THIN_ABOVE_WEEKS;
  const maxMarkers = Math.max(options.maxMarkers ?? ROTATION_MAX_MARKERS, 1);
  if (visibleWeeks <= threshold) return [...rotations];
  const real = rotations.filter(isRealRotation);
  if (real.length <= maxMarkers) return real;
  const step = Math.ceil(real.length / maxMarkers);
  return real.filter((_, index) => index % step === 0);
}

/** How many of `dates` fall inside [from, to] (ISO days, either end open when null). */
export function countVisibleWeeks(
  dates: ReadonlyArray<string>,
  from: string | null,
  to: string | null,
): number {
  let count = 0;
  for (const date of dates) {
    const day = date.slice(0, 10);
    if (from !== null && day < from.slice(0, 10)) continue;
    if (to !== null && day > to.slice(0, 10)) continue;
    count += 1;
  }
  return count;
}

/**
 * What happened in a rotation week, which colours its (circular) marker: names only added,
 * names only taken out, both, or neither (only top-ups, trims or a park).
 */
export type RotationKind = 'added' | 'out' | 'both' | 'other';

/** An entry is a NEW name: a top-up of a name already held is not one. */
export function rotationKind(rotation: RotationLike): RotationKind {
  const entered = rotation.ins.some((row) => !row.top_up);
  const exited = rotation.outs.length > 0;
  if (entered && exited) return 'both';
  if (entered) return 'added';
  if (exited) return 'out';
  return 'other';
}

/**
 * Broad Momentum swaps names in and out almost every week, so its markers only add noise until
 * the chart shows a year or less: this many weekly points (a 1Y range is 52 or 53 of them).
 */
export const BROAD_MARKERS_MAX_WEEKS = 53;

/** Whether the chart draws rotation markers at all; other datasets always do (then thinned). */
export function rotationMarkersShown(broad: boolean, visibleWeeks: number): boolean {
  return !broad || visibleWeeks <= BROAD_MARKERS_MAX_WEEKS;
}

// ---------------------------------------------------------------------------
// Equity chart: y-axis headroom (room for the week box in the plot's top-left corner)
// ---------------------------------------------------------------------------

/** Linear axis: the top is the highest visible value × this, so about 22 % of the plot is empty. */
export const HEADROOM_LINEAR = 1.28;
/** Log axis: the top is the highest visible value × this (log10(1.35) in log units). */
export const HEADROOM_LOG = 1.35;
/** Log axis: the bottom sits this share of the visible span below the lowest value. */
const LOG_FLOOR_PAD = 0.02;

export interface RangeLine {
  dates: ReadonlyArray<string>;
  values: Series;
}

/**
 * The main y-axis range for the visible window, with headroom on top. Every line's points inside
 * [from, to] count (ISO days, either end open when null), plus the neighbour just outside each
 * edge, since the segment to it is drawn too. Linear: [min(0, lowest), highest × 1.28]. Log
 * (Plotly takes log10 units): [log10(lowest) − 2 % of the span, log10(highest × 1.35)], counting
 * only positive values. Null (let Plotly autorange) when no line has a usable visible value.
 */
export function headroomRange(
  lines: ReadonlyArray<RangeLine>,
  from: string | null,
  to: string | null,
  log: boolean,
): [number, number] | null {
  const start = from?.slice(0, 10) ?? null;
  const end = to?.slice(0, 10) ?? null;
  const overlaps = (a: string, b: string): boolean =>
    (end === null || a <= end) && (start === null || b >= start);
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const line of lines) {
    const days = line.dates.map((date) => date.slice(0, 10));
    for (let i = 0; i < days.length; i += 1) {
      const day = days[i];
      const value = line.values[i];
      if (day === undefined || typeof value !== 'number' || !Number.isFinite(value)) continue;
      if (log && value <= 0) continue;
      const before = days[i - 1];
      const after = days[i + 1];
      const shown =
        overlaps(day, day) ||
        (before !== undefined && overlaps(before, day)) ||
        (after !== undefined && overlaps(day, after));
      if (!shown) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (log) {
    const low = Math.log10(min);
    const high = Math.log10(max);
    return [low - (high - low) * LOG_FLOOR_PAD, high + Math.log10(HEADROOM_LOG)];
  }
  const low = Math.min(0, min);
  const high = max > 0 ? max * HEADROOM_LINEAR : 0;
  return high > low ? [low, high] : null;
}

// ---------------------------------------------------------------------------
// Equity chart: the follow tooltip's placement
// ---------------------------------------------------------------------------

/** How far below (or above) the cursor the tooltip's near edge sits: about 1 cm. */
export const TOOLTIP_OFFSET_Y = 40;

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface TooltipPlacement {
  left: number;
  top: number;
  /** Placed above the cursor because below would overflow the bottom. */
  above: boolean;
}

/**
 * Where the follow tooltip goes, in the same coordinates as `cursor` and `bounds`: centred on
 * the cursor, its top edge 40 px below it, so the line to the left and right of the cursor stays
 * clear and the next point is always reachable. If that overflows the bottom of `bounds` its
 * bottom edge sits 40 px above the cursor instead. Then it is slid sideways, and down if need
 * be, to stay inside `bounds`.
 */
export function tooltipPlacement(
  cursor: { x: number; y: number },
  size: { width: number; height: number },
  bounds: Box,
): TooltipPlacement {
  let top = cursor.y + TOOLTIP_OFFSET_Y;
  const above = top + size.height > bounds.bottom;
  if (above) top = cursor.y - TOOLTIP_OFFSET_Y - size.height;
  const centred = cursor.x - size.width / 2;
  const left = Math.max(Math.min(centred, bounds.right - size.width), bounds.left);
  return { left, top: Math.max(top, bounds.top), above };
}

// ---------------------------------------------------------------------------
// Equity chart: the week box in the plot's corner
// ---------------------------------------------------------------------------

export interface FittedNames {
  shown: string[];
  /** How many names were left out ("+3 more"). */
  more: number;
}

/** "+12 more" plus its separator: what a truncated list keeps free. */
const MORE_RESERVE = 10;

/**
 * As many leading names as fit in `budget` characters when joined with ", ". When some are
 * left out, room for " +N more" is kept free. The first name is always shown, however long.
 */
export function fitNames(names: ReadonlyArray<string>, budget: number): FittedNames {
  const joined = (count: number): number =>
    names.slice(0, count).reduce((sum, name) => sum + name.length, 0) + Math.max(count - 1, 0) * 2;
  if (names.length === 0) return { shown: [], more: 0 };
  if (joined(names.length) <= budget) return { shown: [...names], more: 0 };
  let count = 1;
  while (count < names.length - 1 && joined(count + 1) + MORE_RESERVE <= budget) count += 1;
  return { shown: names.slice(0, count), more: names.length - count };
}

/** "A, B +3 more"; empty when there are no names. */
export function fittedNamesText(fitted: FittedNames): string {
  const names = fitted.shown.join(', ');
  return fitted.more > 0 ? `${names} +${fitted.more} more` : names;
}

interface WeekRotationLike {
  outs: ReadonlyArray<{ asset: string }>;
  ins: ReadonlyArray<{ asset: string; top_up?: boolean }>;
  trims: ReadonlyArray<unknown>;
  parked: boolean;
}

export interface WeekSummary {
  /** 'parked' = everything in the liquid fund; 'none' = nothing was traded. */
  kind: 'rotation' | 'none' | 'parked';
  /** New names bought (top-ups are counted in `toppedUp`). */
  inCount: number;
  ins: FittedNames;
  outCount: number;
  outs: FittedNames;
  toppedUp: number;
  trimmed: number;
  held: number | null;
}

/**
 * One week in words. `budget` is the characters available for entry and exit names together:
 * each side gets half, and what one side does not use goes to the other.
 */
export function weekSummary(
  rotation: WeekRotationLike | null | undefined,
  held: number | null | undefined,
  budget: number,
): WeekSummary {
  const heldCount = typeof held === 'number' && Number.isFinite(held) ? held : null;
  const inNames = (rotation?.ins ?? []).filter((row) => !row.top_up).map((row) => row.asset);
  const outNames = (rotation?.outs ?? []).map((row) => row.asset);
  const toppedUp = (rotation?.ins ?? []).length - inNames.length;
  const trimmed = rotation?.trims.length ?? 0;
  const half = Math.floor(Math.max(budget, 0) / 2);
  const length = (names: string[]): number =>
    names.reduce((sum, name) => sum + name.length, 0) + Math.max(names.length - 1, 0) * 2;
  const inBudget = Math.max(half, budget - length(outNames));
  const ins = fitNames(inNames, inBudget);
  const outs = fitNames(outNames, Math.max(half, budget - fittedNamesText(ins).length));
  const parked = Boolean(rotation?.parked) || heldCount === 0;
  const changed = inNames.length + outNames.length + toppedUp + trimmed > 0;
  return {
    kind: parked ? 'parked' : changed ? 'rotation' : 'none',
    inCount: inNames.length,
    ins,
    outCount: outNames.length,
    outs,
    toppedUp,
    trimmed,
    held: heldCount,
  };
}

/** The counts of a week's changes: "8 in · 10 out · 2 trimmed"; "No change" when there are none. */
export function weekChangeCounts(summary: WeekSummary): string {
  const parts = [
    summary.inCount > 0 ? `${summary.inCount} in` : null,
    summary.outCount > 0 ? `${summary.outCount} out` : null,
    summary.toppedUp > 0 ? `${summary.toppedUp} topped up` : null,
    summary.trimmed > 0 ? `${summary.trimmed} trimmed` : null,
  ].filter((part): part is string => part !== null);
  return parts.length ? parts.join(' · ') : 'No change';
}

/**
 * The week line as plain text (the visible line is built from the same summary):
 * "▲ 2 in A, B · ▼ 1 out C · Held 5", "No change · Held 5", "Parked in the liquid fund".
 */
export function weekSummaryText(summary: WeekSummary): string {
  const parts: string[] = [];
  if (summary.inCount > 0) parts.push(`▲ ${summary.inCount} in ${fittedNamesText(summary.ins)}`);
  if (summary.outCount > 0) {
    parts.push(`▼ ${summary.outCount} out ${fittedNamesText(summary.outs)}`);
  }
  if (summary.toppedUp > 0) parts.push(`${summary.toppedUp} topped up`);
  if (summary.trimmed > 0) parts.push(`${summary.trimmed} trimmed`);
  if (summary.kind === 'parked') parts.push('Parked in the liquid fund');
  else {
    if (parts.length === 0) parts.push('No change');
    if (summary.held !== null) parts.push(`Held ${summary.held}`);
  }
  return parts.join(' · ');
}

/** The return of week `index` over the week before it; null at the first week or on a gap. */
export function weekReturn(values: Series, index: number): number | null {
  const now = values[index];
  const before = values[index - 1];
  if (typeof now !== 'number' || typeof before !== 'number' || before <= 0) return null;
  return now / before - 1;
}

/** The last rotation on or before `day` (rotations oldest first), for "what is held now". */
export function rotationOnOrBefore<T extends { week: string }>(
  rotations: ReadonlyArray<T>,
  day: string,
): T | null {
  let found: T | null = null;
  for (const rotation of rotations) {
    if (rotation.week.slice(0, 10) > day.slice(0, 10)) break;
    found = rotation;
  }
  return found;
}

// ---------------------------------------------------------------------------
// Drawdown stats
// ---------------------------------------------------------------------------

export interface UnderwaterSpell {
  /** Weeks from the peak to the week that peak was regained (or to the last week, if not yet). */
  weeks: number;
  /** The peak week. */
  from: string;
  /** The recovery week, or the last week when `ongoing`. */
  to: string;
  ongoing: boolean;
}

/** A drawdown this close to zero counts as "at the peak" (float noise). */
const AT_PEAK = -1e-9;

/**
 * The longest stretch the strategy spent below a previous peak, from a drawdown series
 * (0 at a peak, negative below it). Null when it was never under water. A missing value
 * counts as at the peak. If the series starts under water, the spell starts at its first week.
 */
export function longestUnderwater(
  dates: ReadonlyArray<string>,
  drawdown: Series,
): UnderwaterSpell | null {
  let best: UnderwaterSpell | null = null;
  let peak = 0;
  let under = false;
  const close = (end: number, ongoing: boolean): void => {
    const from = dates[peak];
    const to = dates[end];
    if (from === undefined || to === undefined) return;
    if (best === null || end - peak > best.weeks) {
      best = { weeks: end - peak, from: from.slice(0, 10), to: to.slice(0, 10), ongoing };
    }
  };
  const count = Math.min(dates.length, drawdown.length);
  for (let i = 0; i < count; i += 1) {
    const value = drawdown[i];
    const below = typeof value === 'number' && value < AT_PEAK;
    if (below) under = true;
    else {
      if (under) close(i, false);
      under = false;
      peak = i;
    }
  }
  if (under && count > 0) close(count - 1, true);
  return best;
}

export interface DrawdownStats {
  /** The deepest drawdown (≤ 0) and the week it bottomed; null when there is no data. */
  max: number | null;
  troughDate: string | null;
  /** The last week's drawdown. */
  current: number | null;
  underwater: UnderwaterSpell | null;
}

export function drawdownStats(dates: ReadonlyArray<string>, drawdown: Series): DrawdownStats {
  let max: number | null = null;
  let troughDate: string | null = null;
  let current: number | null = null;
  const count = Math.min(dates.length, drawdown.length);
  for (let i = 0; i < count; i += 1) {
    const value = drawdown[i];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    current = value;
    if (max === null || value < max) {
      max = value;
      troughDate = dates[i]?.slice(0, 10) ?? null;
    }
  }
  return { max, troughDate, current, underwater: longestUnderwater(dates, drawdown) };
}

/** The last usable value of a series and its date; null when there is none. */
export function latestValue(
  dates: ReadonlyArray<string>,
  values: Series,
): { value: number; date: string } | null {
  for (let i = Math.min(dates.length, values.length) - 1; i >= 0; i -= 1) {
    const value = values[i];
    const date = dates[i];
    if (typeof value === 'number' && Number.isFinite(value) && date !== undefined) {
      return { value, date: date.slice(0, 10) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Monthly heatmap
// ---------------------------------------------------------------------------

export const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/**
 * Resamples a weekly cumulative-value series to one return per calendar month ("2024-03" →
 * 0.032). The first month is measured from the first value of the series, so the months of a
 * year compound to that year's return.
 */
export function monthlyReturns(dates: ReadonlyArray<string>, values: Series): Map<string, number> {
  const lastOfMonth = new Map<string, number>();
  let first: number | null = null;
  for (let i = 0; i < dates.length; i += 1) {
    const value = values[i];
    const date = dates[i];
    if (typeof value !== 'number' || !Number.isFinite(value) || date === undefined) continue;
    if (first === null) first = value;
    lastOfMonth.set(date.slice(0, 7), value);
  }
  const returns = new Map<string, number>();
  let previous = first;
  for (const month of [...lastOfMonth.keys()].sort()) {
    const value = lastOfMonth.get(month);
    if (value === undefined) continue;
    if (previous !== null && previous !== 0) returns.set(month, value / previous - 1);
    previous = value;
  }
  return returns;
}

/** Compounds a month → return map into one return per calendar year ("2024" → 0.21). */
export function yearlyFromMonthly(monthly: ReadonlyMap<string, number>): Map<string, number> {
  const growth = new Map<string, number>();
  for (const [month, value] of monthly) {
    const year = month.slice(0, 4);
    growth.set(year, (growth.get(year) ?? 1) * (1 + value));
  }
  return new Map([...growth].map(([year, value]) => [year, value - 1]));
}

/** a − b for every key both maps have (strategy minus benchmark). */
export function differenceByKey(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, value] of a) {
    const other = b.get(key);
    if (other !== undefined) out.set(key, value - other);
  }
  return out;
}

/**
 * How strongly a signed cell is tinted: 0 (flat / missing) to 4. Buckets on the absolute
 * value: under 2%, under 5%, under 10%, and 10% or more.
 */
export function heatLevel(value: number | null | undefined): 0 | 1 | 2 | 3 | 4 {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return 0;
  const size = Math.abs(value);
  if (size < 0.02) return 1;
  if (size < 0.05) return 2;
  if (size < 0.1) return 3;
  return 4;
}

// ---------------------------------------------------------------------------
// Timeline (Gantt) cap
// ---------------------------------------------------------------------------

/** How many instruments the timeline shows before "Show all". */
export const TIMELINE_TOP_N = 25;

/**
 * The `n` instruments held longest in total across the run (sum of every position's
 * end − start), longest first; ties keep first-seen order. `total` is how many there are.
 */
export function longestHeldAssets(
  rows: ReadonlyArray<Record<string, unknown>>,
  n = TIMELINE_TOP_N,
): { assets: string[]; total: number } {
  const held = new Map<string, number>();
  for (const row of rows) {
    const asset = String(row.asset);
    const start = Date.parse(String(row.start));
    const end = Date.parse(String(row.end));
    const span = Number.isFinite(start) && Number.isFinite(end) ? Math.max(end - start, 0) : 0;
    held.set(asset, (held.get(asset) ?? 0) + span);
  }
  const ranked = [...held.entries()]
    .map(([asset, span], index) => ({ asset, span, index }))
    .sort((a, b) => b.span - a.span || a.index - b.index);
  return { assets: ranked.slice(0, Math.max(n, 0)).map((row) => row.asset), total: ranked.length };
}

// ---------------------------------------------------------------------------
// Signal actions
// ---------------------------------------------------------------------------

/** A subset of the Badge tones, so every view colours a signal action the same way. */
export type SignalTone = 'positive' | 'negative' | 'warning' | 'neutral';

/**
 * The one tone map for signal actions: buying (BUY, BUY (make room), BUY / TOP UP, ADD, IN) is
 * positive; selling (SELL, OUT, TRIM, TRIM to 25%) is negative; blocked-for-now states (WAIT,
 * WAITING FOR A SALE, AT CAP) are warnings; HOLD, PARK, NOT A MEMBER and anything unknown are
 * neutral. Matching is case-insensitive on the leading word(s).
 */
export function signalActionTone(action: string | null | undefined): SignalTone {
  const text = (action ?? '').trim().toUpperCase();
  if (text.startsWith('BUY') || text.startsWith('ADD') || text === 'IN') return 'positive';
  if (text.startsWith('SELL') || text.startsWith('TRIM') || text === 'OUT') return 'negative';
  if (text.startsWith('WAIT') || text.startsWith('AT CAP')) return 'warning';
  return 'neutral';
}

/** True for actions that mean "not in play this week", which views render fainter. */
export function isInactiveSignalAction(action: string | null | undefined): boolean {
  return (action ?? '').trim().toUpperCase().startsWith('NOT A MEMBER');
}

/**
 * The lookback keys present on any signal row, shortest first ("4", "13", "26"); non-numeric
 * keys sort after the numeric ones, alphabetically.
 */
export function lookbackKeys(
  rows: ReadonlyArray<{ returns?: Record<string, number | null> | null }>,
): string[] {
  const keys = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row.returns ?? {})) keys.add(key);
  return [...keys].sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    const aNum = a !== '' && Number.isFinite(na);
    const bNum = b !== '' && Number.isFinite(nb);
    if (aNum && bNum) return na - nb;
    if (aNum !== bNum) return aNum ? -1 : 1;
    return a.localeCompare(b);
  });
}

/** "13" → "13w"; a key that is not a whole number of weeks is shown as it is. */
export function lookbackLabel(key: string): string {
  return /^\d+$/.test(key) ? `${key}w` : key;
}
