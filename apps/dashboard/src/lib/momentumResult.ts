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
