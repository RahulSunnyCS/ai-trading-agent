import { describe, expect, it } from 'vitest';

import {
  associationTest,
  baseRates,
  chiSquare,
  crossTab,
  meanRunLength,
  permutationTest,
  rollingShare,
  runs,
  seededRandom,
  shuffled,
  stayRate,
  transitions,
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
