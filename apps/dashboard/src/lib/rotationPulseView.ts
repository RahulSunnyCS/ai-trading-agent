/**
 * Pure view functions for the Family pulse card: the figure boxes, the source labels, the rank and
 * flag text, the pick chips and share, the sparkline geometry and the Strategy Matrix link. No
 * React here, so each is unit-tested.
 *
 * Every rupee is gross, per ONE lot of one strategy, a mean of the pooled variant-days (never a
 * sum across variants). A value the store could not give is `null` and shows as EMPTY with its
 * reason, never as zero.
 */

import type {
  PulseAvailable,
  PulseCell,
  PulseChip,
  PulseFlag,
  PulseListKey,
  PulseShareCell,
  PulseStat,
} from '../types/rotationPulse';
import { EMPTY, formatDay, formatInr, formatInt, formatPct } from './format';

export const PULSE_LISTS: readonly PulseListKey[] = ['A', 'B', 'C', 'REF'];
export const WINDOW_KEYS = ['5', '21', '63'] as const;

/** "09:17-10:02" as the page prints it, with an en dash. */
export function bandText(label: string): string {
  return label.replace('-', '–');
}

export type Tone = 'positive' | 'negative' | 'neutral';

function toneOf(value: number | null): Tone {
  if (value === null || value === 0) return 'neutral';
  return value > 0 ? 'positive' : 'negative';
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

export interface Figure {
  /** "₹676", or EMPTY when there is no stored result */
  text: string;
  tone: Tone;
  /** "21·16": sessions·variants, the sample the mean stands on */
  counts: string;
  /** the sentence for a hover: window dates, variant-days, and why a value is missing */
  title: string;
  missing: boolean;
  /** how many of the window's sessions are recorded forward days */
  forward: number;
}

export function figure(stat: PulseStat | undefined, label: string): Figure {
  if (!stat || stat.st !== 'ok' || stat.avg === null) {
    return {
      text: EMPTY,
      tone: 'neutral',
      counts: '',
      title: `${label}: ${stat?.reason ?? 'no stored result in this window'}`,
      missing: true,
      forward: 0,
    };
  }
  const span =
    stat.first && stat.last ? `, ${formatDay(stat.first)} to ${formatDay(stat.last)}` : '';
  return {
    text: formatInr(stat.avg),
    tone: toneOf(stat.avg),
    counts: `${formatInt(stat.n)}·${formatInt(stat.variants)}`,
    title: [
      `${label}: mean gross per lot-day of ${formatInt(stat.nv)} variant-days over `,
      `${formatInt(stat.n)} sessions${span}. Variants on one date are not independent, so `,
      'sessions is the count that matters.',
    ].join(''),
    missing: false,
    forward: stat.forward ?? 0,
  };
}

/** Is a window short of its length (fewer sessions than asked for)? */
export function isShort(stat: PulseStat | undefined, asked: number): boolean {
  return !!stat && stat.st === 'ok' && stat.n < asked;
}

/**
 * Where the figures come from, in a sentence: the windows are the stored research results until
 * forward sessions exist, and a window that includes some says how many.
 */
export function sourceLine(r: PulseAvailable): string {
  const forward = r.journal.on_time;
  const scored = Math.max(
    0,
    ...r.cells.flatMap((c) => (c.windows ? [c.windows['63'].forward ?? 0] : [])),
  );
  if (forward === 0) {
    return 'Windows read the stored research results: no forward session has been recorded yet.';
  }
  if (scored === 0) {
    return `${formatInt(forward)} forward ${forward === 1 ? 'entry is' : 'entries are'} recorded, none scored yet; the windows are still research results.`;
  }
  return `The windows mix research results with ${formatInt(scored)} scored forward ${scored === 1 ? 'session' : 'sessions'}; the last 5 and 21 say how many of theirs are forward.`;
}

// ---------------------------------------------------------------------------
// Rank and flag
// ---------------------------------------------------------------------------

export interface RankView {
  text: string;
  title: string;
  /** 1..of, null when the ranking cannot be rebuilt yet */
  rank: number | null;
}

export function rankView(cell: PulseCell, r: PulseAvailable): RankView {
  if (!r.rank.available || !cell.rank) {
    return {
      text: EMPTY,
      rank: null,
      title: r.rank.reason ?? 'the ranking cannot be rebuilt for this cell',
    };
  }
  return {
    text: `${cell.rank.rank}/${cell.rank.of}`,
    rank: cell.rank.rank,
    title: [
      `Family-band recent score ${formatInr(cell.rank.value)} per lot (the ranking's own `,
      'criterion value: the last ten sessions, the latest five counted double, averaged over ',
      'the cell), ranked among the 12 cells for the next 09:16 pick.',
    ].join(''),
  };
}

export interface FlagView {
  label: string;
  /** the badge text in a narrow column */
  short: string;
  tone: 'warning' | 'info' | 'neutral';
  title: string;
}

/** `null` when inside its usual range or when no verdict is possible: no badge in either case. */
export function flagView(flag: PulseFlag | undefined): FlagView | null {
  if (!flag) return null;
  if (flag.state === 'above' || flag.state === 'below') {
    const where = flag.state === 'above' ? 'above' : 'below';
    return {
      label: flag.state === 'above' ? 'Above its P1 range' : 'Below its P1 range',
      short: flag.state === 'above' ? 'Above' : 'Below',
      tone: 'warning',
      title: [
        `The last 21 sessions' mean (${formatInr(flag.last21)}) sits ${where} the range of this `,
        `cell's own rolling-21 means in P1 (P10 ${formatInr(flag.p10)} to P90 ${formatInr(flag.p90)}). `,
        'A description of drift; nothing changes.',
      ].join(''),
    };
  }
  return null;
}

export function flagNote(flag: PulseFlag | undefined): string | null {
  return flag?.state === 'unknown' && flag.reason ? flag.reason : null;
}

// ---------------------------------------------------------------------------
// Picks and share
// ---------------------------------------------------------------------------

export interface ChipGroup {
  list: PulseListKey;
  count: number;
  title: string;
  focus: boolean;
}

/** One chip per list that picked in the cell (A, B, C, REF in that order), with a count. */
export function chipGroups(chips: PulseChip[] | undefined, focus: PulseListKey): ChipGroup[] {
  const out: ChipGroup[] = [];
  for (const list of PULSE_LISTS) {
    const mine = (chips ?? []).filter((c) => c.list === list);
    if (mine.length === 0) continue;
    out.push({
      list,
      count: mine.length,
      focus: list === focus,
      title: `List ${list}: ${mine.map((c) => `${c.variant}${c.role === 'buy' ? ' (Buy add-on)' : ''}`).join(', ')}`,
    });
  }
  return out;
}

/** Which of the two share statistics the page shows: recorded wins, the other is the fallback. */
export type ShareSource = 'recorded' | 'reconstructed';

export function shareSource(r: PulseAvailable): ShareSource | null {
  if (r.share.recorded && r.share.recorded.sessions > 0) return 'recorded';
  if (r.share.reconstructed && r.share.reconstructed.sessions > 0) return 'reconstructed';
  return null;
}

export interface ShareView {
  text: string;
  title: string;
}

/**
 * The focus list's frequency in a cell: its share of core picks for a Widesl or Dir cell, and the
 * days the Buy add-on sat there for a Buy cell (the Buy is not a core pick).
 */
export function shareView(cell: PulseCell, r: PulseAvailable): ShareView {
  const source = shareSource(r);
  if (source === null) {
    return { text: EMPTY, title: 'No pick has been recorded or can be reconstructed yet.' };
  }
  const summary = r.share[source];
  const one: PulseShareCell | null | undefined = cell.share?.[source];
  if (!summary || !one) return { text: EMPTY, title: 'No pick figure for this cell.' };
  const basis =
    `${source === 'recorded' ? 'Recorded' : 'Reconstructed'} picks of list ${summary.list}, ` +
    `${formatInt(summary.sessions)} ${summary.sessions === 1 ? 'session' : 'sessions'} ` +
    `(${formatDay(summary.from)} to ${formatDay(summary.to)}).`;
  if (cell.kind === 'buy') {
    return {
      text: `${formatInt(one.buy_days)} of ${formatInt(summary.sessions)} d`,
      title: `${basis} The Buy add-on was in this cell on ${formatInt(one.buy_days)} of them.`,
    };
  }
  return {
    text: `${formatPct(one.share, 0)} · ${formatInt(one.core)}/${formatInt(summary.core_total)}`,
    title: `${basis} ${formatInt(one.core)} of ${formatInt(summary.core_total)} core picks landed here.`,
  };
}

export interface PicksHeader {
  /** "Recorded 12 Oct 2026", "Reconstructed 09 Oct 2026" or null with no picks at all */
  label: string | null;
  source: 'recorded' | 'reconstructed' | null;
  note: string | null;
}

export function picksHeader(r: PulseAvailable): PicksHeader {
  const p = r.picks;
  if (!p.source || !p.day) {
    return {
      label: null,
      source: null,
      note: 'No entry has been recorded yet and no day can be reconstructed.',
    };
  }
  if (p.source === 'reconstructed') {
    return {
      label: `Reconstructed ${formatDay(p.day)}`,
      source: 'reconstructed',
      note: `No entry has been recorded. These are the picks the rule gives for ${formatDay(p.day)} from the results before it, not a record.`,
    };
  }
  return {
    label: `Recorded ${formatDay(p.day)}`,
    source: 'recorded',
    note: p.late
      ? `The entry for ${formatDay(p.day)} was recorded after 09:17: shown, not forward, and not counted anywhere.`
      : null,
  };
}

// ---------------------------------------------------------------------------
// Header texts
// ---------------------------------------------------------------------------

/** "carries 5% of the composite in A, B and C and none in REF", from the lists' own weights. */
export function criterionNote(r: PulseAvailable): string {
  const weights = r.rank.weights;
  const with_ = PULSE_LISTS.filter((k) => (weights[k] ?? 0) > 0);
  const without = PULSE_LISTS.filter((k) => (weights[k] ?? 0) === 0);
  const join = (xs: readonly string[]) =>
    xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
  if (with_.length === 0) return 'The family-band criterion carries no weight in any list.';
  const pcts = Array.from(new Set(with_.map((k) => formatPct(weights[k], 0))));
  const share = pcts.length === 1 ? pcts[0] : 'a small share';
  const tail = without.length ? ` and none in ${join(without)}.` : '.';
  return `The family-band criterion carries ${share} of the composite in ${join(with_)}${tail}`;
}

/** One line under the title: the as-of session and the pick the rank is for. */
export function asOfLine(r: PulseAvailable): string {
  const next = r.next_pick_day ? ` · ranking sees: the pick of ${formatDay(r.next_pick_day)}` : '';
  return `As of ${formatDay(r.as_of)}${next} · gross per lot-day`;
}

export interface EmptyView {
  title: string;
  description: string;
}

export function unavailableView(reason: string): EmptyView {
  return {
    title: 'No strategy has stored results yet',
    description: `${reason}. The pulse appears after the nightly rotation update (obt rotation update).`,
  };
}

// ---------------------------------------------------------------------------
// The sparkline
// ---------------------------------------------------------------------------

export interface SparkGeometry {
  /** SVG path over the non-null points; a gap starts a new sub-path */
  path: string;
  /** y of the P1-mean line, null when there is no P1 mean */
  meanY: number | null;
  /** x of each value (null values keep their slot) */
  xs: number[];
  /** y of each value, null where the value is null */
  ys: Array<number | null>;
}

/**
 * The rolling-21 line and its P1 mean on one scale (the mean is inside the scale, so the dashed
 * line never leaves the box). A flat or single-point series sits mid-height.
 */
export function sparkGeometry(
  values: ReadonlyArray<number | null>,
  mean: number | null,
  width: number,
  height: number,
  pad = 2,
): SparkGeometry {
  const real = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const all = mean !== null && Number.isFinite(mean) ? [...real, mean] : real;
  const n = values.length;
  const xs = values.map((_, i) => (n <= 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (n - 1)));
  if (all.length === 0) return { path: '', meanY: null, xs, ys: values.map(() => null) };
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const y = (v: number) =>
    hi === lo ? height / 2 : pad + ((hi - v) * (height - 2 * pad)) / (hi - lo);
  const ys = values.map((v) => (v === null || !Number.isFinite(v) ? null : y(v)));
  let path = '';
  let pen = false;
  ys.forEach((py, i) => {
    if (py === null) {
      pen = false;
      return;
    }
    const x = xs[i] as number;
    path += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${py.toFixed(1)}`;
    pen = true;
  });
  return {
    path,
    meanY: mean !== null && Number.isFinite(mean) ? y(mean) : null,
    xs,
    ys,
  };
}

/** The index of the point nearest an x position inside a box of `width` holding `n` points. */
export function nearestIndex(x: number, width: number, n: number, pad = 2): number {
  if (n <= 1) return 0;
  const t = (x - pad) / (width - 2 * pad);
  return Math.max(0, Math.min(n - 1, Math.round(t * (n - 1))));
}

// ---------------------------------------------------------------------------
// The Strategy Matrix link
// ---------------------------------------------------------------------------

/**
 * `/optionslab/matrix?view=pulse&family=widesl&slot=0917,0932,…`: the matrix's pulse view
 * filtered to this cell's strategy kind and start band (and the index when one is chosen here).
 */
export function matrixHref(cell: PulseCell): string | null {
  const m = cell.matrix;
  if (!m) return null;
  const q = new URLSearchParams({ view: m.view, family: m.family, slot: m.slot });
  if (m.index) q.set('index', m.index);
  return `/optionslab/matrix?${q.toString()}`;
}
