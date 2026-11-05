/**
 * The Books table's head-to-head with the fixed base: the window picker, what each cell and card
 * says, and the drift alarm's wording. Pure, so it is unit-tested; every figure is the API's
 * (`rotation/beats.py`), nothing is recomputed. A range that includes zero is said so: it means
 * "not distinguishable from the base", never "a little better".
 */

import type {
  AlarmState,
  CompareBook,
  CompareBookFigures,
  CompareWindow,
  RotationCompareResponse,
} from '../types/rotationCompare';
import { formatDay, formatInr, formatNumber } from './format';

export const COMPARE_WINDOWS: ReadonlyArray<{
  value: CompareWindow;
  label: string;
  /** In the column header: "6 months vs base / lot-day". */
  long: string;
}> = [
  { value: 'sessions60', label: '60 sessions', long: '60 sessions' },
  { value: 'months6', label: '6 months', long: '6 months' },
  { value: 'year1', label: '1 year', long: '1 year' },
  { value: 'years2', label: '2 years', long: '2 years' },
];

export const DEFAULT_COMPARE_WINDOW: CompareWindow = 'months6';

export type CompareRead = {
  data: RotationCompareResponse | null;
  loading: boolean;
  error: string | null;
};

export function windowLabel(w: CompareWindow): string {
  return COMPARE_WINDOWS.find((o) => o.value === w)?.long ?? w;
}

/** Why a book's history figures should be read with care. */
export const BOOK_CAVEAT: Record<CompareBook, string> = {
  t1: 'in-sample: tuned on this history',
  core: 'mostly the rule re-derived',
  base: 'fixed rule',
};

export interface GapCell {
  kind: 'gap' | 'base' | 'none' | 'loading' | 'error';
  text?: string;
  money?: number;
  range?: string;
  /** The range includes zero: not distinguishable from the base. */
  includesZero?: boolean;
}

export function rangeText(f: CompareBookFigures): { text: string; includesZero: boolean } | null {
  if (f.gap_lower === undefined || f.gap_upper === undefined) return null;
  const includesZero = f.gap_lower <= 0 && f.gap_upper >= 0;
  return {
    text: `${formatInr(f.gap_lower, { sign: true })} to ${formatInr(f.gap_upper, { sign: true })}`,
    includesZero,
  };
}

/** One Books cell of the gap column for the picked window. */
export function gapCell(
  read: CompareRead | undefined,
  book: CompareBook,
  w: CompareWindow,
): GapCell {
  if (book === 'base') return { kind: 'base' };
  if (!read) return { kind: 'none' };
  if (read.error && !read.data) return { kind: 'error', text: read.error };
  if (!read.data) return read.loading ? { kind: 'loading' } : { kind: 'none' };
  const f = read.data.windows[w]?.books[book];
  if (!f || f.gap_mean === undefined) return { kind: 'none' };
  const r = rangeText(f);
  return {
    kind: 'gap',
    money: f.gap_mean,
    ...(r ? { range: r.text, includesZero: r.includesZero } : {}),
  };
}

/** "2.6 σ", or null where the window had no spread to measure against. */
export function sigmaText(f: CompareBookFigures | undefined): string | null {
  if (!f || f.edge_sigma === null) return null;
  return `${formatNumber(f.edge_sigma, 1)} σ`;
}

/** The sentence under the head-to-head: how many of the window's sessions were live. */
export function liveShare(
  row: { days: number; books: Record<CompareBook, CompareBookFigures> } | undefined,
): string {
  if (!row) return '';
  const t1 = row.books.t1.recorded_days;
  const core = row.books.core.recorded_days;
  return `Most of these ${row.days} sessions are stored results replayed through the 09:16 rule, not live picks; ${t1} (Tuned) and ${core} (Classic) were recorded live.`;
}

export function windowSubtitle(
  data: RotationCompareResponse | null,
  w: CompareWindow,
): string | null {
  const row = data?.windows[w];
  if (!data || !row) return null;
  return `${windowLabel(w)} · ${row.days} sessions from ${formatDay(row.from)}${
    data.last_day ? ` to ${formatDay(data.last_day)}` : ''
  }`;
}

export const ALARM_WORDS: Record<
  AlarmState,
  { label: string; tone: 'positive' | 'warning' | 'negative' }
> = {
  quiet: { label: 'quiet', tone: 'positive' },
  watch: { label: 'watch', tone: 'warning' },
  review: { label: 'review', tone: 'negative' },
};

export function alarmLine(below: number, window: number): string {
  return `Pre-set rule: two sessions in a row with the ${window}-session gap to the base below ${formatInr(below)} per lot-day opens a review. Read the number only when the alarm says so.`;
}
