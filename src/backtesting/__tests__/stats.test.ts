/**
 * Unit tests for stats.ts
 *
 * All tests are pure — no I/O, no external dependencies.
 * Tests use approximate equality for floating-point results.
 */

import { describe, expect, it } from 'vitest';
import {
  mannWhitneyU,
  maxDrawdown,
  normalCDF,
  sharpeRatio,
  welchTTest,
} from '../stats.js';

// ---------------------------------------------------------------------------
// normalCDF
// ---------------------------------------------------------------------------

describe('normalCDF', () => {
  it('returns 0.5 at x=0', () => {
    expect(normalCDF(0)).toBeCloseTo(0.5, 5);
  });

  it('returns ~0.975 at x=1.96 (95th percentile one-sided)', () => {
    expect(normalCDF(1.96)).toBeCloseTo(0.975, 2);
  });

  it('returns ~0.025 at x=-1.96', () => {
    expect(normalCDF(-1.96)).toBeCloseTo(0.025, 2);
  });

  it('returns near 1 for large positive x', () => {
    expect(normalCDF(10)).toBeGreaterThan(0.999);
  });

  it('returns near 0 for large negative x', () => {
    expect(normalCDF(-10)).toBeLessThan(0.001);
  });
});

// ---------------------------------------------------------------------------
// welchTTest
// ---------------------------------------------------------------------------

describe('welchTTest', () => {
  it('returns null for empty arrays', () => {
    expect(welchTTest([], [])).toBeNull();
  });

  it('returns null when either array has only one element', () => {
    expect(welchTTest([1], [2])).toBeNull();
    expect(welchTTest([1, 2], [3])).toBeNull();
    expect(welchTTest([1], [2, 3])).toBeNull();
  });

  it('detects significant difference between clearly separated distributions', () => {
    // Use values with some variance so the t-statistic is finite and computable
    const a = [10, 11, 10, 9, 11, 10, 12, 9, 10, 11];
    const b = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2];
    const result = welchTTest(a, b);
    expect(result).not.toBeNull();
    expect(result!.pValue).toBeLessThan(0.05);
    expect(result!.significant).toBe(true);
  });

  it('finds no significant difference between identical distributions', () => {
    const a = [5, 5, 5, 5];
    const b = [5, 5, 5, 5];
    const result = welchTTest(a, b);
    expect(result).not.toBeNull();
    // identical arrays: t=0, p should be 1 (or at least not significant)
    expect(result!.significant).toBe(false);
  });

  it('computes positive t when mean(a) > mean(b)', () => {
    const a = [10, 12, 11, 13];
    const b = [1, 2, 1, 2];
    const result = welchTTest(a, b);
    expect(result).not.toBeNull();
    expect(result!.t).toBeGreaterThan(0);
  });

  it('returns a valid result with larger samples', () => {
    const a = Array.from({ length: 50 }, (_, i) => i * 0.1);
    const b = Array.from({ length: 50 }, (_, i) => i * 0.05);
    const result = welchTTest(a, b);
    expect(result).not.toBeNull();
    expect(result!.pValue).toBeGreaterThanOrEqual(0);
    expect(result!.pValue).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// mannWhitneyU
// ---------------------------------------------------------------------------

describe('mannWhitneyU', () => {
  it('returns null for empty arrays', () => {
    expect(mannWhitneyU([], [])).toBeNull();
    expect(mannWhitneyU([1, 2], [])).toBeNull();
    expect(mannWhitneyU([], [1, 2])).toBeNull();
  });

  it('detects significant difference between clearly separated distributions', () => {
    // All values in a are greater than all values in b
    const a = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
    const b = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = mannWhitneyU(a, b);
    expect(result).not.toBeNull();
    expect(result!.significant).toBe(true);
  });

  it('returns u, z, and pValue fields', () => {
    const a = [1, 2, 3];
    const b = [4, 5, 6];
    const result = mannWhitneyU(a, b);
    expect(result).not.toBeNull();
    expect(typeof result!.u).toBe('number');
    expect(typeof result!.z).toBe('number');
    expect(result!.pValue).toBeGreaterThanOrEqual(0);
    expect(result!.pValue).toBeLessThanOrEqual(1);
  });

  it('handles single-element arrays', () => {
    const result = mannWhitneyU([5], [1]);
    expect(result).not.toBeNull();
    // With n1=1 and n2=1, u=1 or u=0
    expect(result!.u).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// sharpeRatio
// ---------------------------------------------------------------------------

describe('sharpeRatio', () => {
  it('returns 0 for empty array', () => {
    expect(sharpeRatio([])).toBe(0);
  });

  it('returns 0 for single-element array', () => {
    expect(sharpeRatio([0.05])).toBe(0);
  });

  it('returns 0 when standard deviation is 0 (all returns identical)', () => {
    expect(sharpeRatio([0.01, 0.01, 0.01])).toBe(0);
  });

  it('returns a positive number for positive returns with variation', () => {
    const result = sharpeRatio([0.01, 0.02, 0.01]);
    expect(result).toBeGreaterThan(0);
  });

  it('returns a negative number for negative average returns', () => {
    const result = sharpeRatio([-0.05, -0.03, -0.04]);
    expect(result).toBeLessThan(0);
  });

  it('scales with sqrt(252) — higher absolute value for higher signal-to-noise', () => {
    const highSignal = sharpeRatio([0.10, 0.12, 0.11, 0.10, 0.12]);
    const lowSignal = sharpeRatio([0.001, 0.10, -0.08, 0.001, 0.10]);
    // highSignal has tighter distribution, so higher Sharpe
    expect(highSignal).toBeGreaterThan(lowSignal);
  });

  it('accepts custom risk-free rate', () => {
    const withLowRate = sharpeRatio([0.01, 0.02, 0.015], 0.02);
    const withHighRate = sharpeRatio([0.01, 0.02, 0.015], 0.10);
    // Higher risk-free rate → lower Sharpe
    expect(withLowRate).toBeGreaterThan(withHighRate);
  });
});

// ---------------------------------------------------------------------------
// maxDrawdown
// ---------------------------------------------------------------------------

describe('maxDrawdown', () => {
  it('returns zeroed result for empty array', () => {
    const result = maxDrawdown([]);
    expect(result.maxDrawdownPct).toBe(0);
    expect(result.peakIdx).toBe(0);
    expect(result.troughIdx).toBe(0);
  });

  it('returns 0 for flat series', () => {
    const result = maxDrawdown([5, 5, 5, 5]);
    expect(result.maxDrawdownPct).toBe(0);
  });

  it('computes a positive drawdown for a declining series', () => {
    // Series: 10, 8, 9, 7, 11 — peak=10 at idx 0, trough=7 at idx 3
    const result = maxDrawdown([10, 8, 9, 7, 11]);
    expect(result.maxDrawdownPct).toBeGreaterThan(0);
    // drawdown = (10 - 7) / 10 * 100 = 30%
    expect(result.maxDrawdownPct).toBeCloseTo(30, 1);
  });

  it('identifies correct peak and trough indices', () => {
    // Cumulative P&L: 0, 5, 3, 8, 2 → peak at idx 3 (8), trough at idx 4 (2)
    const result = maxDrawdown([0, 5, 3, 8, 2]);
    expect(result.peakIdx).toBe(3);
    expect(result.troughIdx).toBe(4);
    // drawdown = (8 - 2) / 8 * 100 = 75%
    expect(result.maxDrawdownPct).toBeCloseTo(75, 1);
  });

  it('handles single-element series', () => {
    const result = maxDrawdown([10]);
    expect(result.maxDrawdownPct).toBe(0);
  });

  it('handles monotonically increasing series (no drawdown)', () => {
    const result = maxDrawdown([1, 2, 3, 4, 5]);
    expect(result.maxDrawdownPct).toBe(0);
  });
});
