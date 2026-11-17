/**
 * The Live board's picks × time matrix (BL-231 Phase 6), kept pure so it is tested without a DOM.
 * Every figure is read off the snapshot's minute curves (`LivePick.curve`: [session minute, ₹ at
 * one lot], before slippage); nothing is worked out here except bucketing, carrying a value
 * forward and multiplying a per-lot figure by the lots the API says a pick trades. A cell before a
 * pick enters is empty, never zero.
 */

import type { LiveBook, LivePick } from '../types/rotationLiveBoard';
import type { MatrixScale } from '../types/rotationMatrix';
import type { LotsView } from './rotationLiveBoard';
import { toneClass } from './rotationMatrixView';

export const BUCKETS = [5, 15, 30] as const;
export type Bucket = (typeof BUCKETS)[number];
export const DEFAULT_BUCKET: Bucket = 15;

/** The session opens at 09:15 IST: minute 0. */
const OPEN_MINUTES = 9 * 60 + 15;

export function minuteLabel(minute: number): string {
  const t = OPEN_MINUTES + minute;
  const h = Math.floor(t / 60);
  const m = t % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "HH:MM" -> session minute (09:15 = 0). */
export function labelMinute(label: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(label);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]) - OPEN_MINUTES;
}

/**
 * The last complete bar's session minute. The snapshot's `as_of` is the end of that bar ("as at the
 * end of the bar before this minute"), so the bar is one minute earlier; with no `as_of` the
 * newest point on any curve stands in.
 */
export function lastMinute(asOf: string | null, books: LiveBook[]): number | null {
  const fromAsOf = asOf === null ? null : labelMinute(asOf);
  if (fromAsOf !== null) return fromAsOf - 1;
  let newest: number | null = null;
  for (const b of books)
    for (const p of b.picks)
      for (const [m] of p.curve) if (newest === null || m > newest) newest = m;
  return newest;
}

export interface MatrixColumn {
  /** The session minute whose value the column shows (the last bar of its bucket, or `last`) */
  minute: number;
  /** The clock time the bucket ends at ("09:30"); the newest, unfinished column reads its own time */
  label: string;
  /** The bucket is not over yet: its figure is as at the last bar read */
  partial: boolean;
}

/** One column per finished bucket from the open, then the unfinished one up to `last`. */
export function columnsFor(last: number | null, bucket: Bucket): MatrixColumn[] {
  if (last === null || last < 0) return [];
  const out: MatrixColumn[] = [];
  for (let end = bucket - 1; end < last; end += bucket) {
    out.push({ minute: end, label: minuteLabel(end + 1), partial: false });
  }
  const finished = out.length > 0 ? (out[out.length - 1] as MatrixColumn).minute : -1;
  if (last > finished) {
    out.push({ minute: last, label: minuteLabel(last + 1), partial: (last + 1) % bucket !== 0 });
  }
  return out;
}

/** The curve's value at a minute: the last point at or before it, null before the first point. */
export function valueAt(curve: [number, number][], minute: number): number | null {
  let value: number | null = null;
  for (const [m, v] of curve) {
    if (m > minute) break;
    value = v;
  }
  return value;
}

export interface MatrixCell {
  /** null: the pick has not entered yet (or has no curve) */
  value: number | null;
  /** The pick ended before this column: the value is its last, held */
  held: boolean;
}

export interface MatrixRow {
  key: string;
  label: string;
  sub: string;
  state: LivePick['state'];
  cells: MatrixCell[];
  /** The newest column's figure, null when the pick has no figure yet */
  latest: number | null;
}

export interface BookMatrix {
  book: LiveBook['book'];
  name: string;
  columns: MatrixColumn[];
  rows: MatrixRow[];
  /** The book's total per column; null while no pick has entered */
  total: (number | null)[];
}

function pickFactor(pick: LivePick, view: LotsView): number {
  return view === 'yours' ? (pick.lots ?? 0) : 1;
}

function sortedCurve(pick: LivePick): [number, number][] {
  return [...pick.curve].sort((a, b) => a[0] - b[0]);
}

export function buildBookMatrix(
  book: LiveBook,
  columns: MatrixColumn[],
  view: LotsView,
): BookMatrix {
  const rows: MatrixRow[] = book.picks.map((pick) => {
    const curve = sortedCurve(pick);
    const factor = pickFactor(pick, view);
    const endedAt =
      pick.state === 'closed' && curve.length > 0
        ? (curve[curve.length - 1] as [number, number])[0]
        : null;
    const cells = columns.map((col): MatrixCell => {
      const raw = valueAt(curve, col.minute);
      return {
        value: raw === null ? null : raw * factor,
        held: endedAt !== null && col.minute > endedAt,
      };
    });
    return {
      key: `${pick.variant}-${pick.role}`,
      label: pick.label,
      sub: `${pick.variant}${pick.role === 'buy' ? ' · Buy add-on' : ''}`,
      state: pick.state,
      cells,
      latest: cells.length > 0 ? ((cells[cells.length - 1] as MatrixCell).value ?? null) : null,
    };
  });
  const total = columns.map((_, i) => {
    let sum = 0;
    let any = false;
    for (const r of rows) {
      const v = (r.cells[i] as MatrixCell).value;
      if (v !== null) {
        sum += v;
        any = true;
      }
    }
    return any ? sum : null;
  });
  return { book: book.book, name: book.name, columns, rows, total };
}

/** Both books on one set of columns, so the grids line up. */
export function buildMatrices(
  books: LiveBook[],
  asOf: string | null,
  bucket: Bucket,
  view: LotsView,
): BookMatrix[] {
  const columns = columnsFor(lastMinute(asOf, books), bucket);
  return books.map((b) => buildBookMatrix(b, columns, view));
}

/** The tint scale: the largest figure on any pick's row (totals have their own scale, since a
 * total is a sum of rows and would wash every pick out). */
export function pickScale(matrices: BookMatrix[]): MatrixScale | null {
  let limit = 0;
  for (const m of matrices)
    for (const r of m.rows)
      for (const c of r.cells) if (c.value !== null) limit = Math.max(limit, Math.abs(c.value));
  return limit > 0 ? scaleOf(limit) : null;
}

export function totalScale(matrices: BookMatrix[]): MatrixScale | null {
  let limit = 0;
  for (const m of matrices)
    for (const v of m.total) if (v !== null) limit = Math.max(limit, Math.abs(v));
  return limit > 0 ? scaleOf(limit) : null;
}

function scaleOf(limit: number): MatrixScale {
  return { kind: 'diverging', min: -limit, max: limit, limit, clipped: false };
}

/** A cell's background: the diverging profit / loss tint, or the neutral surface when empty. */
export function cellTone(value: number | null, scale: MatrixScale | null): string {
  if (value === null) return 'bg-transparent';
  return toneClass(value, scale, 'inr');
}
