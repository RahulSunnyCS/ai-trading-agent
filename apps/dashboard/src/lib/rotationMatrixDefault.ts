/**
 * Pure helpers for Options Lab › Matrix's default view: today's performance, as a single day.
 *
 * The page opens on the latest scored session (`period=custom`, `from = to = that day`, and
 * `min_n=1`, since one session cannot be a thin sample of itself) whenever the URL names no
 * period. The latest scored day comes from one small `date_slot` request (the matrix API has no
 * "days" endpoint): its rows are the stored dates and `meta.store.last` is the newest. Nothing
 * here computes a P&L; the figures stay `rotation/matrix.py`'s.
 */

import type { MatrixResult } from '../types/rotationMatrix';
import { formatDay, istToday } from './format';
import { addDays } from './regimeTags';
import {
  ANY,
  DEFAULT_FILTERS,
  DEFAULT_MIN_N,
  type MatrixFilters,
  canCompare,
  matrixParams,
  needsStrategy,
} from './rotationMatrixView';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** How far back the probe looks (calendar days: 63 sessions is about 90). */
const PROBE_DAYS = 130;

export function isDay(value: string | null | undefined): value is string {
  return typeof value === 'string' && DAY_RE.test(value);
}

/** Today's date in India (the exchange's calendar), as YYYY-MM-DD. */
export function todayIst(now: number = Date.now()): string {
  return istToday(new Date(now));
}

/** The request that lists the scored sessions of the last ~130 calendar days. */
export function probeParams(today: string): Record<string, string> {
  return matrixParams({
    ...DEFAULT_FILTERS,
    view: 'date_slot',
    strategy: 'N:wide',
    period: 'custom',
    from: addDays(today, -PROBE_DAYS),
  });
}

/** The scored sessions the store holds, ascending; `last` is the newest. */
export interface Sessions {
  days: string[];
  last: string | null;
}

export const NO_SESSIONS: Sessions = { days: [], last: null };

/** The session list a probe answer holds; empty while it is not there or the store is empty. */
export function parseSessions(result: MatrixResult | null | undefined): Sessions {
  if (!result) return NO_SESSIONS;
  const store = result.meta.store;
  if (!result.available) return { days: [], last: store.last };
  const days = result.rows
    .map((row) => row.date)
    .filter(isDay)
    .sort();
  return { days, last: days[days.length - 1] ?? store.last ?? null };
}

/** Which settings the URL names itself; the rest take the page's defaults. */
export interface Explicit {
  /** A `period` key, or P1 and P2 side by side (`cmp=1`). */
  period: boolean;
  /** A `minn` key. */
  minN: boolean;
}

/** True when the view takes a period and the URL names none, so today's session applies. */
export function usesTodayDefault(f: MatrixFilters, explicit: Explicit): boolean {
  return !explicit.period && f.view !== 'pulse';
}

/**
 * The filters the page asks the API for. With no period in the URL: the latest scored session
 * as one day. A single custom day with no `minn` in the URL asks for `min_n=1`; any other
 * selection keeps the API's default minimum.
 */
export function effectiveFilters(
  f: MatrixFilters,
  explicit: Explicit,
  latestDay: string | null,
): MatrixFilters {
  let out = f;
  if (usesTodayDefault(f, explicit) && latestDay) {
    out = { ...f, period: 'custom', from: latestDay, to: latestDay, compare: false };
  }
  const oneDay =
    out.view !== 'pulse' &&
    !(out.compare && canCompare(out.view)) &&
    out.period === 'custom' &&
    out.from !== '' &&
    out.from === out.to;
  if (oneDay && !explicit.minN) out = { ...out, minN: 1 };
  return out;
}

// --- presets ---------------------------------------------------------------------------------

export type MatrixPreset = 'latest' | 'last5' | 'last21' | 'last63' | 'P1' | 'P2' | 'forward';

export const PRESET_OPTIONS: { value: MatrixPreset; label: string }[] = [
  { value: 'latest', label: 'Latest day' },
  { value: 'last5', label: 'Last 5 sessions' },
  { value: 'last21', label: 'Last 21' },
  { value: 'last63', label: 'Last 63' },
  { value: 'P1', label: 'P1' },
  { value: 'P2', label: 'P2' },
  { value: 'forward', label: 'Forward' },
];

const LAST_N: Record<string, number> = { last5: 5, last21: 21, last63: 63 };

/**
 * The filter patch a preset means, or null for "Latest day" (which is the URL with no period:
 * it keeps following the newest session). The last N sessions are the N newest scored days.
 */
export function presetPatch(
  preset: MatrixPreset,
  sessions: Sessions,
): Partial<MatrixFilters> | null {
  if (preset === 'latest') return null;
  if (preset === 'P1' || preset === 'P2' || preset === 'forward') {
    return { period: preset, compare: false, from: '', to: '' };
  }
  const n = LAST_N[preset] ?? 1;
  const last = sessions.last;
  if (!last) return { period: 'custom', compare: false };
  const from = sessions.days.filter((d) => d <= last).slice(-n)[0] ?? last;
  return { period: 'custom', compare: false, from, to: last };
}

// --- words -----------------------------------------------------------------------------------

/** Said when the default day is not today: which scored day this is, and why. */
export function latestDayNote(day: string, today: string): string | null {
  if (day === today) return null;
  return `Showing the latest scored session, ${formatDay(day)}. Today (${formatDay(today)}) has no scored session yet: a weekend or holiday, or the evening run has not finished.`;
}

export const FALLBACK_NOTE =
  'The latest scored session could not be found, so this shows P1. Choose a period in Settings.';

function indexText(index: MatrixFilters['index']): string {
  return index === 'both' ? 'Both indices' : index;
}

/**
 * The active settings in a line for the run bar: "Today · 12 Oct 2026 · Both indices · All
 * families". `familyLabel` and `strategyLabel` are the display names of the selected family /
 * strategy kind, supplied by the caller (they come from the API's meta).
 */
export function settingsSummary(
  f: MatrixFilters,
  ctx: { today: string; familyLabel?: string; strategyLabel?: string },
): string {
  const parts: string[] = [];
  if (f.view === 'pulse') {
    parts.push(f.to ? `As of ${formatDay(f.to)}` : 'As of the latest day');
  } else if (f.compare && canCompare(f.view)) {
    parts.push('P1 and P2');
  } else if (f.period === 'custom') {
    if (f.from && f.from === f.to) {
      parts.push(
        f.from === ctx.today ? `Today · ${formatDay(f.from)}` : `Session of ${formatDay(f.from)}`,
      );
    } else if (f.from && f.to) parts.push(`${formatDay(f.from)} to ${formatDay(f.to)}`);
    else if (f.from) parts.push(`From ${formatDay(f.from)}`);
    else if (f.to) parts.push(`Up to ${formatDay(f.to)}`);
    else parts.push('All stored days');
  } else {
    parts.push(f.period === 'forward' ? 'Forward' : f.period);
  }
  if (needsStrategy(f.view)) parts.push(ctx.strategyLabel ?? f.strategy);
  else {
    parts.push(indexText(f.index));
    parts.push(f.family === ANY ? 'All families' : (ctx.familyLabel ?? f.family));
  }
  if (f.slot !== ANY) parts.push(f.slot.includes(',') ? 'A start band' : `Start ${f.slot}`);
  if (f.weekday !== ANY) parts.push(f.weekday);
  if (f.dte !== ANY) parts.push(`DTE ${f.dte}`);
  if (f.vix !== ANY) parts.push(`VIX ${f.vix}`);
  if (f.list !== ANY) parts.push(`List ${f.list} picks`);
  return parts.join(' · ');
}

/** How many settings differ from the page's opening view, for the Settings button's badge. */
export function changedCount(f: MatrixFilters, explicit: Explicit): number {
  const d = DEFAULT_FILTERS;
  const checks: boolean[] = [
    explicit.period,
    f.index !== d.index,
    f.family !== d.family,
    needsStrategy(f.view) && f.strategy !== d.strategy,
    f.slot !== d.slot,
    f.weekday !== d.weekday,
    f.dte !== d.dte,
    f.vix !== d.vix,
    f.list !== d.list,
    f.basis !== d.basis,
    explicit.minN && f.minN !== DEFAULT_MIN_N,
  ];
  return checks.filter(Boolean).length;
}
