import { describe, expect, it } from 'vitest';
import { lotSize, strikeStep } from '../loader.js';

/**
 * Mirrors packages/option-backtesting/tests/unit/test_reference.py so the two
 * languages assert the same facts against the same CSVs. If someone edits a
 * CSV, both suites fail together rather than the engines drifting apart.
 */
describe('lot sizes', () => {
  it('matches the Python engine for 2026', () => {
    const asOf = new Date('2026-09-01T00:00:00Z');
    expect(lotSize('NIFTY', asOf)).toBe(65);
    expect(lotSize('BANKNIFTY', asOf)).toBe(30);
    expect(lotSize('SENSEX', asOf)).toBe(20);
  });

  it('is emphatically not 50 — that hard-coded value was a 30% error', () => {
    expect(lotSize('NIFTY', new Date('2026-09-01T00:00:00Z'))).not.toBe(50);
  });

  it('throws rather than guessing when no row is effective yet', () => {
    expect(() => lotSize('NIFTY', new Date('2020-01-01T00:00:00Z'))).toThrow(/No lot_sizes row/);
  });
});

describe('strike steps', () => {
  it('matches STRIKE_INTERVALS in instrument-registry.ts', () => {
    const asOf = new Date('2026-09-01T00:00:00Z');
    expect(strikeStep('NIFTY', asOf)).toBe(50);
    expect(strikeStep('BANKNIFTY', asOf)).toBe(100);
    expect(strikeStep('SENSEX', asOf)).toBe(100);
  });
});

describe('effective dating', () => {
  it('picks the row in force on the date, not the newest row', () => {
    // Both CSVs start at 2026-01-01; a date before that must throw, not
    // silently return today's value for a historical backtest.
    expect(() => lotSize('NIFTY', new Date('2025-12-31T00:00:00Z'))).toThrow();
    expect(lotSize('NIFTY', new Date('2026-01-01T00:00:00Z'))).toBe(65);
  });
});
