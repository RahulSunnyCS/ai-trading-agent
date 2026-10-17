/**
 * Pure helpers for the Live page: what the page shows at one minute of a day, and the points each
 * chart draws up to that minute. No React, no fetching. The series come from live/session.py; this
 * only reads them (a change since 09:15, the range so far, which points are drawn).
 *
 * A gap in the data (a leg that had not traded, a strike that was not collected) stays a gap: it
 * is never carried forward or filled, in a figure or in a chart.
 */

import type { LiveSessionResponse, StraddleSide } from '../types/liveSession';

export interface ChartPoint {
  /** Epoch seconds (UTC), what Lightweight Charts takes. */
  time: number;
  value: number;
}

export interface Change {
  /** In the series' own unit (points, rupees, VIX points). */
  abs: number;
  /** Percent of the reference. */
  pct: number | null;
}

export interface LiveFrame {
  minute: number;
  time: number;
  spot: number | null;
  spotChange: Change | null;
  vix: number | null;
  vixChange: Change | null;
  atm: number | null;
  rolling: { ce: number | null; pe: number | null; straddle: number | null; change: Change | null };
  fixed: {
    strike: number | null;
    ce: number | null;
    pe: number | null;
    straddle: number | null;
    change: Change | null;
  };
  /** The rolling straddle as a percent of spot: the move it prices in for the rest of the expiry. */
  straddlePctOfSpot: number | null;
  range: {
    soFar: number | null;
    /** `soFar` over the median full-session range of the last 20 sessions. */
    versusMedian: number | null;
  };
}

function change(now: number | null, reference: number | null | undefined): Change | null {
  if (now === null || reference === null || reference === undefined) return null;
  return {
    abs: now - reference,
    pct: reference !== 0 ? ((now - reference) / reference) * 100 : null,
  };
}

function at<T>(values: ReadonlyArray<T | null> | null | undefined, minute: number): T | null {
  if (!values) return null;
  return values[minute] ?? null;
}

function firstNumber(values: ReadonlyArray<number | null> | null | undefined): number | null {
  if (!values) return null;
  for (const v of values) if (v !== null) return v;
  return null;
}

/** The minute to show, kept inside the day. */
export function clampMinute(minute: number, session: Pick<LiveSessionResponse, 'last_minute'>) {
  return Math.min(Math.max(Math.round(minute), 0), session.last_minute);
}

/** The range from the open to `minute`: the day's high minus its low so far. */
export function rangeSoFar(
  high: ReadonlyArray<number | null>,
  low: ReadonlyArray<number | null>,
  minute: number,
): number | null {
  let hi = Number.NEGATIVE_INFINITY;
  let lo = Number.POSITIVE_INFINITY;
  for (let i = 0; i <= minute; i++) {
    const h = high[i];
    const l = low[i];
    if (h !== null && h !== undefined) hi = Math.max(hi, h);
    if (l !== null && l !== undefined) lo = Math.min(lo, l);
  }
  return Number.isFinite(hi) && Number.isFinite(lo) ? hi - lo : null;
}

/** Everything the headline strip and the legs table show at `minute`. */
export function frameAt(session: LiveSessionResponse, rawMinute: number): LiveFrame {
  const minute = clampMinute(rawMinute, session);
  const spot = at(session.spot.close, minute);
  const rolling = session.rolling;
  const fixed = session.fixed;
  // Both straddles are measured against the 09:15 straddle: the one a seller of the opening
  // straddle entered. Without it, against each series' own first value.
  const reference = fixed.open_value ?? firstNumber(fixed.straddle);
  const rollingNow = at(rolling.straddle, minute);
  const fixedNow = at(fixed.straddle, minute);
  const soFar = rangeSoFar(session.spot.high, session.spot.low, minute);
  const median = session.range.median_full_session;
  return {
    minute,
    time: session.minutes[minute] ?? 0,
    spot,
    spotChange: change(spot, session.spot.open),
    vix: at(session.vix, minute),
    vixChange: change(at(session.vix, minute), firstNumber(session.vix)),
    atm: at(session.atm, minute),
    rolling: {
      ce: at(rolling.ce, minute),
      pe: at(rolling.pe, minute),
      straddle: rollingNow,
      change: change(rollingNow, reference ?? firstNumber(rolling.straddle)),
    },
    fixed: {
      strike: fixed.strike,
      ce: at(fixed.ce, minute),
      pe: at(fixed.pe, minute),
      straddle: fixedNow,
      change: change(fixedNow, reference),
    },
    straddlePctOfSpot:
      rollingNow !== null && spot !== null && spot !== 0 ? (rollingNow / spot) * 100 : null,
    range: {
      soFar,
      versusMedian: soFar !== null && median ? soFar / median : null,
    },
  };
}

/** The points of a series up to and including `minute`, gaps left out (the line breaks there). */
export function pointsUpTo(
  minutes: readonly number[],
  values: ReadonlyArray<number | null> | null | undefined,
  minute: number,
): ChartPoint[] {
  if (!values) return [];
  const out: ChartPoint[] = [];
  const end = Math.min(minute, minutes.length - 1, values.length - 1);
  for (let i = 0; i <= end; i++) {
    const value = values[i];
    const time = minutes[i];
    if (value !== null && value !== undefined && time !== undefined) out.push({ time, value });
  }
  return out;
}

/** Which straddle series a chart line is, in the order the legend and colours use. */
export type StraddleKind = 'rolling' | 'fixed';

export function straddleSeries(session: LiveSessionResponse, kind: StraddleKind): StraddleSide {
  return kind === 'rolling' ? session.rolling : session.fixed;
}

/** "Fri 16 Oct 2026" for a YYYY-MM-DD day, with the weekday (a replay is picked by date). */
export function dayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/** How a playback speed is named on the control. */
export const SPEEDS = [
  { value: '1', label: '1×', minutesPerSecond: 1 },
  { value: '10', label: '10×', minutesPerSecond: 10 },
  { value: '60', label: '60×', minutesPerSecond: 60 },
] as const;
export type SpeedId = (typeof SPEEDS)[number]['value'];
