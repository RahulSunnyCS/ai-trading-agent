/**
 * Unit tests for straddle-math.ts — the pure straddle computation module.
 *
 * These tests exercise the three exported pure functions directly:
 *   - computeStraddleValue
 *   - computeRoc
 *   - computeAcceleration
 *   - pushToBuffer
 *
 * No DB, no Redis, no clock. All tests are hermetic and deterministic.
 *
 * The ROC and acceleration edge cases here mirror the tests in straddle-calc.test.ts
 * (which imports computeRoc / computeAcceleration via straddle-calc's re-export).
 * These direct tests are added to: (a) document the pure module itself, and
 * (b) prove behaviour independently of straddle-calc's re-export wrapper.
 */

import { describe, expect, it } from 'vitest';

import {
  computeAcceleration,
  computeRoc,
  computeStraddleValue,
  pushToBuffer,
} from '../straddle-math';

// ---------------------------------------------------------------------------
// computeStraddleValue
// ---------------------------------------------------------------------------

describe('computeStraddleValue', () => {
  it('returns the sum of call and put premiums', () => {
    expect(computeStraddleValue(150, 145)).toBe(295);
    expect(computeStraddleValue(0, 0)).toBe(0);
    expect(computeStraddleValue(100.5, 99.5)).toBeCloseTo(200, 8);
  });

  it('handles edge cases: one leg at zero', () => {
    // A zero-premium leg is theoretically impossible at market open but not
    // in synthetic test data. The function should still sum correctly.
    expect(computeStraddleValue(0, 200)).toBe(200);
    expect(computeStraddleValue(200, 0)).toBe(200);
  });

  it('is commutative (call/put order does not matter for the total)', () => {
    const a = computeStraddleValue(120, 80);
    const b = computeStraddleValue(80, 120);
    expect(a).toBe(b);
    expect(a).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// computeRoc
// ---------------------------------------------------------------------------

describe('computeRoc', () => {
  it('returns 0 when the buffer is empty', () => {
    expect(computeRoc([])).toBe(0);
  });

  it('returns 0 when the buffer has only 1 entry — needs at least 2', () => {
    expect(computeRoc([100])).toBe(0);
  });

  it('computes ROC correctly: (current - prev) / prev * 100', () => {
    // From 100 to 110: (110 - 100) / 100 * 100 = 10%
    expect(computeRoc([100, 110])).toBeCloseTo(10, 8);
    // From 200 to 190: (190 - 200) / 200 * 100 = -5%
    expect(computeRoc([200, 190])).toBeCloseTo(-5, 8);
  });

  it('uses only the last two entries even when the buffer is longer', () => {
    // Entries before the last two must be ignored
    expect(computeRoc([50, 60, 100, 110])).toBeCloseTo(10, 8);
    expect(computeRoc([999, 888, 200, 190])).toBeCloseTo(-5, 8);
  });

  it('returns 0 when the previous value is 0 — divide-by-zero guard', () => {
    expect(computeRoc([0, 100])).toBe(0);
  });

  it('handles negative ROC correctly', () => {
    // From 500 to 400: -20%
    expect(computeRoc([500, 400])).toBeCloseTo(-20, 8);
  });

  it('handles identical consecutive values — ROC should be 0', () => {
    expect(computeRoc([300, 300])).toBeCloseTo(0, 8);
  });
});

// ---------------------------------------------------------------------------
// computeAcceleration
// ---------------------------------------------------------------------------

describe('computeAcceleration', () => {
  it('returns 0 when the buffer is empty', () => {
    expect(computeAcceleration([])).toBe(0);
  });

  it('returns 0 when the buffer has only 1 entry', () => {
    expect(computeAcceleration([100])).toBe(0);
  });

  it('returns 0 when the buffer has only 2 entries — needs at least 3', () => {
    expect(computeAcceleration([100, 110])).toBe(0);
  });

  it('computes acceleration as roc_current - roc_prev', () => {
    // buffer = [a, b, c]
    // roc_prev = (b - a) / a * 100
    // roc_curr = (c - b) / b * 100
    // acceleration = roc_curr - roc_prev
    const a = 100;
    const b = 110;
    const c = 121;
    const rocPrev = ((b - a) / a) * 100; // 10%
    const rocCurr = ((c - b) / b) * 100; // 10%
    const expected = rocCurr - rocPrev;   // 0% — constant growth rate
    expect(computeAcceleration([a, b, c])).toBeCloseTo(expected, 8);
  });

  it('returns positive acceleration when growth rate is increasing', () => {
    const a = 100;
    const b = 105;
    const c = 115.5;
    const rocPrev = ((b - a) / a) * 100; // 5%
    const rocCurr = ((c - b) / b) * 100; // ~10%
    const expected = rocCurr - rocPrev;
    expect(computeAcceleration([a, b, c])).toBeCloseTo(expected, 6);
  });

  it('returns negative acceleration when growth rate is decreasing', () => {
    const a = 100;
    const b = 120; // +20%
    const c = 126; // +5%
    const rocPrev = ((b - a) / a) * 100;
    const rocCurr = ((c - b) / b) * 100;
    const expected = rocCurr - rocPrev; // negative: rate decreased
    expect(computeAcceleration([a, b, c])).toBeCloseTo(expected, 6);
  });

  it('uses only the last three entries from a longer buffer', () => {
    // The first entry (50) must be ignored; only [100, 110, 121] should matter
    const a = 100;
    const b = 110;
    const c = 121;
    const rocPrev = ((b - a) / a) * 100;
    const rocCurr = ((c - b) / b) * 100;
    const expected = rocCurr - rocPrev;
    expect(computeAcceleration([50, a, b, c])).toBeCloseTo(expected, 8);
    expect(computeAcceleration([999, 888, a, b, c])).toBeCloseTo(expected, 8);
  });

  it('returns 0 when the 3rd-from-last (a) entry is 0 — divide-by-zero guard', () => {
    // roc_prev would divide by a=0; guard must return 0
    expect(computeAcceleration([0, 100, 110])).toBe(0);
  });

  it('returns 0 when the 2nd-from-last (b) entry is 0 — divide-by-zero guard', () => {
    // roc_curr would divide by b=0; guard must return 0
    expect(computeAcceleration([100, 0, 110])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pushToBuffer
// ---------------------------------------------------------------------------

describe('pushToBuffer', () => {
  it('pushes a value onto an empty buffer', () => {
    const buf: number[] = [];
    pushToBuffer(buf, 100, 5);
    expect(buf).toEqual([100]);
  });

  it('maintains values below the cap without truncation', () => {
    const buf: number[] = [100, 200, 300];
    pushToBuffer(buf, 400, 5);
    expect(buf).toEqual([100, 200, 300, 400]);
  });

  it('truncates the oldest entry when the cap is exceeded', () => {
    const buf: number[] = [1, 2, 3, 4, 5];
    pushToBuffer(buf, 6, 5);
    // Oldest entry (1) must be removed; newest (6) must be at end
    expect(buf).toEqual([2, 3, 4, 5, 6]);
  });

  it('returns the same buffer reference (mutates in place)', () => {
    const buf: number[] = [100];
    const result = pushToBuffer(buf, 200, 5);
    // Must be the same object, not a copy
    expect(result).toBe(buf);
  });

  it('respects a cap of 1 — only the most recent value is kept', () => {
    const buf: number[] = [];
    pushToBuffer(buf, 10, 1);
    pushToBuffer(buf, 20, 1);
    pushToBuffer(buf, 30, 1);
    expect(buf).toEqual([30]);
  });

  it('cap=3: rolling buffer semantics across multiple calls', () => {
    const buf: number[] = [];
    const values = [100, 110, 121, 133, 146];
    for (const v of values) {
      pushToBuffer(buf, v, 3);
    }
    // Only the last 3 values should remain
    expect(buf).toEqual([121, 133, 146]);
  });
});

// ---------------------------------------------------------------------------
// Integration: push + compute (mirrors the straddle-calc internal loop)
// ---------------------------------------------------------------------------

describe('pushToBuffer + computeRoc + computeAcceleration — combined semantics', () => {
  it('produces roc=0 and acceleration=0 for the first snapshot (1 entry)', () => {
    const buf: number[] = [];
    pushToBuffer(buf, 300, 5);
    expect(computeRoc(buf)).toBe(0);
    expect(computeAcceleration(buf)).toBe(0);
  });

  it('produces roc≠0 and acceleration=0 after 2 entries', () => {
    const buf: number[] = [];
    pushToBuffer(buf, 300, 5);
    pushToBuffer(buf, 315, 5);
    // ROC = (315-300)/300*100 = 5%
    expect(computeRoc(buf)).toBeCloseTo(5, 8);
    // Still only 2 entries — acceleration is 0
    expect(computeAcceleration(buf)).toBe(0);
  });

  it('produces roc≠0 and acceleration≠0 from 3+ entries onward', () => {
    const buf: number[] = [];
    pushToBuffer(buf, 300, 5);
    pushToBuffer(buf, 315, 5);
    pushToBuffer(buf, 346.5, 5);
    // roc_prev = 5%, roc_curr = (346.5-315)/315*100 = 10%
    // acceleration = 10% - 5% = 5%
    const roc = computeRoc(buf);
    const acc = computeAcceleration(buf);
    expect(roc).toBeCloseTo(10, 5);
    expect(acc).toBeCloseTo(5, 5);
  });
});
