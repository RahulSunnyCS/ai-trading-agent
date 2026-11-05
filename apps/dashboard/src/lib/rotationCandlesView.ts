/**
 * The candle card's view logic: the request, the period cut, day and week bars, and the hover's
 * lines. Every figure comes from `rotation/candles.py`; a week bar only gathers its days (first
 * open, last close, highest high, lowest low, the days' results summed).
 */

import type { CandleBook, CandleDay, CandleLive, CandlePick } from '../types/rotationCandles';
import { EMPTY, formatDayShort, formatInr, formatPct } from './format';

const BASE = '/api/backtest/legwise';

export const CANDLE_BOOKS: { value: CandleBook; label: string }[] = [
  { value: 't1', label: 'Adaptive Tuned' },
  { value: 'core', label: 'Adaptive Classic' },
  { value: 'base', label: 'Fixed base' },
];

export type CandlePeriod = '1m' | '3m' | '1y' | 'all';

export const CANDLE_PERIODS: { value: CandlePeriod; label: string; days: number | null }[] = [
  { value: '1m', label: '1 month', days: 22 },
  { value: '3m', label: '3 months', days: 66 },
  { value: '1y', label: '1 year', days: 250 },
  { value: 'all', label: 'All', days: null },
];

export type CandleSpan = 'day' | 'week';

export const CANDLE_SPANS: { value: CandleSpan; label: string }[] = [
  { value: 'day', label: 'Daily' },
  { value: 'week', label: 'Weekly' },
];

export const CANDLE_LOTS = [1, 2, 3, 4] as const;

/** The request: the last two years (the API's default window), the book's own stop. */
export function candlesUrl(book: CandleBook, lots: number): string {
  return `${BASE}/rotation/candles?book=${book}&lots=${lots}`;
}

/** The last `period` trading days of `days` (all of them for "All"). */
export function cutPeriod(days: CandleDay[], period: CandlePeriod): CandleDay[] {
  const n = CANDLE_PERIODS.find((p) => p.value === period)?.days ?? null;
  return n === null ? days : days.slice(-n);
}

/** One drawn candle: a day, or a week of days. `time` is the first day ("YYYY-MM-DD"). */
export interface CandleBar {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  pnl: number;
  /** below the running high at the bar's close */
  drawdown: number;
  days: CandleDay[];
}

/** The Monday of `day`'s week, as "YYYY-MM-DD" (a zone-less calendar date). */
export function weekOf(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/** The days as bars: one a day, or one a week (Monday to Friday). */
export function toBars(days: CandleDay[], span: CandleSpan): CandleBar[] {
  if (span === 'day') {
    return days.map((d) => ({
      time: d.day,
      open: d.open,
      high: d.high,
      low: d.low,
      close: d.close,
      pnl: d.pnl,
      drawdown: d.drawdown,
      days: [d],
    }));
  }
  const weeks = new Map<string, CandleDay[]>();
  for (const d of days) {
    const key = weekOf(d.day);
    const list = weeks.get(key);
    if (list) list.push(d);
    else weeks.set(key, [d]);
  }
  return [...weeks.values()].map((list) => {
    const first = list[0] as CandleDay;
    const last = list[list.length - 1] as CandleDay;
    return {
      time: first.day,
      open: first.open,
      high: Math.max(...list.map((d) => d.high)),
      low: Math.min(...list.map((d) => d.low)),
      close: last.close,
      pnl: list.reduce((s, d) => s + d.pnl, 0),
      drawdown: last.drawdown,
      days: list,
    };
  });
}

/** An account's name on the hover: "AlgoTest · Angel One". */
export function accountName(l: CandleLive): string {
  const platform =
    l.platform === 'algotest' ? 'AlgoTest' : l.platform === 'quantiply' ? 'Quantiply' : l.platform;
  const broker =
    l.broker === 'angelone' ? 'Angel One' : l.broker === 'finvasia' ? 'Shoonya' : l.broker;
  return `${platform} · ${broker}`;
}

/** The live dot's sign for a bar: the accounts' live results per lot added up; null with none. */
export function liveTotal(bar: CandleBar): number | null {
  const rows = bar.days.flatMap((d) => d.live);
  return rows.length ? rows.reduce((s, l) => s + l.live, 0) : null;
}

export interface TipLine {
  label: string;
  value: string;
  /** 'pos' | 'neg' tone for a P&L figure, else null */
  tone: 'pos' | 'neg' | null;
  /** a strategy line's settings, shown under its name */
  detail?: string;
}

function tone(v: number): 'pos' | 'neg' | null {
  const r = Math.round(v);
  return r > 0 ? 'pos' : r < 0 ? 'neg' : null;
}

const signed = (v: number) => formatInr(v, { sign: true });

function share(beat: number | null): string {
  if (beat === null) return EMPTY;
  return formatPct(beat, beat > 0 && beat < 0.01 ? 1 : 0);
}

function drawdownLine(label: string, dd: number): TipLine {
  return {
    label,
    value: dd > 0.5 ? formatInr(-dd) : 'at a high',
    tone: dd > 0.5 ? 'neg' : null,
  };
}

function liveLines(rows: CandleLive[], when: string): TipLine[] {
  return rows.map((l) => ({
    label: `${accountName(l)} live`,
    value: signed(l.live),
    tone: tone(l.live),
    detail: `paper ${signed(l.paper)} a lot${when}`,
  }));
}

export interface Tip {
  head: TipLine[];
  picks: TipLine[];
  foot: TipLine[];
}

/** The entry time in a variant's id (`N_wide_1117` -> `11:17`), or '' when it has none. */
export function pickSlot(name: string): string {
  const m = /_(\d{2})(\d{2})$/.exec(name);
  return m ? `${m[1]}:${m[2]}` : '';
}

/**
 * A pick's title on a line: its label, its entry time and its lots. The label alone drops the
 * time, so two slots of one strategy (`S_p320_1302` and `S_p320_1317`) would read the same.
 */
export function pickTitle(p: CandlePick): string {
  const slot = pickSlot(p.name);
  return `${p.label}${slot ? ` ${slot}` : ''}${p.lots > 1 ? ` ×${p.lots}` : ''}`;
}

/** The hover's lines for one day: the day, its range, each pick, live, the random-basket share. */
export function tipLines(d: CandleDay): Tip {
  const head: TipLine[] = [
    { label: 'Day', value: signed(d.pnl), tone: tone(d.pnl) },
    {
      label: 'Best / worst in the day',
      value: `${signed(d.high - d.open)} / ${signed(d.low - d.open)}`,
      tone: null,
    },
    { label: 'Running total', value: `${formatInr(d.open)} → ${formatInr(d.close)}`, tone: null },
    drawdownLine('Drawdown', d.drawdown),
  ];
  if (d.stopped_at) head.push({ label: 'Book stop', value: `hit at ${d.stopped_at}`, tone: 'neg' });
  const picks = d.picks.map((p) => ({
    label: pickTitle(p),
    value: signed(p.pnl),
    tone: tone(p.pnl),
    detail: p.params,
  }));
  const foot: TipLine[] = [
    ...liveLines(d.live, ''),
    { label: 'Beat random baskets', value: share(d.beat), tone: null },
  ];
  if (d.source === 'rederived') foot.push({ label: 'Picks', value: 're-derived', tone: null });
  return { head, picks, foot };
}

/** The hover's lines for a week: its result, best and worst day, stops, live, the average share. */
export function weekLines(bar: CandleBar): Tip {
  const best = bar.days.reduce((a, d) => (d.pnl > a.pnl ? d : a));
  const worst = bar.days.reduce((a, d) => (d.pnl < a.pnl ? d : a));
  const stops = bar.days.filter((d) => d.stopped_at).length;
  const beats = bar.days.map((d) => d.beat).filter((b): b is number => b !== null);
  const n = bar.days.length;
  const head: TipLine[] = [
    { label: `Week, ${n} day${n === 1 ? '' : 's'}`, value: signed(bar.pnl), tone: tone(bar.pnl) },
    {
      label: `Best day, ${formatDayShort(best.day)}`,
      value: signed(best.pnl),
      tone: tone(best.pnl),
    },
    {
      label: `Worst day, ${formatDayShort(worst.day)}`,
      value: signed(worst.pnl),
      tone: tone(worst.pnl),
    },
    {
      label: 'Running total',
      value: `${formatInr(bar.open)} → ${formatInr(bar.close)}`,
      tone: null,
    },
    drawdownLine('Drawdown at the close', bar.drawdown),
  ];
  if (stops) {
    head.push({
      label: 'Book stop',
      value: `hit on ${stops} day${stops === 1 ? '' : 's'}`,
      tone: 'neg',
    });
  }
  const live = new Map<string, CandleLive>();
  for (const l of bar.days.flatMap((d) => d.live)) {
    const key = accountName(l);
    const was = live.get(key);
    live.set(key, was ? { ...was, live: was.live + l.live, paper: was.paper + l.paper } : { ...l });
  }
  const foot: TipLine[] = [
    ...liveLines([...live.values()], ' over the week'),
    {
      label: 'Beat random baskets, average',
      value: beats.length ? share(beats.reduce((s, b) => s + b, 0) / beats.length) : EMPTY,
      tone: null,
    },
  ];
  return { head, picks: [], foot };
}

/** The lines for a bar: a day's in full, a week's summed. */
export function barLines(bar: CandleBar): Tip {
  return bar.days.length === 1 && bar.days[0] ? tipLines(bar.days[0]) : weekLines(bar);
}

/** The first bar holding a recorded (journal) day: where forward testing begins; null when none. */
export function forwardFrom(bars: CandleBar[]): CandleBar | null {
  return bars.find((b) => b.days.some((d) => d.source === 'recorded')) ?? null;
}

/** How many of the days are recorded picks (forward) rather than re-derived. */
export function recordedCount(days: CandleDay[]): number {
  return days.filter((d) => d.source === 'recorded').length;
}

/** A pick the day replay can open: the rotation variants (not the fixed base's own Dir leg). */
export function canReplay(name: string): boolean {
  return name !== 'N_dir_atm_0924';
}
