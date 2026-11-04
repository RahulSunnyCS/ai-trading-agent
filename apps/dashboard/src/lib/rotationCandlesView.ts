/**
 * The candle card's view logic: the request, the period cut and the tooltip's lines. Every figure
 * comes from `rotation/candles.py`; nothing here computes a result.
 */

import type { CandleBook, CandleDay } from '../types/rotationCandles';
import { EMPTY, formatInr, formatPct } from './format';

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
  { value: 'all', label: '2 years', days: null },
];

export const CANDLE_LOTS = [1, 2, 3, 4] as const;

/** The request: the last two years (the API's default window), the book's own stop. */
export function candlesUrl(book: CandleBook, lots: number): string {
  return `${BASE}/rotation/candles?book=${book}&lots=${lots}`;
}

/** The last `period` trading days of `days` (all of them for "2 years"). */
export function cutPeriod(days: CandleDay[], period: CandlePeriod): CandleDay[] {
  const n = CANDLE_PERIODS.find((p) => p.value === period)?.days ?? null;
  return n === null ? days : days.slice(-n);
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

/** The tooltip's lines for one day: the day, its range, each pick, the random-basket share. */
export function tipLines(d: CandleDay): { head: TipLine[]; picks: TipLine[]; foot: TipLine[] } {
  const head: TipLine[] = [
    { label: 'Day', value: formatInr(d.pnl, { sign: true }), tone: tone(d.pnl) },
    {
      label: 'Best / worst in the day',
      value: `${formatInr(d.high - d.open, { sign: true })} / ${formatInr(d.low - d.open, { sign: true })}`,
      tone: null,
    },
    {
      label: 'Running total',
      value: `${formatInr(d.open)} → ${formatInr(d.close)}`,
      tone: null,
    },
  ];
  if (d.stopped_at) head.push({ label: 'Book stop', value: `hit at ${d.stopped_at}`, tone: 'neg' });
  const picks = d.picks.map((p) => ({
    label: p.lots > 1 ? `${p.label} ×${p.lots}` : p.label,
    value: formatInr(p.pnl, { sign: true }),
    tone: tone(p.pnl),
    detail: p.params,
  }));
  const foot: TipLine[] = [
    {
      label: 'Beat random baskets',
      value: d.beat === null ? EMPTY : formatPct(d.beat, d.beat > 0 && d.beat < 0.01 ? 1 : 0),
      tone: null,
    },
  ];
  if (d.source === 'rederived') foot.push({ label: 'Picks', value: 're-derived', tone: null });
  return { head, picks, foot };
}
