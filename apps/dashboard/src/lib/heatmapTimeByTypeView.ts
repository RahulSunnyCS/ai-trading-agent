/**
 * Pure helpers for Options Lab › Heatmap › "Entry time by strategy type" (BL-094 second chart).
 *
 * The figures are the Strategy Matrix's (`GET /legwise/rotation/matrix`, view `family_slot`,
 * metric `avg`): this file only chooses what to ask for. It turns the reader's pick (latest day,
 * last N sessions, P1 / P2, one day, a range) into matrix filters, names the session list from a
 * date-view probe, and writes the strategy names the owner uses (`N_wide (OTM1)`, `N_p80`).
 * Nothing here computes a P&L; the colours, thin flag and tooltips are `rotationMatrixView`'s.
 */

import type { MatrixAxisItem, MatrixResponse, MatrixResult } from '../types/rotationMatrix';
import { formatDay } from './format';
import {
  DEFAULT_FILTERS,
  DEFAULT_MIN_N,
  type MatrixFilters,
  matrixParams,
} from './rotationMatrixView';

export type TimeByTypePreset = 'latest' | 'last5' | 'last21' | 'last63' | 'P1' | 'P2';
export type TimeByTypeMode = TimeByTypePreset | 'day' | 'range';

export const PRESET_OPTIONS: { value: TimeByTypePreset; label: string }[] = [
  { value: 'latest', label: 'Latest day' },
  { value: 'last5', label: 'Last 5' },
  { value: 'last21', label: 'Last 21' },
  { value: 'last63', label: 'Last 63' },
  { value: 'P1', label: 'P1' },
  { value: 'P2', label: 'P2' },
];

const LAST_N: Partial<Record<TimeByTypePreset, number>> = { last5: 5, last21: 21, last63: 63 };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** What the URL holds: any of these may be null (absent). */
export interface TimeByTypeInput {
  preset: string | null;
  day: string | null;
  from: string | null;
  to: string | null;
}

/** The scored sessions the store holds, ascending. `last` is the latest scored session. */
export interface Sessions {
  days: string[];
  first: string | null;
  last: string | null;
}

export interface TimeByTypeSelection {
  mode: TimeByTypeMode;
  /** `custom` with from / to, or a named research period. */
  period: 'custom' | 'P1' | 'P2';
  from: string;
  to: string;
  /** One session: the sample is 1, so nothing is flagged thin for being small. */
  single: boolean;
  /** The matrix `min_n` this selection asks for. */
  minN: number;
}

export function isPreset(value: string | null): value is TimeByTypePreset {
  return PRESET_OPTIONS.some((p) => p.value === value);
}

export function isDay(value: string | null | undefined): value is string {
  return typeof value === 'string' && DAY_RE.test(value);
}

/** One session has no sample to be thin about; anything wider keeps the API's default. */
function minNFor(from: string, to: string): number {
  return from === to ? 1 : DEFAULT_MIN_N;
}

/**
 * The selection a URL means. Priority: a preset, then one day, then a range, else the latest
 * scored session. Null while the store's latest day is not known yet.
 */
export function resolveSelection(
  input: TimeByTypeInput,
  sessions: Sessions,
): TimeByTypeSelection | null {
  const last = sessions.last;
  if (!last) return null;
  const preset = isPreset(input.preset) ? input.preset : null;
  if (preset === 'P1' || preset === 'P2') {
    return { mode: preset, period: preset, from: '', to: '', single: false, minN: DEFAULT_MIN_N };
  }
  if (preset === 'last5' || preset === 'last21' || preset === 'last63') {
    const n = LAST_N[preset] as number;
    const recent = sessions.days.filter((d) => d <= last).slice(-n);
    const from = recent[0] ?? last;
    return {
      mode: preset,
      period: 'custom',
      from,
      to: last,
      single: from === last,
      minN: minNFor(from, last),
    };
  }
  if (preset === 'latest' || (!isDay(input.day) && !input.from && !input.to)) {
    return { mode: 'latest', period: 'custom', from: last, to: last, single: true, minN: 1 };
  }
  if (isDay(input.day)) {
    return { mode: 'day', period: 'custom', from: input.day, to: input.day, single: true, minN: 1 };
  }
  let from = isDay(input.from) ? input.from : (sessions.first ?? last);
  let to = isDay(input.to) ? input.to : last;
  if (from > to) [from, to] = [to, from];
  return {
    mode: 'range',
    period: 'custom',
    from,
    to,
    single: from === to,
    minN: minNFor(from, to),
  };
}

/**
 * True when a matrix answer is the one this selection asked for. A polled resource keeps the
 * previous answer while the next loads; the card draws only a matching one.
 */
export function answersSelection(r: MatrixResponse, sel: TimeByTypeSelection): boolean {
  const p = r.periods[0];
  if (!p) return false;
  if (sel.period !== 'custom') return p.id === sel.period;
  return p.id === 'custom' && p.from === sel.from && p.to === sel.to;
}

/** The matrix filters of a selection: both indices, every family, average gross per lot-day. */
export function selectionFilters(sel: TimeByTypeSelection): MatrixFilters {
  return {
    ...DEFAULT_FILTERS,
    view: 'family_slot',
    metric: 'avg',
    period: sel.period,
    from: sel.period === 'custom' ? sel.from : '',
    to: sel.period === 'custom' ? sel.to : '',
    minN: sel.minN,
  };
}

/** The request for the chart. */
export function selectionParams(sel: TimeByTypeSelection): Record<string, string> {
  return matrixParams(selectionFilters(sel));
}

/** How far back the probe looks for sessions (calendar days: 63 sessions is about 90). */
const PROBE_DAYS = 130;

/** An ISO day `delta` days from `day`. */
export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Today's date in India (the exchange's calendar), as YYYY-MM-DD. */
export function todayIst(now: number = Date.now()): string {
  return new Date(now + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * The request that lists the scored sessions: the date view of one strategy kind over the last
 * ~130 calendar days, whose rows are the stored dates and whose `meta.store.last` is the newest.
 * The matrix API has no "days" endpoint, and this is one small response.
 */
export function probeParams(today: string): Record<string, string> {
  return matrixParams({
    ...DEFAULT_FILTERS,
    view: 'date_slot',
    strategy: 'N:wide',
    period: 'custom',
    from: addDays(today, -PROBE_DAYS),
  });
}

/** The session list a probe answer holds; empty while it is not there or the store is empty. */
export function parseSessions(result: MatrixResult | null | undefined): Sessions {
  if (!result) return { days: [], first: null, last: null };
  const store = result.meta.store;
  if (!result.available) return { days: [], first: store.first, last: store.last };
  const days = result.rows
    .map((row) => row.date)
    .filter(isDay)
    .sort();
  const last = store.last ?? days[days.length - 1] ?? null;
  return { days, first: store.first ?? days[0] ?? null, last };
}

// --- names ---------------------------------------------------------------------------------

const STRIKE_RE = /\b(ATM|(?:OTM|ITM)\d+)$/;

/**
 * The owner's strategy-name idiom for a family row: `N_wide (OTM1)`, `N_p80`, `N_dir (ATM)`,
 * `N_ditm1`, `N_buy`, `S_wide (OTM2)`. The index and family come from the row's key
 * (`N:wide`); the strike method is read from the label the API built out of the strategy file,
 * so it is never assumed. Only the two families the owner names with a strike carry one.
 */
export function typeLabel(item: Pick<MatrixAxisItem, 'key' | 'label'>): string {
  const [index, tag] = item.key.split(':');
  if (!index || !tag) return item.label;
  const strike = STRIKE_RE.exec(item.label)?.[1];
  const base = `${index}_${tag}`;
  return (tag === 'wide' || tag === 'dir') && strike ? `${base} (${strike})` : base;
}

/** The same rows with their display names; keys stay the API's so cell requests still match. */
export function typeRows(rows: readonly MatrixAxisItem[]): MatrixAxisItem[] {
  return rows.map((row) => ({ ...row, label: typeLabel(row) }));
}

// --- words ---------------------------------------------------------------------------------

/** What the card is showing, in a line: the session, the range, or the named period. */
export function selectionTitle(sel: TimeByTypeSelection, periodLabel?: string): string {
  if (sel.mode === 'P1' || sel.mode === 'P2') return periodLabel ?? sel.mode;
  if (sel.single) return `Session of ${formatDay(sel.from)}`;
  return `${formatDay(sel.from)} to ${formatDay(sel.to)}`;
}

/** Said when the default day is not today: which scored day this is and why. */
export function latestNote(sel: TimeByTypeSelection, today: string): string | null {
  if (sel.mode !== 'latest' || sel.from === today) return null;
  return `Showing the latest scored session, ${formatDay(sel.from)}. No results are stored for today (${formatDay(today)}) yet.`;
}

/** Said when every cell is flagged thin only because the range is short. */
export function thinNote(sel: TimeByTypeSelection, sessions: number | undefined): string | null {
  if (sel.single || sel.minN <= 1) return null;
  if (sessions === undefined || sessions >= sel.minN) return null;
  return `Under ${sel.minN} sessions: every cell is flagged thin (muted, italic), so read it as a description of these days, not a pattern.`;
}
