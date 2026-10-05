import { describe, expect, it } from 'vitest';

import type { TickMessage } from '../../types/trading';
import { applyFrame } from '../useLiveTicks';

const EMPTY = { ticks: [], straddles: [], latestStraddle: null };

describe('applyFrame', () => {
  it('appends index ticks and ignores VIX and option-leg ticks', () => {
    let h = applyFrame(EMPTY, {
      type: 'tick',
      symbol: 'NSE:NIFTY50-INDEX',
      ltp: 25_000,
      timestamp: 1_000,
    });
    const afterVix = applyFrame(h, {
      type: 'tick',
      symbol: 'NSE:INDIAVIX-INDEX',
      ltp: 12,
      timestamp: 2_000,
    });
    expect(afterVix).toBe(h);
    h = applyFrame(h, { type: 'tick', symbol: 'NSE:NIFTY50-INDEX', ltp: 25_010, timestamp: 3_000 });
    expect(h.ticks).toEqual([
      { time: 1_000, ltp: 25_000 },
      { time: 3_000, ltp: 25_010 },
    ]);
  });

  it('keeps the latest straddle and its history, with optional fields only when present', () => {
    const h = applyFrame(EMPTY, {
      type: 'straddle',
      straddleValue: 210.5,
      atmStrike: 25_000,
      cePrice: 100,
      pePrice: 110.5,
      timestamp: 15_000,
      roc: 1.25,
    });
    expect(h.straddles).toEqual([{ time: 15_000, value: 210.5 }]);
    expect(h.latestStraddle).toEqual({
      straddleValue: 210.5,
      atmStrike: 25_000,
      cePrice: 100,
      pePrice: 110.5,
      timestamp: 15_000,
      roc: 1.25,
    });
  });

  it('returns the same history for unknown frames and malformed numbers', () => {
    expect(applyFrame(EMPTY, { type: 'connected', timestamp: 1 })).toBe(EMPTY);
    expect(applyFrame(EMPTY, { type: 'other' } as unknown as TickMessage)).toBe(EMPTY);
    expect(
      applyFrame(EMPTY, {
        type: 'tick',
        symbol: 'NSE:NIFTY50-INDEX',
        ltp: 'x',
        timestamp: 1,
      } as unknown as TickMessage),
    ).toBe(EMPTY);
  });
});
