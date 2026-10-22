import { describe, expect, it } from 'vitest';

import type { LiveSessionResponse } from '../../types/liveSession';
import { clampMinute, frameAt, isCurrentSession, pointsUpTo, rangeSoFar } from '../liveSession';

/** Four minutes of a day: spot 100 -> 130, a rolling straddle with a gap, a fixed one without. */
function session(over: Partial<LiveSessionResponse> = {}): LiveSessionResponse {
  return {
    underlying: 'NIFTY',
    day: '2026-10-16',
    source: { kind: 'replay', note: '' },
    live: { available: false, reason: 'no feed' },
    expiry: '2026-10-19',
    dte_weekdays: 1,
    strike_step: 50,
    last_minute: 3,
    minutes: [1000, 1060, 1120, 1180],
    spot: {
      open: 100,
      close: [101, 110, 120, 130],
      high: [103, 112, 122, 131],
      low: [99, 108, 118, 128],
    },
    vix: [14, 14.5, 15, 15.5],
    atm: [100, 100, 150, 150],
    rolling: {
      ce: [10, 11, null, 20],
      pe: [10, 9, null, 5],
      straddle: [20, 20, null, 25],
    },
    fixed: {
      strike: 100,
      ce: [10, 11, 12, 13],
      pe: [10, 9, 8, 7],
      straddle: [20, 20, 20, 20],
      open_value: 40,
    },
    range: { median_sessions: 20, median_full_session: 20, full_session: 32 },
    notes: [],
    ...over,
  };
}

describe('frameAt', () => {
  it('reads each series at the minute and measures changes from the 09:15 values', () => {
    const f = frameAt(session(), 3);
    expect(f.spot).toBe(130);
    expect(f.spotChange).toEqual({ abs: 30, pct: 30 });
    expect(f.vix).toBe(15.5);
    expect(f.vixChange?.abs).toBeCloseTo(1.5);
    expect(f.atm).toBe(150);
    // both straddles are measured against the 09:15 straddle, not their own first value
    expect(f.rolling.straddle).toBe(25);
    expect(f.rolling.change).toEqual({ abs: -15, pct: -37.5 });
    expect(f.fixed.change).toEqual({ abs: -20, pct: -50 });
    expect(f.fixed.strike).toBe(100);
  });

  it('keeps a gap as a gap: no carried value, no change', () => {
    const f = frameAt(session(), 2);
    expect(f.rolling.straddle).toBeNull();
    expect(f.rolling.ce).toBeNull();
    expect(f.rolling.change).toBeNull();
    expect(f.straddlePctOfSpot).toBeNull();
    expect(f.fixed.straddle).toBe(20);
  });

  it('falls back to the series first value when there is no 09:15 straddle', () => {
    const s = session();
    s.fixed.open_value = null;
    expect(frameAt(s, 3).fixed.change).toEqual({ abs: 0, pct: 0 });
  });

  it('puts the straddle as a percent of spot and the range against the 20-session median', () => {
    const f = frameAt(session(), 3);
    expect(f.straddlePctOfSpot).toBeCloseTo((25 / 130) * 100);
    expect(f.range.soFar).toBe(131 - 99);
    expect(f.range.versusMedian).toBeCloseTo(32 / 20);
    expect(frameAt(session(), 0).range.soFar).toBe(4);
  });

  it('has no range ratio without a median, and no VIX when the day has none', () => {
    const s = session({ vix: null });
    s.range.median_full_session = null;
    const f = frameAt(s, 3);
    expect(f.range.versusMedian).toBeNull();
    expect(f.vix).toBeNull();
    expect(f.vixChange).toBeNull();
  });

  it('stays inside the day', () => {
    expect(frameAt(session(), 99).minute).toBe(3);
    expect(frameAt(session(), -5).minute).toBe(0);
    expect(clampMinute(2.6, { last_minute: 3 })).toBe(3);
  });
});

describe('pointsUpTo', () => {
  it('draws the minutes up to the cursor and breaks the line at a gap', () => {
    const s = session();
    // the gap at 1120 is a whitespace item: Lightweight Charts would otherwise join 1060 to 1180
    expect(pointsUpTo(s.minutes, s.rolling.straddle, 3)).toEqual([
      { time: 1000, value: 20 },
      { time: 1060, value: 20 },
      { time: 1120 },
      { time: 1180, value: 25 },
    ]);
    expect(pointsUpTo(s.minutes, s.rolling.straddle, 0)).toEqual([{ time: 1000, value: 20 }]);
  });

  it('leaves a leading or trailing gap out', () => {
    expect(pointsUpTo([1, 2, 3, 4, 5], [null, 7, null, 8, null], 4)).toEqual([
      { time: 2, value: 7 },
      { time: 3 },
      { time: 4, value: 8 },
    ]);
    // replayed only to the gap: nothing after the last value
    expect(pointsUpTo([1, 2, 3], [6, 7, null], 2)).toEqual([
      { time: 1, value: 6 },
      { time: 2, value: 7 },
    ]);
    expect(pointsUpTo([1, 2], [null, null], 1)).toEqual([]);
  });

  it('is empty for a missing series and never reads past the data', () => {
    expect(pointsUpTo([1, 2], null, 5)).toEqual([]);
    expect(pointsUpTo([1, 2], [5, 6, 7], 9)).toEqual([
      { time: 1, value: 5 },
      { time: 2, value: 6 },
    ]);
  });
});

describe('rangeSoFar', () => {
  it('is the high minus the low up to the minute, null with no data', () => {
    expect(rangeSoFar([5, 9, 7], [3, 4, 1], 1)).toBe(9 - 3);
    expect(rangeSoFar([5, 9, 7], [3, 4, 1], 2)).toBe(9 - 1);
    expect(rangeSoFar([null], [null], 0)).toBeNull();
  });
});

describe('isCurrentSession', () => {
  const nifty = { underlying: 'NIFTY', day: '2026-10-16' } as const;

  it('accepts only the index the control shows', () => {
    expect(isCurrentSession(nifty, 'NIFTY', null)).toBe(true);
    // switched to SENSEX while NIFTY's response is still the latest: not shown
    expect(isCurrentSession(nifty, 'SENSEX', null)).toBe(false);
    expect(isCurrentSession(null, 'NIFTY', null)).toBe(false);
  });

  it('accepts only the chosen day, or any day when none is chosen', () => {
    expect(isCurrentSession(nifty, 'NIFTY', '2026-10-16')).toBe(true);
    expect(isCurrentSession(nifty, 'NIFTY', '2026-10-15')).toBe(false);
    expect(isCurrentSession(nifty, 'NIFTY', '')).toBe(true);
  });
});
