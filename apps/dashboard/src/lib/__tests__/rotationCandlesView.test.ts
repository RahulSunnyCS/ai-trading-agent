import { describe, expect, it } from 'vitest';

import type { CandleDay } from '../../types/rotationCandles';
import {
  accountName,
  barLines,
  canReplay,
  candlesUrl,
  cutPeriod,
  forwardFrom,
  liveTotal,
  recordedCount,
  tipLines,
  toBars,
  weekOf,
} from '../rotationCandlesView';

const day = (over: Partial<CandleDay> = {}): CandleDay => ({
  day: '2026-11-04',
  source: 'recorded',
  open: 77790,
  high: 82055,
  low: 68785,
  close: 68785,
  pnl: -9005,
  stopped_at: '12:24',
  picks: [
    {
      name: 'S_ditm1-t1s44_0917',
      label: 'S_dir_ITM1',
      params: 'SL15% · MTMSL4000',
      lots: 1,
      pnl: -4277,
    },
    { name: 'N_wide_0917', label: 'N_widesl_OTM1', params: 'SL115%', lots: 2, pnl: 5458 },
  ],
  beat: 0.002,
  pool: 521,
  drawdown: 19431,
  live: [],
  ...over,
});

const LIVE = { platform: 'algotest', broker: 'angelone', live: -5153, paper: -7142, variants: 2 };

describe('rotation candles view', () => {
  it('asks for the book and lots', () => {
    expect(candlesUrl('t1', 2)).toBe('/api/backtest/legwise/rotation/candles?book=t1&lots=2');
  });

  it('cuts the period to the last trading days', () => {
    const days = Array.from({ length: 300 }, (_, i) => day({ day: `d${i}` }));
    expect(cutPeriod(days, '1m')).toHaveLength(22);
    expect(cutPeriod(days, '3m')[0]?.day).toBe('d234');
    expect(cutPeriod(days, 'all')).toHaveLength(300);
  });

  it('writes the day, each pick, the live accounts and the random-basket share', () => {
    const { head, picks, foot } = tipLines(day({ live: [LIVE] }));
    expect(head.map((l) => l.label)).toEqual([
      'Day',
      'Best / worst in the day',
      'Running total',
      'Drawdown',
      'Book stop',
    ]);
    expect(head[0]?.tone).toBe('neg');
    expect(head[4]?.value).toBe('hit at 12:24');
    expect(picks.map((p) => p.label)).toEqual(['S_dir_ITM1', 'N_widesl_OTM1 ×2']);
    expect(picks[1]?.tone).toBe('pos');
    expect(foot[0]?.label).toBe('AlgoTest · Angel One live');
    expect(foot[1]?.value).toBe('0.2%');
    const old = tipLines(day({ source: 'rederived', stopped_at: null, beat: null, drawdown: 0 }));
    expect(old.head).toHaveLength(4);
    expect(old.head[3]?.value).toBe('at a high');
    expect(old.foot.map((l) => l.value)).toEqual(['—', 're-derived']);
  });

  it('gathers a week into one bar from Monday', () => {
    expect(weekOf('2026-11-04')).toBe('2026-11-02');
    expect(weekOf('2026-11-02')).toBe('2026-11-02');
    expect(weekOf('2026-11-08')).toBe('2026-11-02');
    const days = [
      day({ day: '2026-10-30', open: 0, high: 900, low: -100, close: 500, pnl: 500 }),
      day({
        day: '2026-11-02',
        open: 500,
        high: 1500,
        low: 200,
        close: 1200,
        pnl: 700,
        live: [LIVE],
      }),
      day({
        day: '2026-11-03',
        open: 1200,
        high: 1300,
        low: -900,
        close: -300,
        pnl: -1500,
        drawdown: 1500,
      }),
    ];
    const weeks = toBars(days, 'week');
    expect(weeks.map((w) => w.time)).toEqual(['2026-10-30', '2026-11-02']);
    expect(weeks[1]).toMatchObject({
      open: 500,
      high: 1500,
      low: -900,
      close: -300,
      pnl: -800,
      drawdown: 1500,
    });
    expect(liveTotal(weeks[1]!)).toBe(-5153);
    expect(liveTotal(weeks[0]!)).toBeNull();
    const lines = barLines(weeks[1]!);
    expect(lines.head[0]).toMatchObject({ label: 'Week, 2 days', tone: 'neg' });
    expect(lines.head.some((l) => l.label.startsWith('Worst day'))).toBe(true);
    expect(toBars(days, 'day')).toHaveLength(3);
  });

  it('marks where the recorded picks begin', () => {
    const days = [
      day({ day: '2026-10-15', source: 'rederived' }),
      day({ day: '2026-10-16', source: 'rederived' }),
      day({ day: '2026-10-19', source: 'recorded' }),
    ];
    expect(forwardFrom(toBars(days, 'day'))?.time).toBe('2026-10-19');
    expect(forwardFrom(toBars(days, 'week'))?.time).toBe('2026-10-19');
    expect(forwardFrom(toBars(days.slice(0, 2), 'day'))).toBeNull();
    expect(recordedCount(days)).toBe(1);
  });

  it('names accounts and keeps the base Dir out of the replay', () => {
    expect(accountName({ ...LIVE, broker: 'finvasia' })).toBe('AlgoTest · Shoonya');
    expect(canReplay('N_dir_atm_0924')).toBe(false);
    expect(canReplay('S_ditm1-t1s44_0917')).toBe(true);
  });
});
