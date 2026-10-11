import { describe, expect, it } from 'vitest';

import type { CorrelationResponse } from '../../types/legwise';
import {
  ANY,
  DEFAULT_FILTERS,
  averagePairwise,
  bandOf,
  buildSelectors,
  diversificationNote,
  extremePairs,
  familyLabel,
  matrixOf,
  pairReadout,
  pairsAtOrAbove,
  reorder,
  slotLabel,
} from '../correlationView';

describe('buildSelectors', () => {
  it('is the 09:17 slot by default', () => {
    expect(buildSelectors(DEFAULT_FILTERS)).toBe('slot:0917');
  });

  it('ANDs the filters into one group and keeps hand-added names as separate selectors', () => {
    expect(
      buildSelectors({
        slot: '0917',
        family: 'wide',
        index: 'N',
        kind: ANY,
        names: ['S_dir_0932'],
      }),
    ).toBe('slot:0917+family:wide+index:N,S_dir_0932');
  });

  it('ignores slot, family and index for live strategies, which have none', () => {
    expect(
      buildSelectors({ slot: '0917', family: 'wide', index: 'N', kind: 'legwise', names: [] }),
    ).toBe('kind:legwise');
    expect(buildSelectors({ ...DEFAULT_FILTERS, kind: 'legwise', names: ['N_wide_0917'] })).toBe(
      'kind:legwise,N_wide_0917',
    );
  });

  it('asks for everything only when nothing is chosen, and not when names are', () => {
    const none = { slot: ANY, family: ANY, index: ANY, kind: ANY, names: [] as string[] };
    expect(buildSelectors(none)).toBe('all');
    expect(buildSelectors({ ...none, names: ['a_b_0917', 'c_d_0932'] })).toBe('a_b_0917,c_d_0932');
  });
});

describe('labels', () => {
  it('says slots and families the way a reader would', () => {
    expect(slotLabel('0917')).toBe('09:17');
    expect(slotLabel('x')).toBe('x');
    expect(familyLabel('wide')).toContain('Widesl');
    expect(familyLabel('p80')).toBe('Widesl, closest premium 80');
    expect(familyLabel('zzz')).toBe('zzz');
  });
});

describe('bandOf', () => {
  it.each([
    [0.95, 4],
    [0.8, 4],
    [0.6, 3],
    [0.45, 2],
    [0.2, 1],
    [0.19, 0],
    [-0.19, 0],
    [-0.2, -1],
    [-0.4, -2],
    [-0.9, -2],
  ])('puts %s in band %s', (v, band) => {
    expect(bandOf(v)).toBe(band);
  });

  it('marks what cannot be computed', () => {
    expect(bandOf(null)).toBe('na');
    expect(bandOf(Number.NaN)).toBe('na');
  });
});

function response(over: Partial<CorrelationResponse> = {}): CorrelationResponse {
  const p = [
    [1, 0.9, -0.3],
    [0.9, 1, -0.1],
    [-0.3, -0.1, 1],
  ];
  return {
    names: ['a', 'b', 'c'],
    kinds: ['variant', 'variant', 'variant'],
    days: ['2026-01-01'],
    n_days: 100,
    window: 63,
    order: [0, 1, 2],
    pearson: p,
    spearman: p,
    loss_overlap: [
      [1, 0.8, 0.3],
      [0.7, 1, 0.4],
      [0.2, 0.5, 1],
    ],
    loss_corr: p,
    both_lose_days: [
      [40, 32, 12],
      [32, 45, 18],
      [12, 18, 50],
    ],
    parts: {},
    basket: {
      names: ['a', 'b', 'c'],
      net: 0,
      max_dd: -10,
      worst_day: -5,
      loss_day_share: 0.4,
      sum_of_part_dds: -20,
      dd_ratio: 0.5,
      mean_over_std: null,
    },
    rolling: [],
    selectors: ['all'],
    from: null,
    to: null,
    stale: [],
    in_sample: true,
    ...over,
  };
}

describe('reading a response', () => {
  it('reorders rows and columns together and ignores an order that is not a permutation', () => {
    const r = response();
    const o = reorder(r.pearson, r.names, [2, 0, 1]);
    expect(o.names).toEqual(['c', 'a', 'b']);
    expect(o.m[0]).toEqual([1, -0.3, -0.1]);
    expect(o.m[1]?.[2]).toBe(0.9);
    expect(reorder(r.pearson, r.names, [0, 0, 1]).names).toEqual(['a', 'b', 'c']);
    expect(reorder(r.pearson, r.names, [0, 1]).names).toEqual(['a', 'b', 'c']);
  });

  it('summarises the pairs', () => {
    const r = response();
    expect(averagePairwise(r.pearson)).toBeCloseTo((0.9 - 0.3 - 0.1) / 3);
    const { alike, apart } = extremePairs(r.pearson, r.names);
    expect(alike).toEqual({ a: 'a', b: 'b', value: 0.9 });
    expect(apart).toEqual({ a: 'a', b: 'c', value: -0.3 });
    expect(pairsAtOrAbove(r.pearson, 0.6)).toEqual({ n: 1, of: 3 });
    expect(averagePairwise([[1]])).toBeNull();
  });

  it('skips pairs that cannot be computed', () => {
    const m = [
      [1, null, 0.5],
      [null, 1, 0.1],
      [0.5, 0.1, 1],
    ];
    expect(pairsAtOrAbove(m, 0).of).toBe(2);
  });

  it('reads one pair in both directions', () => {
    const pr = pairReadout(response(), 0, 1);
    expect(pr).toMatchObject({
      a: 'a',
      b: 'b',
      pearson: 0.9,
      bLostWhenALost: 0.8,
      aLostWhenBLost: 0.7,
      daysALost: 40,
      daysBLost: 45,
      daysBothLost: 32,
      days: 100,
    });
  });

  it('picks the matrix for a measure', () => {
    const r = response({
      spearman: [
        [1, 0.5],
        [0.5, 1],
      ],
    });
    expect(matrixOf(r, 'spearman')).toBe(r.spearman);
    expect(matrixOf(r, 'loss')).toBe(r.loss_corr);
    expect(matrixOf(r, 'pearson')).toBe(r.pearson);
  });

  it('explains the drawdown ratio in words', () => {
    expect(diversificationNote(0.52)).toBe(
      'The basket draws down 48% less than its parts added up.',
    );
    expect(diversificationNote(1.2)).toBe(
      'The basket draws down 20% more than its parts added up.',
    );
    expect(diversificationNote(1)).toContain('no diversification');
    expect(diversificationNote(null)).toContain('Not enough');
  });
});
