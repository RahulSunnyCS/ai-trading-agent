/**
 * Pure helpers for Options Lab › Matrix (the rotation Strategy Matrix). The figures are computed
 * by the Python package (`rotation/matrix.py`); this file only chooses what to ask for and how to
 * read the answer: the query, the colour bands, the thin flag, the difference text, the insight
 * lines and the drawer's histogram. No `Math.random`, no network, no hex colours: a band maps to a
 * token class written out in full so Tailwind sees it.
 */

import type {
  MatrixBasis,
  MatrixCell,
  MatrixCellDay,
  MatrixDiffCell,
  MatrixListId,
  MatrixMetric,
  MatrixPeriodId,
  MatrixResponse,
  MatrixScale,
  MatrixUnit,
  MatrixView,
} from '../types/rotationMatrix';
import { formatInr, formatNumber, formatPct, formatPp } from './format';

export const ANY = 'any';
export const DEFAULT_MIN_N = 20;

// --- vocabulary -------------------------------------------------------------------------------

export const VIEW_OPTIONS: { value: MatrixView; label: string; hint: string }[] = [
  {
    value: 'family_slot',
    label: 'Family × start',
    hint: 'Each strategy kind against its 25 start times.',
  },
  {
    value: 'date_slot',
    label: 'Date × start',
    hint: 'One strategy kind: every session against start time.',
  },
  {
    value: 'dte_slot',
    label: 'DTE × start',
    hint: 'Days to the index’s own expiry against start time.',
  },
  { value: 'vix_family', label: 'VIX × family', hint: 'Opening VIX band against strategy kind.' },
  { value: 'weekday_family', label: 'Weekday × family', hint: 'Weekday against strategy kind.' },
  { value: 'pulse', label: 'Pulse', hint: 'Each kind over the last 5, 21 and 63 sessions.' },
];

export const METRIC_OPTIONS: { value: MatrixMetric; label: string }[] = [
  { value: 'avg', label: 'Average ₹' },
  { value: 'win_rate', label: 'Win rate' },
  { value: 'stop_rate', label: 'Stop-hit' },
  { value: 'worst', label: 'Worst day' },
  { value: 'selection', label: 'Selected' },
];

export const METRIC_NOTE: Record<MatrixMetric, string> = {
  avg: 'Average gross P&L per one-lot strategy-day, before costs.',
  win_rate: 'Share of strategy-days that closed above zero.',
  stop_rate: 'Share of strategy-days that ended on the overall stop-loss.',
  worst: 'The single worst strategy-day pooled into the cell (not a drawdown).',
  selection:
    'Picks divided by selection opportunities: recorded on-time entry days times the variants pooled.',
};

export const PERIOD_LABEL: Record<MatrixPeriodId, string> = {
  P1: 'P1 · Dec 2025 – Oct 2026',
  P2: 'P2 · Jan – Aug 2025',
  P3: 'P3 · 2022 – Oct 2024',
  forward: 'Forward',
  custom: 'Custom',
  asof: 'As of one day',
};

export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] as const;

export function slotLabel(slot: string): string {
  return /^\d{4}$/.test(slot) ? `${slot.slice(0, 2)}:${slot.slice(2)}` : slot;
}

// --- the request ------------------------------------------------------------------------------

export interface MatrixFilters {
  view: MatrixView;
  metric: MatrixMetric;
  period: MatrixPeriodId;
  /** Show P1 and P2 together on one scale, plus their difference. */
  compare: boolean;
  from: string;
  to: string;
  index: 'both' | 'NIFTY' | 'SENSEX';
  /** The family filter text the API takes; ANY is none. */
  family: string;
  /** `N:wide`: the single strategy kind the date and DTE views need. */
  strategy: string;
  slot: string;
  weekday: string;
  dte: string;
  vix: string;
  minN: number;
  list: MatrixListId | typeof ANY;
  basis: MatrixBasis;
}

export const DEFAULT_FILTERS: MatrixFilters = {
  view: 'family_slot',
  metric: 'avg',
  period: 'P1',
  compare: false,
  from: '',
  to: '',
  index: 'both',
  family: ANY,
  strategy: 'N:wide',
  slot: ANY,
  weekday: ANY,
  dte: ANY,
  vix: ANY,
  minN: DEFAULT_MIN_N,
  list: ANY,
  basis: 'all',
};

/** Views whose rows and columns do not allow two periods side by side. */
export function canCompare(view: MatrixView): boolean {
  return view !== 'date_slot' && view !== 'pulse';
}

/** The views that take one strategy kind (index and family together) instead of a group. */
export function needsStrategy(view: MatrixView): boolean {
  return view === 'date_slot' || view === 'dte_slot';
}

function put(params: Record<string, string>, key: string, value: string | undefined): void {
  if (value && value !== ANY) params[key] = value;
}

/** The filter part both endpoints share. `strategy` becomes index + family for the single-kind views. */
function filterParams(f: MatrixFilters): Record<string, string> {
  const p: Record<string, string> = {};
  p.view = f.view;
  if (needsStrategy(f.view)) {
    const [idx, fam] = f.strategy.split(':');
    if (idx) p.index = idx === 'S' ? 'SENSEX' : 'NIFTY';
    if (fam) p.family = fam;
  } else {
    if (f.index !== 'both') p.index = f.index;
    put(p, 'family', f.family);
  }
  put(p, 'slot', f.slot);
  put(p, 'weekday', f.weekday);
  put(p, 'dte', f.dte);
  put(p, 'vix_band', f.vix);
  if (f.list !== ANY) {
    p.list = f.list;
    // selection frequency is already about the picks: the API refuses "selected only" with it
    if (f.basis === 'selected' && f.metric !== 'selection') p.basis = 'selected';
  }
  return p;
}

/** `compare` and `period` for the matrix request: a custom range, one period, or P1 and P2. */
export function periodParams(f: MatrixFilters): Record<string, string> {
  if (f.compare && canCompare(f.view)) return { compare: 'P1,P2' };
  const p: Record<string, string> = { period: f.period };
  if (f.period === 'custom') {
    if (f.from) p.from = f.from;
    if (f.to) p.to = f.to;
  }
  return p;
}

export function matrixParams(f: MatrixFilters): Record<string, string> {
  const metric = f.metric === 'selection' && f.list === ANY ? 'avg' : f.metric;
  // The pulse is as of one day, whatever the period: the date is its only time input.
  const time = f.view === 'pulse' ? (f.to ? { to: f.to } : {}) : periodParams(f);
  const p: Record<string, string> = { ...filterParams(f), ...time, metric };
  if (f.minN !== DEFAULT_MIN_N) p.min_n = String(f.minN);
  return p;
}

export function cellParams(
  f: MatrixFilters,
  row: string,
  col: string,
  period: MatrixPeriodId,
): Record<string, string> {
  const p: Record<string, string> = { ...filterParams(f), row, col };
  // the pulse is as of one day: it has no period to send
  if (f.view !== 'pulse') p.period = period;
  if (period === 'custom') {
    if (f.from) p.from = f.from;
    if (f.to) p.to = f.to;
  }
  if (f.view === 'pulse' && f.to) p.to = f.to;
  return p;
}

/** `?a=1&b=2`; URLSearchParams percent-encodes "+" and "<", which DTE and VIX labels contain. */
export function toQuery(params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const text = q.toString();
  return text ? `?${text}` : '';
}

// --- colour bands ------------------------------------------------------------------------------

/** |value| / limit at or below which a cell is the neutral tint, then the edges of bands 1..4. */
export const BAND_EDGES = [0.12, 0.3, 0.55, 0.8] as const;

/** 0 is neutral; 1..4 grow with |value| / limit. The sign is the caller's. */
export function bandOf(value: number | null | undefined, limit: number): 0 | 1 | 2 | 3 | 4 {
  if (value === null || value === undefined || !Number.isFinite(value) || !(limit > 0)) return 0;
  const r = Math.abs(value) / limit;
  if (r <= BAND_EDGES[0]) return 0;
  if (r <= BAND_EDGES[1]) return 1;
  if (r <= BAND_EDGES[2]) return 2;
  if (r <= BAND_EDGES[3]) return 3;
  return 4;
}

// Written in full: Tailwind finds a class only as a complete string in the source.
const POSITIVE = [
  'bg-surface-2',
  'bg-positive/10',
  'bg-positive/20',
  'bg-positive/30',
  'bg-positive/40',
];
const NEGATIVE = [
  'bg-surface-2',
  'bg-negative/10',
  'bg-negative/20',
  'bg-negative/30',
  'bg-negative/40',
];
const SEQUENTIAL = [
  'bg-surface-2',
  'bg-series-1/10',
  'bg-series-1/20',
  'bg-series-1/30',
  'bg-series-1/40',
];
const SERIES_UP = SEQUENTIAL;
const SERIES_DOWN = [
  'bg-surface-2',
  'bg-series-2/10',
  'bg-series-2/20',
  'bg-series-2/30',
  'bg-series-2/40',
];

/** The background class of a value on a scale. ₹ is diverging around zero (green profit, red
 * loss); a rate is sequential from zero. A difference of rates uses the two series tints, never
 * profit/loss, because "more stops" is not a gain. */
export function toneClass(
  value: number | null | undefined,
  scale: MatrixScale | null,
  unit: MatrixUnit,
  difference = false,
): string {
  if (!scale) return 'bg-surface-2';
  const band = bandOf(value, scale.limit);
  const v = value ?? 0;
  if (difference) {
    if (unit === 'inr') return (v >= 0 ? POSITIVE : NEGATIVE)[band] as string;
    return (v >= 0 ? SERIES_UP : SERIES_DOWN)[band] as string;
  }
  if (scale.kind === 'diverging') return (v >= 0 ? POSITIVE : NEGATIVE)[band] as string;
  return SEQUENTIAL[band] as string;
}

/** The value in the middle of a band, as a multiple of the scale's limit. */
function bandCentre(band: 1 | 2 | 3 | 4): number {
  const lower = BAND_EDGES[band - 1] as number;
  const upper = band === 4 ? 1 : (BAND_EDGES[band] as number);
  return (lower + upper) / 2;
}

/** The legend's swatches, from one end of the scale to the other, each with a value inside it. */
export function legendSwatches(
  scale: MatrixScale | null,
  unit: MatrixUnit,
  difference = false,
): { className: string; edge: number }[] {
  if (!scale || !(scale.limit > 0)) return [];
  const swatch = (v: number) => ({
    className: toneClass(v, scale, unit, difference),
    edge: v,
  });
  const ups = ([1, 2, 3, 4] as const).map((b) => bandCentre(b) * scale.limit);
  if (scale.kind === 'diverging' || difference) {
    return [...[...ups].reverse().map((v) => swatch(-v)), swatch(0), ...ups.map(swatch)];
  }
  return [swatch(0), ...ups.map(swatch)];
}

// --- a cell's face ---------------------------------------------------------------------------

export type CellKind = 'value' | 'missing' | 'excluded' | 'na';

export function cellKind(cell: MatrixCell | MatrixDiffCell | null | undefined): CellKind {
  if (!cell) return 'na';
  if (cell.st === 'na') return 'na';
  if (cell.st === 'missing') return 'missing';
  if (cell.st === 'excluded') return 'excluded';
  return cell.v === null || cell.v === undefined ? 'missing' : 'value';
}

/** A cell with fewer sessions than the minimum is thin. The API sets the flag; this recomputes it
 * for the places that change the minimum without a round trip. */
export function isThin(n: number | undefined | null, minN: number): boolean {
  return typeof n === 'number' && n < minN;
}

/** A difference cell's smaller sample: the thinner of the two periods decides. */
export function thinnest(n: [number, number] | undefined): number | null {
  return n ? Math.min(n[0], n[1]) : null;
}

/** The text printed in a cell: signed whole rupees (no ₹: the header names the unit) or whole
 * percent. A difference of rates is in percentage points. */
export function cellText(
  value: number | null | undefined,
  unit: MatrixUnit,
  difference = false,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '';
  if (unit === 'inr') {
    const r = Math.round(value);
    return r === 0 ? '0' : formatNumber(r, 0, { sign: true });
  }
  if (difference) return formatPp(value, 0).replace(' pp', '');
  return formatPct(value, 0).replace('%', '');
}

/** The value with its unit, for a sentence or a tooltip. */
export function valueText(
  value: number | null | undefined,
  unit: MatrixUnit,
  difference = false,
): string {
  if (value === null || value === undefined) return '—';
  if (unit === 'inr') return formatInr(Math.round(value), { sign: true });
  return difference ? formatPp(value, 1) : formatPct(value, 1);
}

// --- reading a response ------------------------------------------------------------------------

export function okMatrices(r: MatrixResponse) {
  return r.matrices.filter((m) => m.status === 'ok');
}

/** Metrics where the largest value is the interesting end. For the worst day it is the lowest. */
const LOW_IS_NOTABLE: ReadonlySet<MatrixMetric> = new Set(['worst']);

function describe(_metric: MatrixMetric, unit: MatrixUnit, value: number): string {
  return valueText(value, unit);
}

function best<T extends { cell: MatrixCell | null; label: string }>(
  items: T[],
  metric: MatrixMetric,
): { item: T; thin: boolean } | null {
  const have = items.filter((i) => i.cell && i.cell.v !== null && i.cell.v !== undefined);
  if (have.length === 0) return null;
  const solid = have.filter((i) => !i.cell?.thin);
  const pool = solid.length > 0 ? solid : have;
  const sign = LOW_IS_NOTABLE.has(metric) ? -1 : 1;
  const top = pool.reduce((a, b) => (sign * (b.cell?.v ?? 0) > sign * (a.cell?.v ?? 0) ? b : a));
  return { item: top, thin: solid.length === 0 };
}

const LEADS: Record<MatrixMetric, string> = {
  avg: 'leads',
  win_rate: 'wins most often',
  stop_rate: 'is stopped most often',
  worst: 'has the deepest worst day',
  selection: 'is picked most often',
};

/**
 * Plain-words readings of the grids, each stating its numbers and its sample. One line per
 * period, then one line on whether the leader is the same in both. Describes; never advises.
 */
export function insightLines(r: MatrixResponse): string[] {
  const lines: string[] = [];
  const per: { id: MatrixPeriodId; leader: string | null }[] = [];
  const unitWord = r.metric === 'avg' || r.metric === 'worst' ? ' per one-lot strategy-day' : '';
  for (const g of okMatrices(r)) {
    const label = r.periods.find((p) => p.id === g.period)?.label.split(' · ')[0] ?? g.period;
    const sessions = g.sessions ?? 0;
    let text: string | null = null;
    let leaderKey: string | null = null;
    const rowItems = r.rows.map((row, i) => ({
      label: row.label,
      cell: g.row_summary?.[i] ?? null,
    }));
    const colItems = r.cols.map((col, i) => ({
      label: col.label,
      cell: g.col_summary?.[i] ?? null,
    }));
    if (
      r.view === 'family_slot' ||
      r.view === 'dte_slot' ||
      r.view === 'vix_family' ||
      r.view === 'weekday_family'
    ) {
      const b = best(rowItems, r.metric);
      if (b?.item.cell) {
        const c = b.item.cell;
        leaderKey = b.item.label;
        const v = describe(r.metric, r.unit, c.v as number);
        text = `${label}: ${b.item.label} ${LEADS[r.metric]} at ${v}${unitWord} over ${c.n ?? 0} sessions${b.thin ? ' (below the minimum sample)' : ''}`;
        if (r.view === 'vix_family' || r.view === 'weekday_family') {
          const f = best(colItems, r.metric);
          if (f?.item.cell) {
            text += `; by family, ${f.item.label} at ${describe(r.metric, r.unit, f.item.cell.v as number)}`;
          }
        } else {
          const s = best(colItems, r.metric);
          if (s?.item.cell && r.view !== 'dte_slot') {
            text += `; the strongest start time across kinds is ${s.item.label} at ${describe(r.metric, r.unit, s.item.cell.v as number)}`;
          }
        }
      }
    } else if (r.view === 'date_slot') {
      const s = best(colItems, r.metric);
      if (s?.item.cell) {
        leaderKey = s.item.label;
        text = `${label}: across ${sessions} sessions the start time ${LEADS[r.metric]} is ${s.item.label} at ${describe(r.metric, r.unit, s.item.cell.v as number)}${unitWord}`;
      }
    } else if (r.view === 'pulse') {
      // rows are kinds, columns the windows: read the 21-session column against all days
      const w = r.cols.findIndex((c) => c.key === '21');
      const all = r.cols.findIndex((c) => c.key === 'all');
      const cells = r.rows.map((row, i) => ({ label: row.label, cell: g.cells?.[i]?.[w] ?? null }));
      const b = best(cells, r.metric);
      if (b?.item.cell) {
        const base = g.cells?.[r.rows.findIndex((x) => x.label === b.item.label)]?.[all];
        leaderKey = b.item.label;
        text = `Last 21 sessions: ${b.item.label} ${LEADS[r.metric]} at ${describe(r.metric, r.unit, b.item.cell.v as number)}${unitWord} (${b.item.cell.n ?? 0} sessions)`;
        if (base?.v !== undefined && base.v !== null) {
          text += `, against ${describe(r.metric, r.unit, base.v)} over all stored days`;
        }
      }
    }
    if (text) lines.push(text);
    per.push({ id: g.period, leader: leaderKey });
  }
  const [a, b] = per;
  if (a && b && a.leader && b.leader) {
    lines.push(
      a.leader === b.leader
        ? `The same one leads in both periods: ${a.leader}.`
        : `The leader changes with the period: ${a.leader} in ${a.id}, ${b.leader} in ${b.id}.`,
    );
  }
  return lines;
}

// --- the drawer ------------------------------------------------------------------------------

export interface HistogramBin {
  lo: number;
  hi: number;
  count: number;
}

/** Equal-width bins over the values' range. Empty input gives no bins; one repeated value gives
 * a single bin. */
export function histogram(values: readonly number[], bins = 12): HistogramBin[] {
  if (values.length === 0) return [];
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  if (lo === hi) return [{ lo, hi, count: values.length }];
  const width = (hi - lo) / bins;
  const out: HistogramBin[] = Array.from({ length: bins }, (_, i) => ({
    lo: lo + i * width,
    hi: lo + (i + 1) * width,
    count: 0,
  }));
  for (const v of values) {
    const i = Math.min(bins - 1, Math.floor((v - lo) / width));
    (out[i] as HistogramBin).count += 1;
  }
  return out;
}

/** Days that were stopped, as a share of all days with a value. */
export function stoppedShare(days: readonly MatrixCellDay[]): number | null {
  if (days.length === 0) return null;
  return days.filter((d) => d.n_stopped > 0).length / days.length;
}

/** x / y positions of a running total inside a w x h box, zero line included. */
export function curveGeometry(
  points: readonly { cum: number | null }[],
  w: number,
  h: number,
): { path: string; zeroY: number; min: number; max: number } | null {
  const vals = points.map((p) => p.cum).filter((v): v is number => v !== null);
  if (vals.length < 2) return null;
  const min = Math.min(0, ...vals);
  const max = Math.max(0, ...vals);
  const span = max - min || 1;
  const x = (i: number) => (i * w) / (points.length - 1);
  const y = (v: number) => h - ((v - min) / span) * h;
  const path = points
    .map((p, i) => (p.cum === null ? null : `${x(i).toFixed(1)},${y(p.cum).toFixed(1)}`))
    .filter((s): s is string => s !== null)
    .join(' ');
  return { path, zeroY: y(0), min, max };
}

// --- keyboard and screen readers --------------------------------------------------------------

/**
 * The cell that holds the grid's single tab stop: `active` clamped into the grid, and moved
 * forward to the next cell that can take focus when it lands on a not-applicable one (a
 * disabled button cannot be focused, which would leave the grid with no tab stop at all).
 */
export function settleActive(
  active: readonly [number, number],
  kinds: readonly (readonly CellKind[])[],
): [number, number] {
  const rows = kinds.length;
  const cols = kinds[0]?.length ?? 0;
  if (rows === 0 || cols === 0) return [0, 0];
  const r0 = Math.min(Math.max(active[0], 0), rows - 1);
  const c0 = Math.min(Math.max(active[1], 0), cols - 1);
  for (let k = 0; k < rows * cols; k++) {
    const i = r0 * cols + c0 + k;
    const r = Math.floor(i / cols) % rows;
    const c = i % cols;
    if (kinds[r]?.[c] !== 'na') return [r, c];
  }
  return [r0, c0];
}

/** The next focusable cell from (r, c) one arrow step away, skipping not-applicable cells. */
export function stepActive(
  from: readonly [number, number],
  d: readonly [number, number],
  kinds: readonly (readonly CellKind[])[],
): [number, number] {
  const rows = kinds.length;
  const cols = kinds[0]?.length ?? 0;
  let r = from[0];
  let c = from[1];
  for (;;) {
    r += d[0];
    c += d[1];
    if (r < 0 || c < 0 || r >= rows || c >= cols) return [from[0], from[1]];
    if (kinds[r]?.[c] !== 'na') return [r, c];
  }
}

/** A cell's accessible name: the value, the sample, the thin state, and who picked it. */
export function cellLabel(
  rowLabel: string,
  colLabel: string,
  cell: MatrixCell | MatrixDiffCell | null | undefined,
  unit: MatrixUnit,
  difference: boolean,
  picks?: readonly string[] | undefined,
): string {
  const head = `${rowLabel}, ${colLabel}`;
  const kind = cellKind(cell);
  if (!cell || kind === 'na') return `${head}: not applicable`;
  if (kind !== 'value')
    return `${head}: ${cell.st === 'excluded' ? 'excluded' : 'missing'}, ${cell.reason ?? 'no value'}`;
  const d = cell as MatrixDiffCell;
  const c = cell as MatrixCell;
  const sample =
    d.n && Array.isArray(d.n) ? `${d.n[0]} and ${d.n[1]} sessions` : `${c.n ?? 0} sessions`;
  const parts = [`${valueText(cell.v, unit, difference)}`, sample];
  if (cell.thin) parts.push('thin sample');
  if (c.all && c.all.n !== c.n) parts.push(`of ${c.all.n} sessions`);
  if (picks && picks.length > 0) parts.push(`picked by ${picks.join(' and ')}`);
  else if (c.sel) {
    const named = Object.entries(c.sel).map(([k, v]) => `${k} ${v} times`);
    if (named.length > 0) parts.push(`picked: ${named.join(', ')}`);
  }
  return `${head}: ${parts.join(', ')}`;
}

/** What the legend must say about the scale: which cells did not set it and what is clipped. */
export function scaleNotes(scale: MatrixScale | null, unit: MatrixUnit): string[] {
  if (!scale) return [];
  const notes: string[] = [];
  const top = valueText(scale.limit, unit);
  if (scale.clipped && scale.percentile) {
    notes.push(
      `Scale clipped at the ${scale.percentile}th percentile of |value| (${top}): a darker cell can be larger.`,
    );
  }
  if (scale.thin_excluded) {
    notes.push('Thin cells do not set the scale, so they can exceed it.');
  }
  return notes;
}
