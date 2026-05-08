import { describe, it, expect } from 'bun:test';
import { getAtmStrike } from '../straddle-calc';

describe('getAtmStrike', () => {
  // NIFTY — 50pt intervals
  it('NIFTY 24024 → 24000 (rounds down)', () => {
    expect(getAtmStrike(24024, 'NIFTY')).toBe(24000);
  });

  it('NIFTY 24025 → 24050 (midpoint rounds up)', () => {
    expect(getAtmStrike(24025, 'NIFTY')).toBe(24050);
  });

  it('NIFTY 24026 → 24050', () => {
    expect(getAtmStrike(24026, 'NIFTY')).toBe(24050);
  });

  it('NIFTY 24000 → 24000 (exact multiple)', () => {
    expect(getAtmStrike(24000, 'NIFTY')).toBe(24000);
  });

  // BANKNIFTY — 100pt intervals
  it('BANKNIFTY 52049 → 52000 (rounds down)', () => {
    expect(getAtmStrike(52049, 'BANKNIFTY')).toBe(52000);
  });

  it('BANKNIFTY 52050 → 52100 (midpoint rounds up)', () => {
    expect(getAtmStrike(52050, 'BANKNIFTY')).toBe(52100);
  });

  // SENSEX — 100pt intervals
  it('SENSEX 80049 → 80000 (rounds down)', () => {
    expect(getAtmStrike(80049, 'SENSEX')).toBe(80000);
  });

  it('SENSEX 80050 → 80100 (midpoint rounds up)', () => {
    expect(getAtmStrike(80050, 'SENSEX')).toBe(80100);
  });
});
