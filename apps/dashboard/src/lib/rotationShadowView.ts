/**
 * Pure view functions for the Shadow scoreboard: the banner sentence, the empty states, the
 * trigger table's cells, the research reference, one row per override day, and the chart's
 * geometry. No React here, so each is unit-tested.
 *
 * Every figure is gross rupees and an event minus a comparator. A value the API could not give is
 * `null` and shows as EMPTY with its reason, never as zero.
 */

import type {
  RotationShadowResponse,
  ShadowBanner,
  ShadowDayRow,
  ShadowResearchCell,
  ShadowSeriesPoint,
  ShadowStatus,
  ShadowTriggerRow,
} from '../types/rotationShadow';
import { EMPTY, formatDay, formatInr, formatInt, formatNumber } from './format';

/** A trigger row with fewer event days than this shows no t (the API's own bar). */
export const THIN_DAYS = 5;

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

// ---------------------------------------------------------------------------
// Banner and empty states
// ---------------------------------------------------------------------------

/** "N forward sessions, M with a trigger event, judged at 60 sessions, nothing here changes a list". */
export function bannerText(b: ShadowBanner): string {
  return (
    `${formatInt(b.sessions)} forward ${plural(b.sessions, 'session', 'sessions')}, ` +
    `${formatInt(b.with_event)} with a trigger event, ` +
    `judged at ${formatInt(b.judged_at)} sessions, nothing here changes a list`
  );
}

export interface EmptyView {
  title: string;
  description: string;
}

/**
 * What the page says when there is nothing to judge yet, and what will appear and when. `null`
 * once at least one forward session has had a trigger event.
 */
export function emptyState(r: RotationShadowResponse): EmptyView | null {
  const b = r.banner;
  if (b.sessions === 0) {
    return {
      title: 'No forward session has been scored yet',
      description: [
        `The forward window starts ${formatDay(r.forward_from)}.`,
        'Each evening the trigger scoring runs after the 19:45 update has stored that day’s',
        'results: it finds the day’s trigger events and simulates each against its placebo.',
        'The first rows appear that evening, and the comparison with the displaced pick also',
        'needs that morning’s journal entry. Days before the window are research days and are',
        'not counted here.',
      ].join(' '),
    };
  }
  if (b.with_event === 0) {
    return {
      title: `No trigger has fired in ${formatInt(b.sessions)} forward ${plural(b.sessions, 'session', 'sessions')}`,
      description:
        'A session with a trigger event adds a row to the table below the evening it is scored. ' +
        'Sessions without an event are counted in the banner and carry no figure.',
    };
  }
  return null;
}

/** Shown in place of a list's chart when it has no event day yet. */
export function overrideEmpty(
  forwardDays: number,
  eventDays: number,
  journalEntries: number,
): EmptyView {
  if (eventDays === 0) {
    return {
      title: 'No override day yet',
      description:
        forwardDays === 0 && journalEntries === 0
          ? 'The journal has no forward entry yet. A day appears here once it has a recorded entry, ' +
            'a pivot-cross or RSI event, and the displaced pick’s result.'
          : 'No forward day has had a pivot-cross (T1) or RSI-exhaustion (T4) event for this ' +
            'list yet. When one does, this shows the Dir at that minute minus the pick it would ' +
            'have replaced.',
    };
  }
  return {
    title: 'No day has a result yet',
    description:
      'The days with an event are waiting: the displaced pick’s result and the Dir simulation ' +
      'are stored in the evening, and a day not stored yet is pending, not zero.',
  };
}

// ---------------------------------------------------------------------------
// Trigger table
// ---------------------------------------------------------------------------

export interface TriggerCells {
  key: string;
  trigger: string;
  template: string;
  candidate: boolean;
  days: string;
  eventAvg: string;
  placeboAvg: string;
  diff: string;
  t: string;
  /** "n < 5", "no events", "not scored" or null. */
  flag: string | null;
  diffTone: 'positive' | 'negative' | 'muted';
  explore: string;
  confirm: string;
}

function signedT(v: number): string {
  return formatNumber(v, 2, { trim: true });
}

/** BL-083's research cell as the two strings the table shows: last two years, then 2022 to 2024. */
export function researchCells(cell: ShadowResearchCell | null): {
  explore: string;
  confirm: string;
} {
  if (!cell) return { explore: EMPTY, confirm: EMPTY };
  const one = (diff: number | undefined, t: number | undefined, bound: number | undefined) => {
    if (diff !== undefined && t !== undefined) {
      return `${formatInr(diff, { sign: true })} (t ${signedT(t)})`;
    }
    return bound !== undefined ? `|t| ≤ ${signedT(bound)}` : EMPTY;
  };
  return {
    explore: one(cell.explore, cell.explore_t, cell.explore_t_bound),
    confirm: one(cell.confirm, cell.confirm_t, cell.confirm_t_bound),
  };
}

export function triggerCells(row: ShadowTriggerRow): TriggerCells {
  let flag: string | null = null;
  if (row.days === 0) flag = row.events_seen > 0 ? 'not scored' : 'no events';
  else if (row.thin) flag = `n < ${THIN_DAYS}`;
  const research = researchCells(row.research);
  return {
    key: `${row.trigger}-${row.template}`,
    trigger: `${row.trigger} ${row.label}`,
    template: row.template_label,
    candidate: row.candidate,
    days: formatInt(row.days),
    eventAvg: formatInr(row.event_avg, { sign: true }),
    placeboAvg: formatInr(row.placebo_avg, { sign: true }),
    diff: formatInr(row.diff, { sign: true }),
    t: row.thin || row.t === null ? EMPTY : formatNumber(row.t, 2),
    flag,
    diffTone: row.diff === null ? 'muted' : row.diff >= 0 ? 'positive' : 'negative',
    explore: research.explore,
    confirm: research.confirm,
  };
}

// ---------------------------------------------------------------------------
// Override days
// ---------------------------------------------------------------------------

export const STATUS_LABEL: Record<ShadowStatus, string> = {
  scored: 'Scored',
  pending: 'Pending',
  not_applied: 'Not applied',
  late_entry: 'Late entry',
  no_entry: 'No entry',
};

export const STATUS_TONE: Record<ShadowStatus, 'positive' | 'warning' | 'neutral'> = {
  scored: 'positive',
  pending: 'warning',
  not_applied: 'neutral',
  late_entry: 'neutral',
  no_entry: 'neutral',
};

/** "S1_down" -> "S1 down"; "from_over70" -> "back below 70"; "from_under30" -> "back above 30". */
export function detailLabel(detail: string | null): string | null {
  if (!detail) return null;
  if (detail === 'from_over70') return 'back below 70';
  if (detail === 'from_under30') return 'back above 30';
  return detail.replace('_', ' ');
}

export interface DayCells {
  key: string;
  day: string;
  event: string;
  displaced: string;
  dirNet: string;
  displacedGross: string;
  diffLot: string;
  diffBasket: string;
  control: string;
  status: string;
  tone: 'positive' | 'warning' | 'neutral';
  reason: string;
  diffTone: 'positive' | 'negative' | 'muted';
}

export function dayCells(row: ShadowDayRow): DayCells {
  const detail = detailLabel(row.detail);
  const done = row.status === 'scored';
  return {
    key: `${row.day}-${row.list}`,
    day: formatDay(row.day),
    event: `${row.trigger} ${row.underlying} ${row.entry}${detail ? ` (${detail})` : ''}`,
    displaced: row.displaced ? `${row.displaced} (${row.displaced_start})` : EMPTY,
    dirNet: formatInr(row.dir_net, { sign: true }),
    displacedGross: formatInr(row.displaced_gross, { sign: true }),
    diffLot: done ? formatInr(row.diff_lot, { sign: true }) : EMPTY,
    diffBasket: done ? formatInr(row.diff_basket, { sign: true }) : EMPTY,
    control: formatInr(row.control_diff_basket, { sign: true }),
    status: STATUS_LABEL[row.status],
    tone: STATUS_TONE[row.status],
    reason: row.reason,
    diffTone:
      !done || row.diff_basket === null ? 'muted' : row.diff_basket >= 0 ? 'positive' : 'negative',
  };
}

/** How many of a list's event days are in each state, as "3 scored, 1 pending, 2 not applied". */
export function statusSummary(l: {
  scored: number;
  pending: number;
  not_applied: number;
  late_entry: number;
  no_entry: number;
}): string {
  const parts = [
    l.scored ? `${l.scored} scored` : null,
    l.pending ? `${l.pending} pending` : null,
    l.not_applied ? `${l.not_applied} not applied` : null,
    l.late_entry ? `${l.late_entry} late entry` : null,
    l.no_entry ? `${l.no_entry} without a journal entry` : null,
  ].filter((p): p is string => p !== null);
  return parts.length ? parts.join(', ') : 'no event days';
}

// ---------------------------------------------------------------------------
// Chart: the running sum of the override minus the displaced pick, and the placebo line
// ---------------------------------------------------------------------------

export interface ChartPad {
  l: number;
  r: number;
  t: number;
  b: number;
}

export interface ChartPoint {
  day: string;
  x: number;
  y: number;
  cum: number;
  diff: number;
  controlY: number | null;
  controlCum: number | null;
  controlDiff: number | null;
}

export interface ChartModel {
  width: number;
  height: number;
  points: ChartPoint[];
  eventPath: string;
  controlPath: string;
  zeroY: number;
  yTicks: { y: number; label: string }[];
  xTicks: { x: number; label: string }[];
  domain: [number, number];
}

/** Round tick values spanning [lo, hi], about `count` of them. */
export function niceTicks(lo: number, hi: number, count = 4): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const first = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = first; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step + 0);
  return out;
}

const path = (pts: { x: number; y: number }[]) =>
  pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');

/**
 * Geometry for the chart. Days are evenly spaced (a scored day is a point; weekends and days
 * without an event are not on the axis). The y range always contains zero. `null` when there is
 * no scored day.
 */
export function chartModel(
  series: readonly ShadowSeriesPoint[],
  width: number,
  height: number,
  pad: ChartPad = { l: 64, r: 36, t: 12, b: 28 },
): ChartModel | null {
  if (series.length === 0) return null;
  const values = series.flatMap((p) =>
    p.cum_control === undefined ? [p.cum_basket] : [p.cum_basket, p.cum_control],
  );
  let lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  if (hi === lo) hi = lo + 1;
  const margin = (hi - lo) * 0.08;
  lo -= margin;
  hi += margin;
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const xAt = (i: number) =>
    series.length === 1 ? pad.l + innerW / 2 : pad.l + (i * innerW) / (series.length - 1);
  const yAt = (v: number) => pad.t + ((hi - v) / (hi - lo)) * innerH;
  const points: ChartPoint[] = series.map((p, i) => ({
    day: p.day,
    x: xAt(i),
    y: yAt(p.cum_basket),
    cum: p.cum_basket,
    diff: p.diff_basket,
    controlY: p.cum_control === undefined ? null : yAt(p.cum_control),
    controlCum: p.cum_control ?? null,
    controlDiff: p.control_diff_basket ?? null,
  }));
  const withControl = points.filter(
    (p): p is ChartPoint & { controlY: number } => p.controlY !== null,
  );
  const every = Math.max(1, Math.ceil(points.length / 6));
  return {
    width,
    height,
    points,
    eventPath: path(points),
    controlPath:
      withControl.length > 0 ? path(withControl.map((p) => ({ x: p.x, y: p.controlY }))) : '',
    zeroY: yAt(0),
    yTicks: niceTicks(lo, hi).map((v) => ({ y: yAt(v), label: formatInr(v, { compact: true }) })),
    xTicks: points
      .filter((_, i) => i % every === 0)
      .map((p) => ({ x: p.x, label: formatDay(p.day) })),
    domain: [lo, hi],
  };
}

/** The point whose x is nearest `px`, for the follow tooltip. */
export function nearestPoint(model: ChartModel, px: number): ChartPoint | null {
  let best: ChartPoint | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const p of model.points) {
    const d = Math.abs(p.x - px);
    if (d < bestDistance) {
      best = p;
      bestDistance = d;
    }
  }
  return best;
}

/** The follow tooltip's lines for one chart point. */
export function chartTooltip(p: ChartPoint): string[] {
  const lines = [
    formatDay(p.day),
    `Dir minus displaced pick: ${formatInr(p.diff, { sign: true })}`,
    `Running total: ${formatInr(p.cum, { sign: true })}`,
  ];
  if (p.controlCum !== null) {
    lines.push(
      `Placebo Dir minus that pick: ${formatInr(p.controlDiff, { sign: true })}`,
      `Placebo running total: ${formatInr(p.controlCum, { sign: true })}`,
    );
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Research comparison
// ---------------------------------------------------------------------------

export interface ResearchRow {
  list: string;
  candidate: boolean;
  exploreGain: string;
  exploreTime: string;
  exploreDay: string;
  exploreAbove: string;
  confirmGain: string;
  confirmTime: string;
  confirmDay: string;
  forward: string;
}

/** One row per list: BL-083's gain and the two controls' P90 in both periods, beside the forward
 * running total (or why there is none). */
export function researchRows(r: RotationShadowResponse): ResearchRow[] {
  return r.override.lists.map((l) => {
    const ex = r.research.override.find((x) => x.period === 'explore' && x.list === l.list);
    const cf = r.research.override.find((x) => x.period === 'confirm' && x.list === l.list);
    const forward =
      l.total_basket !== null
        ? `${formatInr(l.total_basket, { sign: true })} (${formatInt(l.scored)} ${plural(l.scored, 'day', 'days')})`
        : l.pending > 0
          ? `pending (${formatInt(l.pending)} ${plural(l.pending, 'day', 'days')})`
          : EMPTY;
    return {
      list: l.list,
      candidate: l.candidate,
      exploreGain: formatInr(ex?.gain, { sign: true }),
      exploreTime: formatInr(ex?.random_time_p90, { sign: true }),
      exploreDay: formatInr(ex?.random_day_p90, { sign: true }),
      exploreAbove: ex === undefined ? EMPTY : ex.above_controls ? 'Above both' : 'Not above both',
      confirmGain: formatInr(cf?.gain, { sign: true }),
      confirmTime: formatInr(cf?.random_time_p90, { sign: true }),
      confirmDay: formatInr(cf?.random_day_p90, { sign: true }),
      forward,
    };
  });
}
