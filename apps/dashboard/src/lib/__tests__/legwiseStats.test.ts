import { describe, expect, it } from 'vitest';

import { MIN_DAYS_FOR_RATIOS, compareToBaseline, lotsOf, statsOf } from '../legwiseStats';

const day = (d: string, net: number) => ({ day: d, net });

describe('statsOf', () => {
  it('computes win rate, averages, expectancy, profit factor and extremes', () => {
    const s = statsOf([day('2026-09-24', 100), day('2026-09-25', -50), day('2026-09-26', 250)]);
    expect(s.days).toBe(3);
    expect(s.up).toBe(2);
    expect(s.winRate).toBeCloseTo(2 / 3);
    expect(s.avgWin).toBe(175);
    expect(s.avgLoss).toBe(-50);
    expect(s.expectancy).toBeCloseTo(100);
    expect(s.profitFactor).toBeCloseTo(350 / 50);
    expect(s.best).toBe(250);
    expect(s.worst).toBe(-50);
    expect(s.total).toBe(300);
  });

  it('orders by day regardless of input order, and tracks drawdown from the running peak', () => {
    const s = statsOf([day('2026-09-26', -300), day('2026-09-24', 200), day('2026-09-25', 100)]);
    expect(s.cumulative.map((p) => p.value)).toEqual([200, 300, 0]);
    expect(s.maxDrawdown).toBe(-300);
  });

  it('finds the longest run of losing days, and a zero day ends it', () => {
    const s = statsOf([
      day('2026-09-01', -1),
      day('2026-09-02', -1),
      day('2026-09-03', 0),
      day('2026-09-04', -1),
      day('2026-09-05', -1),
      day('2026-09-06', -1),
    ]);
    expect(s.longestLosingStreak).toBe(3);
  });

  it('normalises to ₹ per lot', () => {
    const one = statsOf([day('2026-09-24', 100), day('2026-09-25', -40)]);
    const two = statsOf([day('2026-09-24', 200), day('2026-09-25', -80)], 2);
    expect(two.total).toBe(one.total);
    expect(two.worst).toBe(one.worst);
    expect(two.profitFactor).toBe(one.profitFactor);
  });

  it('never invents a number from nothing: empty and all-winning inputs', () => {
    const empty = statsOf([]);
    expect(empty.winRate).toBeNull();
    expect(empty.expectancy).toBeNull();
    expect(empty.best).toBeNull();
    expect(empty.maxDrawdown).toBe(0);
    const allWins = statsOf([day('2026-09-24', 10), day('2026-09-25', 20)]);
    expect(allWins.profitFactor).toBeNull(); // not Infinity
    expect(allWins.avgLoss).toBeNull();
  });

  it('flags small samples as thin until MIN_DAYS_FOR_RATIOS', () => {
    const make = (n: number) =>
      statsOf(
        Array.from({ length: n }, (_, i) => day(`2026-01-${String(i + 1).padStart(2, '0')}`, 1)),
      );
    expect(make(MIN_DAYS_FOR_RATIOS - 1).thin).toBe(true);
    expect(make(MIN_DAYS_FOR_RATIOS).thin).toBe(false);
  });

  it('treats a non-positive lot divisor as 1 rather than dividing by zero', () => {
    expect(statsOf([day('2026-09-24', 100)], 0).total).toBe(100);
  });
});

describe('lotsOf', () => {
  it('is the smallest leg size, floored at 1', () => {
    expect(lotsOf({ legs: [{ lots: 2 }, { lots: 4 }] })).toBe(2);
    expect(lotsOf({ legs: [{ lots: 1 }] })).toBe(1);
    expect(lotsOf({ legs: [] })).toBe(1);
    expect(lotsOf(undefined)).toBe(1);
  });
});

describe('compareToBaseline', () => {
  const saved = new Map([
    ['2026-09-24', 100],
    ['2026-09-25', -50],
  ]);

  it('reports the per-lot delta on shared days and totals only those', () => {
    const c = compareToBaseline(
      [day('2026-09-24', 160), day('2026-09-25', -50), day('2026-09-26', 999)],
      1,
      saved,
    );
    expect(c.byDay.get('2026-09-24')).toEqual({ saved: 100, delta: 60 });
    expect(c.byDay.get('2026-09-25')).toEqual({ saved: -50, delta: 0 });
    expect(c.shared).toBe(2);
    expect(c.deltaTotal).toBe(60);
    expect(c.uncovered).toBe(1); // 09-26 has no saved result: excluded, not treated as 0
  });

  it('normalises the edit to ₹ per lot before comparing', () => {
    const c = compareToBaseline([day('2026-09-24', 240)], 2, saved);
    expect(c.byDay.get('2026-09-24')?.delta).toBe(20); // 240 / 2 = 120 vs saved 100
  });

  it('is empty, not NaN, when nothing overlaps', () => {
    const c = compareToBaseline([day('2027-01-01', 5)], 1, saved);
    expect(c).toMatchObject({ shared: 0, deltaTotal: 0, uncovered: 1 });
  });
});
