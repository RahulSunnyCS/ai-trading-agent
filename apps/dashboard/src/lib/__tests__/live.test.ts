import { describe, expect, it } from 'vitest';

import { NIFTY_INDEX_SYMBOL, TICK_BUFFER_CAP, appendPoint, isIndexTick } from '../live';

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
