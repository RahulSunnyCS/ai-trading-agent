import { describe, expect, it } from 'vitest';

import {
  NIFTY_INDEX_SYMBOL,
  TICK_BUFFER_CAP,
  type TokenBannerInput,
  appendPoint,
  isIndexTick,
  liveFeedView,
  toChartSeries,
  tokenBanner,
} from '../live';

const p = (time: number, value = time) => ({ time, value });

describe('appendPoint (the tick ring buffer)', () => {
  it('appends in time order', () => {
    expect(appendPoint(appendPoint([], p(1)), p(2))).toEqual([p(1), p(2)]);
  });

  it('drops the oldest point once the cap is reached', () => {
    let buffer: readonly { time: number; value: number }[] = [];
    for (let t = 1; t <= 5; t++) buffer = appendPoint(buffer, p(t), 3);
    expect(buffer).toEqual([p(3), p(4), p(5)]);
  });

  it('keeps at most TICK_BUFFER_CAP points by default', () => {
    let buffer: readonly { time: number; value: number }[] = [];
    for (let t = 1; t <= TICK_BUFFER_CAP + 25; t++) buffer = appendPoint(buffer, p(t));
    expect(buffer).toHaveLength(TICK_BUFFER_CAP);
    expect(buffer[0]).toEqual(p(26));
    expect(buffer[buffer.length - 1]).toEqual(p(TICK_BUFFER_CAP + 25));
  });

  it('replaces a point with the same time instead of duplicating it', () => {
    expect(appendPoint([p(1), p(2, 20)], p(2, 21))).toEqual([p(1), p(2, 21)]);
  });

  it('ignores a point older than the last one and returns the same array', () => {
    const buffer = [p(5), p(6)];
    expect(appendPoint(buffer, p(4))).toBe(buffer);
  });

  it('does not mutate its input', () => {
    const buffer = [p(1)];
    appendPoint(buffer, p(2));
    expect(buffer).toEqual([p(1)]);
  });

  it('returns an empty buffer for a non-positive cap', () => {
    expect(appendPoint([p(1)], p(2), 0)).toEqual([]);
  });
});

describe('isIndexTick', () => {
  it('accepts the NIFTY 50 index, in any casing', () => {
    expect(isIndexTick(NIFTY_INDEX_SYMBOL)).toBe(true);
    expect(isIndexTick('nse:nifty50-index')).toBe(true);
  });

  it('rejects India VIX and option legs on the same stream', () => {
    expect(isIndexTick('NSE:INDIAVIX-INDEX')).toBe(false);
    expect(isIndexTick('NSE:NIFTY26O0625000CE')).toBe(false);
  });

  it('keeps a frame with no symbol (older server)', () => {
    expect(isIndexTick(undefined)).toBe(true);
    expect(isIndexTick('')).toBe(true);
  });
});

describe('toChartSeries', () => {
  it('keeps the last value per second, ascending, in seconds', () => {
    expect(toChartSeries([p(2_000, 1), p(1_000, 5), p(2_500, 2), p(3_100, 3)])).toEqual([
      { time: 1, value: 5 },
      { time: 2, value: 2 },
      { time: 3, value: 3 },
    ]);
  });

  it('skips non-finite values', () => {
    expect(toChartSeries([p(1_000, Number.NaN), p(2_000, 4)])).toEqual([{ time: 2, value: 4 }]);
  });
});

describe('liveFeedView', () => {
  it('says Live only for fresh, real ticks', () => {
    expect(liveFeedView('live', false).label).toBe('Live');
    expect(liveFeedView('live', true)).toMatchObject({ label: 'Simulation', tone: 'info' });
  });

  it('says Stale with the warning tone', () => {
    expect(liveFeedView('stale', false)).toMatchObject({ label: 'Stale', tone: 'warning' });
    expect(liveFeedView('stale', true).label).toBe('Stale');
  });
});

describe('tokenBanner', () => {
  const base: TokenBannerInput = {
    simulate: false,
    broker: 'fyers',
    authDegraded: false,
    fyersConfigured: true,
    tokenState: 'valid',
    msLeft: 6 * 60 * 60 * 1000,
  };

  it('says nothing before /api/meta answers or when all is well', () => {
    expect(tokenBanner({ ...base, simulate: null })).toBeNull();
    expect(tokenBanner(base)).toBeNull();
  });

  it('marks simulation with the info tone and no login', () => {
    expect(tokenBanner({ ...base, simulate: true, tokenState: 'expired' })).toMatchObject({
      tone: 'info',
      canLogin: false,
    });
  });

  it('uses warning for an expiring token and a degraded feed', () => {
    expect(tokenBanner({ ...base, tokenState: 'expiring', msLeft: 42 * 60_000 })).toMatchObject({
      tone: 'warning',
      title: 'Fyers token expires in 42m',
      canLogin: true,
    });
    expect(tokenBanner({ ...base, authDegraded: true })).toMatchObject({
      tone: 'warning',
      canLogin: true,
    });
  });

  it('uses negative for an expired token, even when the feed also reports degraded', () => {
    expect(tokenBanner({ ...base, tokenState: 'expired', authDegraded: true })).toMatchObject({
      tone: 'negative',
      title: 'Fyers token has expired',
      canLogin: true,
    });
  });

  it('ignores the Fyers token when the broker is not Fyers', () => {
    expect(tokenBanner({ ...base, broker: 'angelone', tokenState: 'expired' })).toBeNull();
    expect(tokenBanner({ ...base, broker: 'angelone', authDegraded: true })).toMatchObject({
      tone: 'warning',
      title: "Angelone rejected the feed's token",
      canLogin: false,
    });
  });

  it('ignores the Fyers token when Fyers login is not configured', () => {
    expect(tokenBanner({ ...base, fyersConfigured: false, tokenState: 'expired' })).toBeNull();
  });
});
