import { describe, expect, it } from 'vitest';

import {
  associationTest,
  baseRates,
  calendarWeeks,
  chiSquare,
  crossTab,
  expiryCounts,
  filterByExpiry,
  liftBand,
  matchesExpiry,
  meanRunLength,
  permutationTest,
  rollingShare,
  runs,
  seededRandom,
  shuffled,
  stayRate,
  stayRateInto,
  transitions,
  transitionsInto,
  weekStart,
  weekdayIndex,
} from '../regimeStats';

const rep = (xs: string[], n: number) => Array.from({ length: n }).flatMap(() => xs);

describe('seededRandom / shuffled', () => {
  it('is deterministic per seed and differs across seeds', () => {
    const a = Array.from({ length: 5 }, seededRandom(1));
    expect(Array.from({ length: 5 }, seededRandom(1))).toEqual(a);
    expect(Array.from({ length: 5 }, seededRandom(2))).not.toEqual(a);
    expect(a.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it('shuffle keeps the multiset and does not mutate its input', () => {
    const src = ['a', 'b', 'c', 'd', 'e', 'f'];
    const out = shuffled(src, seededRandom(3));
    expect([...out].sort()).toEqual([...src].sort());
    expect(src).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

describe('transitions / stayRate / baseRates', () => {
  const labels = ['A', 'A', 'B', 'A', null, 'B', 'B'];
  it('counts consecutive known pairs only (a missing day breaks the pair)', () => {
    const t = transitions(labels, ['A', 'B']);
    expect(t.counts.A).toEqual({ A: 1, B: 1 });
    expect(t.counts.B).toEqual({ A: 1, B: 1 });
    expect(t.fromTotals).toEqual({ A: 2, B: 2 });
    expect(t.probs.A?.B).toBe(0.5);
  });

  it('leaves the row empty for a state that never occurs, rather than dividing by zero', () => {
    const t = transitions(['A', 'A'], ['A', 'B']);
    expect(t.probs.B).toEqual({});
  });

  it('stayRate and baseRates ignore unknown/null', () => {
    expect(stayRate(['A', 'A', 'A', 'B'])).toBeCloseTo(2 / 3);
    expect(stayRate(['A'])).toBeNull();
    expect(baseRates(['A', 'A', 'B', null, 'UNKNOWN'])).toEqual({ A: 2 / 3, B: 1 / 3 });
  });
});

describe('permutationTest', () => {
  it('finds clustering in a long-run sequence (low p) but not in a well-mixed one', () => {
    const clustered = [...Array(40).fill('A'), ...Array(40).fill('B'), ...Array(40).fill('A')];
    const sticky = permutationTest(clustered, stayRate, 500, 9);
    expect(sticky?.observed).toBeGreaterThan(0.95);
    expect(sticky?.p).toBeLessThan(0.01);

    const alternating = rep(['A', 'B'], 60); // anti-persistent: stays far LESS than chance
    const flip = permutationTest(alternating, stayRate, 500, 9);
    expect(flip?.p).toBeGreaterThan(0.9);
  });

  it('is reproducible for a fixed seed and never returns p = 0', () => {
    const labels = [...Array(30).fill('A'), ...Array(30).fill('B')];
    const a = permutationTest(labels, stayRate, 200, 5);
    const b = permutationTest(labels, stayRate, 200, 5);
    expect(a).toEqual(b);
    expect(a?.p).toBeGreaterThan(0);
  });

  it('returns null when the statistic is undefined', () => {
    expect(permutationTest([], stayRate)).toBeNull();
  });
});

describe('runs', () => {
  it('splits maximal runs and an unknown day ends one', () => {
    expect(runs(['A', 'A', 'B', 'B', 'B', null, 'B', 'A'])).toEqual([
      { label: 'A', length: 2 },
      { label: 'B', length: 3 },
      { label: 'B', length: 1 },
      { label: 'A', length: 1 },
    ]);
    expect(meanRunLength(['A', 'A', 'B'])).toBeCloseTo(1.5);
    expect(meanRunLength([])).toBeNull();
  });
});

describe('rollingShare', () => {
  it('emits once the window is full and skips unknown days', () => {
    const days = [true, false, true, true, null, false].map((value, i) => ({
      day: `d${i}`,
      value,
    }));
    expect(rollingShare(days, 2)).toEqual([
      { time: 'd1', value: 50 },
      { time: 'd2', value: 50 },
      { time: 'd3', value: 100 },
      { time: 'd5', value: 50 },
    ]);
  });
});

describe('crossTab / chiSquare / associationTest', () => {
  const rows = ['U', 'D'];
  const cols = ['Q', 'C'];

  it('tabulates same-day pairs and skips unknowns', () => {
    const t = crossTab(['U', 'U', 'D', null], ['Q', 'C', 'C', 'C'], rows, cols);
    expect(t.n).toBe(3);
    expect(t.counts.U).toEqual({ Q: 1, C: 1 });
    expect(t.rowTotals).toEqual({ U: 2, D: 1 });
  });

  it('chi-square is 0 for independent tables and large for a perfect association', () => {
    const indep = crossTab(
      rep(['U', 'U', 'D', 'D'], 10),
      rep(['Q', 'C', 'Q', 'C'], 10),
      rows,
      cols,
    );
    expect(chiSquare(indep)).toBeCloseTo(0);
    const perfect = crossTab(rep(['U', 'D'], 20), rep(['Q', 'C'], 20), rows, cols);
    expect(chiSquare(perfect)).toBeCloseTo(40);
    expect(chiSquare(crossTab([], [], rows, cols))).toBeNull();
  });

  it('flags a real association and not an unrelated one', () => {
    const a = rep(['U', 'D'], 40);
    const real = associationTest(a, rep(['Q', 'C'], 40), rows, cols, 400, 3);
    expect(real?.p).toBeLessThan(0.01);
    const rand = seededRandom(11);
    const noise = Array.from({ length: 80 }, () => (rand() < 0.5 ? 'Q' : 'C'));
    expect(associationTest(a, noise, rows, cols, 400, 3)?.p).toBeGreaterThan(0.05);
  });
});

describe('expiry filter', () => {
  const days = [
    { day: 'd0', is_expiry: null },
    { day: 'd1', is_expiry: false },
    { day: 'd2', is_expiry: true },
    { day: 'd3', is_expiry: false },
    { day: 'd4' },
  ];

  it("'all' keeps every day (the same array), the others only days with a flag", () => {
    expect(filterByExpiry(days, 'all')).toBe(days);
    expect(filterByExpiry(days, 'expiry').map((d) => d.day)).toEqual(['d2']);
    expect(filterByExpiry(days, 'non_expiry').map((d) => d.day)).toEqual(['d1', 'd3']);
  });

  it('a day with no flag matches neither side', () => {
    expect(matchesExpiry({ is_expiry: null }, 'all')).toBe(true);
    expect(matchesExpiry({ is_expiry: null }, 'expiry')).toBe(false);
    expect(matchesExpiry({}, 'non_expiry')).toBe(false);
  });

  it('counts each kind', () => {
    expect(expiryCounts(days)).toEqual({ expiry: 1, nonExpiry: 2, unknown: 2 });
    expect(expiryCounts([])).toEqual({ expiry: 0, nonExpiry: 0, unknown: 0 });
  });
});

describe('transitionsInto / stayRateInto', () => {
  const labels = ['A', 'A', 'B', 'B', null, 'A', 'A'];
  const all = labels.map(() => true);

  it('equals transitions / stayRate when every day is kept', () => {
    expect(transitionsInto(labels, ['A', 'B'], all)).toEqual(transitions(labels, ['A', 'B']));
    expect(stayRateInto(labels, all)).toBe(stayRate(labels));
  });

  it('counts only pairs whose next day is kept, on real adjacency', () => {
    // keep days 2 and 6: pairs (1→2) = A→B and (5→6) = A→A
    const keep = labels.map((_, i) => i === 2 || i === 6);
    const t = transitionsInto(labels, ['A', 'B'], keep);
    expect(t.counts.A).toEqual({ A: 1, B: 1 });
    expect(t.fromTotals).toEqual({ A: 2, B: 0 });
    expect(t.probs.B).toEqual({});
    expect(stayRateInto(labels, keep)).toBe(0.5);
  });

  it('skips a kept day whose previous day is unknown, and returns null with no pairs', () => {
    const keep = labels.map((_, i) => i === 5);
    expect(transitionsInto(labels, ['A', 'B'], keep).fromTotals).toEqual({ A: 0, B: 0 });
    expect(stayRateInto(labels, keep)).toBeNull();
    expect(
      stayRateInto(
        labels,
        labels.map(() => false),
      ),
    ).toBeNull();
  });

  it('works as a permutation-test statistic', () => {
    const clustered = [...Array(40).fill('A'), ...Array(40).fill('B')];
    const keep = clustered.map((_, i) => i % 2 === 0);
    const test = permutationTest(clustered, (ls) => stayRateInto(ls, keep), 300, 7);
    expect(test?.observed).toBeGreaterThan(0.95);
    expect(test?.p).toBeLessThan(0.01);
  });
});

describe('liftBand', () => {
  it('bands the distance from the base rate at 10 and 20 points, both ways', () => {
    expect(liftBand(0.5, 0.45)).toBe(0);
    expect(liftBand(0.3, 0.2)).toBe(1);
    expect(liftBand(0.2, 0.3)).toBe(-1);
    expect(liftBand(0.55, 0.3)).toBe(2);
    expect(liftBand(0.05, 0.3)).toBe(-2);
    expect(liftBand(0.3, 0.3)).toBe(0);
  });

  it('is 0 when either number is missing', () => {
    expect(liftBand(undefined, 0.3)).toBe(0);
    expect(liftBand(0.3, undefined)).toBe(0);
    expect(liftBand(null, null)).toBe(0);
    expect(liftBand(Number.NaN, 0.3)).toBe(0);
  });
});

describe('calendar layout', () => {
  it('finds the weekday and the Monday of a day', () => {
    expect(weekdayIndex('2026-09-21')).toBe(0); // Monday
    expect(weekdayIndex('2026-09-23')).toBe(2);
    expect(weekdayIndex('2026-09-27')).toBe(6);
    expect(weekStart('2026-09-23')).toBe('2026-09-21');
    expect(weekStart('2026-10-01')).toBe('2026-09-28');
    expect(weekStart('2026-09-21')).toBe('2026-09-21');
  });

  it('makes one column per week with days and marks where each month starts', () => {
    const weeks = calendarWeeks([
      '2026-09-23',
      '2026-09-24',
      '2026-09-29',
      '2026-10-01',
      '2026-10-05',
      '2026-10-20',
    ]);
    expect(weeks).toEqual([
      { week: '2026-09-21', monthStart: '2026-09-23', yearStart: true },
      { week: '2026-09-28', monthStart: '2026-10-01', yearStart: false },
      { week: '2026-10-05', monthStart: null, yearStart: false },
      { week: '2026-10-19', monthStart: null, yearStart: false },
    ]);
  });

  it('moves a month label to the next column when its first week already carries one', () => {
    const weeks = calendarWeeks(['2026-09-30', '2026-10-01', '2026-10-06']);
    expect(weeks).toEqual([
      { week: '2026-09-28', monthStart: '2026-09-30', yearStart: true },
      { week: '2026-10-05', monthStart: '2026-10-06', yearStart: false },
    ]);
  });

  it('flags a new year, sorts its input and handles no days', () => {
    const weeks = calendarWeeks(['2027-01-04', '2026-12-28']);
    expect(weeks.map((w) => w.yearStart)).toEqual([true, true]);
    expect(weeks[1]?.monthStart).toBe('2027-01-04');
    expect(calendarWeeks([])).toEqual([]);
  });
});
