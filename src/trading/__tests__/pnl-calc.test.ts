import { describe, it, expect } from 'bun:test';
import {
  LOT_SIZE,
  calcGrossPnl,
  calcNetPnl,
  calcMaxDrawdown,
  calcMfe,
  calcBrierScore,
} from '../pnl-calc';

// ── calcGrossPnl ───────────────────────────────────────────────────────────────

describe('calcGrossPnl', () => {
  it('straddle decays → positive profit', () => {
    // Entry 300, exit 200 → 100pt gain × 1 lot × 75
    expect(calcGrossPnl('NIFTY', 300, 200, 1)).toBe(100 * LOT_SIZE.NIFTY);
  });

  it('straddle expands → negative P&L', () => {
    // Entry 300, exit 400 → -100pt × 1 lot × 75
    expect(calcGrossPnl('NIFTY', 300, 400, 1)).toBe(-100 * LOT_SIZE.NIFTY);
  });

  it('BANKNIFTY uses correct lot size', () => {
    expect(calcGrossPnl('BANKNIFTY', 500, 300, 1)).toBe(200 * LOT_SIZE.BANKNIFTY);
  });

  it('SENSEX uses correct lot size', () => {
    expect(calcGrossPnl('SENSEX', 1000, 600, 1)).toBe(400 * LOT_SIZE.SENSEX);
  });

  it('multiple lots scales linearly', () => {
    const single = calcGrossPnl('NIFTY', 300, 200, 1);
    expect(calcGrossPnl('NIFTY', 300, 200, 3)).toBe(single * 3);
  });

  it('position multiplier scales P&L', () => {
    const base = calcGrossPnl('NIFTY', 300, 200, 1, 1);
    expect(calcGrossPnl('NIFTY', 300, 200, 1, 2)).toBe(base * 2);
  });

  it('entry equals exit → zero', () => {
    expect(calcGrossPnl('NIFTY', 250, 250, 2)).toBe(0);
  });
});

// ── calcNetPnl ─────────────────────────────────────────────────────────────────

describe('calcNetPnl', () => {
  it('net is less than gross (costs deducted)', () => {
    const gross = calcGrossPnl('NIFTY', 300, 200, 1);
    expect(calcNetPnl('NIFTY', gross, 1)).toBeLessThan(gross);
  });

  it('even a gross-zero trade has negative net due to costs', () => {
    expect(calcNetPnl('NIFTY', 0, 1)).toBeLessThan(0);
  });

  it('costs scale with lots', () => {
    const cost1 = calcGrossPnl('NIFTY', 200, 200, 1) - calcNetPnl('NIFTY', 0, 1);
    const cost2 = calcGrossPnl('NIFTY', 200, 200, 2) - calcNetPnl('NIFTY', 0, 2);
    expect(Math.abs(cost2)).toBeCloseTo(Math.abs(cost1) * 2);
  });
});

// ── calcMaxDrawdown ────────────────────────────────────────────────────────────

describe('calcMaxDrawdown', () => {
  it('returns most negative value', () => {
    expect(calcMaxDrawdown([0, -100, -200, -50])).toBe(-200);
  });

  it('all positive series → 0 (no drawdown)', () => {
    expect(calcMaxDrawdown([0, 100, 200, 150])).toBe(0);
  });

  it('empty series → 0', () => {
    expect(calcMaxDrawdown([])).toBe(0);
  });

  it('single negative value', () => {
    expect(calcMaxDrawdown([-500])).toBe(-500);
  });
});

// ── calcMfe ────────────────────────────────────────────────────────────────────

describe('calcMfe', () => {
  it('returns highest positive value', () => {
    expect(calcMfe([0, 100, 200, 50])).toBe(200);
  });

  it('all negative series → 0 (no favorable excursion)', () => {
    expect(calcMfe([-50, -100, -200])).toBe(0);
  });

  it('empty series → 0', () => {
    expect(calcMfe([])).toBe(0);
  });

  it('single positive value', () => {
    expect(calcMfe([750])).toBe(750);
  });
});

// ── calcBrierScore ─────────────────────────────────────────────────────────────

describe('calcBrierScore', () => {
  it('empty array → 0', () => {
    expect(calcBrierScore([])).toBe(0);
  });

  it('all predictions 0.7, all won → (0.7-1)² = 0.09', () => {
    const signals = [
      { probability: 0.7, won: true },
      { probability: 0.7, won: true },
    ];
    expect(calcBrierScore(signals)).toBeCloseTo(0.09);
  });

  it('all predictions 0.7, all lost → (0.7-0)² = 0.49', () => {
    const signals = [
      { probability: 0.7, won: false },
      { probability: 0.7, won: false },
    ];
    expect(calcBrierScore(signals)).toBeCloseTo(0.49);
  });

  it('perfect calibration for binary (always 1.0 and won) → 0', () => {
    expect(calcBrierScore([{ probability: 1.0, won: true }])).toBe(0);
  });

  it('worst possible (1.0 predicted, lost) → 1.0', () => {
    expect(calcBrierScore([{ probability: 1.0, won: false }])).toBe(1.0);
  });

  it('mixed signals averages correctly', () => {
    // (0.7-1)² = 0.09, (0.6-0)² = 0.36 → avg = 0.225
    const signals = [
      { probability: 0.7, won: true },
      { probability: 0.6, won: false },
    ];
    expect(calcBrierScore(signals)).toBeCloseTo(0.225);
  });
});
