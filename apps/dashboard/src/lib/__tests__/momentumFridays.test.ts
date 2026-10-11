import { describe, expect, it } from 'vitest';

import type { MomentumFridaySpread } from '../../types/momentum';
import { fridayLuck, isAllFridays } from '../momentumFridays';

const SPREAD: MomentumFridaySpread = {
  every: 4,
  phases: [
    { offset: 0, cagr: 0.4, max_drawdown: -0.3, ulcer: 0.1 },
    { offset: 1, cagr: 0.34, max_drawdown: -0.35, ulcer: 0.12 },
    { offset: 2, cagr: 0.45, max_drawdown: -0.28, ulcer: 0.09 },
    { offset: 3, cagr: 0.38, max_drawdown: -0.32, ulcer: 0.11 },
  ],
  blend: { cagr: 0.39, max_drawdown: -0.29, ulcer: 0.08 },
  cagr_spread: 0.11,
};

describe('isAllFridays', () => {
  it('needs the flag and a weekly cadence of 2 or more', () => {
    const base = { rebalance: 'weekly', rebalance_every: 4, split_fridays: true };
    expect(isAllFridays(base)).toBe(true);
    expect(isAllFridays({ ...base, split_fridays: false })).toBe(false);
    expect(isAllFridays({ ...base, rebalance_every: 1 })).toBe(false);
    expect(isAllFridays({ ...base, rebalance: 'monthly' })).toBe(false);
    expect(isAllFridays({})).toBe(false);
  });
});

describe('fridayLuck', () => {
  it('lists each Friday then the whole account, with the gap to the account', () => {
    const luck = fridayLuck(SPREAD);
    expect(luck?.rows.map((r) => r.label)).toEqual([
      'Friday 1 of 4',
      'Friday 2 of 4',
      'Friday 3 of 4',
      'Friday 4 of 4',
      'All Fridays (split)',
    ]);
    expect(luck?.rows[0]?.gap).toBeCloseTo(0.01);
    expect(luck?.rows[4]).toMatchObject({ offset: null, gap: 0, cagr: 0.39 });
  });

  it('names the luckiest and unluckiest Friday and the spread between them', () => {
    const luck = fridayLuck(SPREAD);
    expect(luck?.best.label).toBe('Friday 3 of 4');
    expect(luck?.worst.label).toBe('Friday 2 of 4');
    expect(luck?.spread).toBeCloseTo(0.11);
  });

  it('has nothing to show without phases', () => {
    expect(fridayLuck({ ...SPREAD, phases: [] })).toBeNull();
  });
});
