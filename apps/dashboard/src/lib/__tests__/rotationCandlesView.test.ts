import { describe, expect, it } from 'vitest';

import type { CandleDay } from '../../types/rotationCandles';
import { candlesUrl, cutPeriod, tipLines } from '../rotationCandlesView';

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
  ...over,
});

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

  it('writes the day, each pick and the random-basket share', () => {
    const { head, picks, foot } = tipLines(day());
    expect(head.map((l) => l.label)).toEqual([
      'Day',
      'Best / worst in the day',
      'Running total',
      'Book stop',
    ]);
    expect(head[0]?.tone).toBe('neg');
    expect(head[3]?.value).toBe('hit at 12:24');
    expect(picks.map((p) => p.label)).toEqual(['S_dir_ITM1', 'N_widesl_OTM1 ×2']);
    expect(picks[1]?.tone).toBe('pos');
    expect(picks[0]?.detail).toBe('SL15% · MTMSL4000');
    expect(foot[0]?.value).toBe('0.2%');
    const old = tipLines(day({ source: 'rederived', stopped_at: null, beat: null }));
    expect(old.head).toHaveLength(3);
    expect(old.foot.map((l) => l.value)).toEqual(['—', 're-derived']);
  });
});
