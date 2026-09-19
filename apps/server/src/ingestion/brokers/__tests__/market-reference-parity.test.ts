import { lotSize, strikeStep } from '@trading/market-reference';
import { describe, expect, it } from 'vitest';
import { STRIKE_INTERVALS } from '../instrument-registry.js';

/**
 * Guards the gap that let a real bug live for months.
 *
 * packages/option-backtesting already had a test asserting NIFTY's lot size is
 * 65, and it passed. Its docstring said the value must agree with
 * instrument-registry.ts. But instrument-registry.ts only ever defined strike
 * intervals — the lot size lived as a hard-coded 50 scattered across
 * trading/, with nothing to compare it against. So the two engines computed
 * P&L 30% apart and every suite stayed green.
 *
 * This test compares the TypeScript side against the same CSVs the Python
 * engine reads, so any future divergence fails here instead of silently
 * invalidating the paper-vs-backtest comparison.
 */
describe('market reference parity', () => {
  const asOf = new Date('2026-09-01T00:00:00Z');

  it('STRIKE_INTERVALS agrees with the shared reference data', () => {
    expect(STRIKE_INTERVALS.NIFTY).toBe(strikeStep('NIFTY', asOf));
    expect(STRIKE_INTERVALS.BANKNIFTY).toBe(strikeStep('BANKNIFTY', asOf));
    expect(STRIKE_INTERVALS.SENSEX).toBe(strikeStep('SENSEX', asOf));
  });

  it('lot sizes come from the reference data, not a constant', () => {
    expect(lotSize('NIFTY', asOf)).toBe(65);
    expect(lotSize('BANKNIFTY', asOf)).toBe(30);
    expect(lotSize('SENSEX', asOf)).toBe(20);
  });
});
