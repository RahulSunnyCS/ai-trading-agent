/**
 * Pure helpers for the "Drawdown episodes" card (BL-058 Phase 4, widget 8). The episodes and the
 * drivers come from the Python package; this file lays out the chart (scales, paths, episode
 * spans) and writes the plain-words readings. No `Math.random`, no network.
 */

import type {
  DrawdownEpisode,
  DrawdownPoint,
  DrawdownWindowId,
  RotationDrawdownsResponse,
} from '../types/rotationDrawdowns';
import { formatDay, formatInr, formatInt } from './format';

export const WINDOW_OPTIONS: { value: DrawdownWindowId; label: string }[] = [
  { value: 'P1', label: 'P1' },
  { value: 'P2', label: 'P2' },
  { value: 'last63', label: 'Last 63' },
  { value: 'forward', label: 'Forward' },
];

/** Rupees per lot below the running peak that count as an episode; 500 is the default. */
export const DEPTH_OPTIONS: { value: string; label: string }[] = [
  { value: '250', label: '₹250' },
  { value: '500', label: '₹500' },
  { value: '1000', label: '₹1,000' },
  { value: '2500', label: '₹2,500' },
];
export const DEFAULT_DEPTH = 500;

const WINDOWS: readonly DrawdownWindowId[] = ['P1', 'P2', 'last63', 'forward'];

export function asWindow(raw: string | null): DrawdownWindowId {
  return WINDOWS.find((w) => w === raw) ?? 'P1';
}

export function asDepth(raw: string | null): number {
  const n = Number(raw);
  return DEPTH_OPTIONS.some((o) => Number(o.value) === n) ? n : DEFAULT_DEPTH;
}

export interface Geometry {
  width: number;
  height: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Lowest value drawn (<= 0). */
  min: number;
  x: (index: number) => number;
  y: (value: number) => number;
  /** Gridline values, from 0 downwards. */
  ticks: number[];
}

/** Scales for an underwater chart: 0 at the top, the deepest value of list or base at the bottom. */
export function geometry(
  series: readonly DrawdownPoint[],
  size: { width: number; height: number } = { width: 1040, height: 200 },
): Geometry {
  const left = 62;
  const right = 12;
  const top = 10;
  const bottom = 22;
  const deepest = Math.min(
    0,
    ...series.map((p) => p.underwater),
    ...series.map((p) => p.base_underwater ?? 0),
  );
  const min = deepest === 0 ? -1 : deepest * 1.08;
  const n = Math.max(series.length - 1, 1);
  const w = size.width - left - right;
  const h = size.height - top - bottom;
  const step = niceStep(-min);
  const ticks: number[] = [];
  for (let t = 0; t >= min; t -= step) ticks.push(t);
  return {
    ...size,
    left,
    right,
    top,
    bottom,
    min,
    x: (i) => left + (w * i) / n,
    y: (v) => top + (h * v) / min,
    ticks,
  };
}

/** A tidy gridline step (1, 2, 2.5 or 5 x 10^k) giving about four lines over `span`. */
export function niceStep(span: number): number {
  if (!(span > 0)) return 1;
  const raw = span / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const m = f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10;
  return m * mag;
}

/** An SVG path through the points, broken at nulls (a day the base has no result for). */
export function linePath(points: readonly (number | null)[], g: Geometry): string {
  let d = '';
  let pen = false;
  points.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? 'L' : 'M'}${g.x(i).toFixed(1)},${g.y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

/** The closed shape between the zero line and the underwater line. */
export function areaPath(points: readonly number[], g: Geometry): string {
  if (points.length === 0) return '';
  const first = `M${g.x(0).toFixed(1)},${g.y(0).toFixed(1)}`;
  const line = points.map((v, i) => `L${g.x(i).toFixed(1)},${g.y(v).toFixed(1)}`).join('');
  return `${first}${line}L${g.x(points.length - 1).toFixed(1)},${g.y(0).toFixed(1)}Z`;
}

export interface Span {
  n: number;
  /** First underwater index. */
  from: number;
  /** Last index of the episode: the day back at the peak, or the last day while open. */
  to: number;
}

/** Where each episode sits on the series (indexes), from its peak, end and trough dates. */
export function episodeSpans(
  series: readonly DrawdownPoint[],
  episodes: readonly DrawdownEpisode[],
): Span[] {
  const index = new Map(series.map((p, i) => [p.day, i]));
  const out: Span[] = [];
  for (const e of episodes) {
    const peak = e.peak_day === null ? -1 : (index.get(e.peak_day) ?? -1);
    const trough = index.get(e.trough_day);
    if (trough === undefined) continue;
    const end = e.end_day === null ? series.length - 1 : (index.get(e.end_day) ?? trough);
    out.push({ n: e.n, from: peak + 1, to: end });
  }
  return out;
}

/** "7 sessions down, 14 to recover" / "31 down, still open". */
export function durationText(e: DrawdownEpisode): string {
  const down = `${formatInt(e.sessions_down)} down`;
  return e.open || e.sessions_back === null
    ? `${down}, still open`
    : `${down}, ${formatInt(e.sessions_back)} to recover`;
}

/** The fixed base's change over the same days, in words for a table cell. */
export function baseText(e: DrawdownEpisode): string {
  if (e.base_change === null) return '—';
  const text = formatInr(e.base_change, { sign: true });
  return e.base_missing > 0 ? `${text} (${e.base_missing} days missing)` : text;
}

/** The reading under the chart. */
export function readingLine(d: RotationDrawdownsResponse): string {
  if (d.n_days === 0) return '';
  const parts: string[] = [];
  const against =
    d.base_max_dd === null
      ? '.'
      : `, against ${formatInr(d.base_max_dd)} for the fixed base over its ${formatInt(d.base_days)} days.`;
  parts.push(
    `Over ${formatInt(d.n_days)} scored sessions the list's worst fall was ${formatInr(d.max_dd)} per lot${against}`,
  );
  const hidden = d.all_episodes - d.episodes.length;
  parts.push(
    d.episodes.length === 0
      ? `No fall reached ${formatInr(d.min_depth)} per lot.`
      : `${formatInt(d.episodes.length)} fall${d.episodes.length === 1 ? '' : 's'} of at least ${formatInr(d.min_depth)} per lot${hidden > 0 ? ` (${formatInt(hidden)} smaller one${hidden === 1 ? '' : 's'} hidden)` : ''}.`,
  );
  if (d.current) {
    parts.push(
      `It is now ${formatInr(-d.current.underwater)} per lot below its peak${d.current.since ? ` of ${formatDay(d.current.since)}` : ''}, ${formatInt(d.current.sessions)} session${d.current.sessions === 1 ? '' : 's'} on.`,
    );
  }
  parts.push(
    d.in_sample
      ? 'These sessions were used to choose the weights, so the shape is a description, not a test.'
      : 'Forward sessions are the only ones the weights had not seen.',
  );
  return parts.join(' ');
}
