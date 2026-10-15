import { describe, expect, it } from 'vitest';

import type { CorrelationResponse } from '../../types/legwise';
import {
  ANY,
  DEFAULT_FILTERS,
  averagePairwise,
  bandOf,
  basisNote,
  buildSelectors,
  displayResponse,
  diversificationNote,
  extremePairs,
  familyLabel,
  isListSelector,
  matrixOf,
  pairReadout,
  pairsAtOrAbove,
  reconstructedNotes,
  reorder,
  selectorLabel,
  slotLabel,
} from '../correlationView';

describe('buildSelectors', () => {
  it('is the three NIFTY 09:17 strategies by default', () => {
    expect(buildSelectors(DEFAULT_FILTERS)).toBe('N_wide_0917,N_dir_0917,N_buy_0917');
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

describe('rotation lists in a comparison', () => {
  const stats = { net: 1, max_dd: -1, worst_day: -1, loss_day_share: 0.4, mean_over_std: 0.1 };
  const response = (names: string[], reconstructed?: Record<string, number>): CorrelationResponse =>
    ({
      names,
      kinds: names.map((n) => (n.startsWith('list:') ? 'list' : 'variant')),
      days: ['2026-01-01'],
      n_days: 60,
      window: 63,
      order: names.map((_, i) => i),
      pearson: [],
      spearman: [],
      loss_overlap: [],
      loss_corr: [],
      both_lose_days: [],
      parts: Object.fromEntries(names.map((n) => [n, stats])),
      basket: {
        names,
        net: 0,
        max_dd: 0,
        worst_day: 0,
        loss_day_share: 0,
        sum_of_part_dds: 0,
        dd_ratio: null,
        mean_over_std: null,
      },
      rolling: [],
      selectors: names,
      from: null,
      to: null,
      stale: [],
      in_sample: true,
      ...(reconstructed ? { reconstructed } : {}),
    }) as unknown as CorrelationResponse;

  it('shows a list by its name and a strategy as it is', () => {
    expect(isListSelector('list:A')).toBe(true);
    expect(isListSelector('N_wide_0917')).toBe(false);
    expect(selectorLabel('list:A')).toBe('Steady');
    expect(selectorLabel('list:B')).toBe('Calendar');
    expect(selectorLabel('list:C')).toBe('Adaptive');
    expect(selectorLabel('N_wide_0917')).toBe('N_wide_0917');
  });

  it('re-keys names, parts and the basket for display, and leaves the raw response alone', () => {
    const raw = response(['list:A', 'N_wide_0917']);
    const shown = displayResponse(raw);
    expect(shown.names).toEqual(['Steady', 'N_wide_0917']);
    expect(Object.keys(shown.parts)).toEqual(['Steady', 'N_wide_0917']);
    expect(shown.basket.names).toEqual(['Steady', 'N_wide_0917']);
    expect(raw.names).toEqual(['list:A', 'N_wide_0917']);
    // Nothing to rename: the same object comes back.
    const plain = response(['N_wide_0917', 'N_dir_0917']);
    expect(displayResponse(plain)).toBe(plain);
  });

  it('says what a list and a strategy are measured in, only when both are compared', () => {
    const basis = {
      list: 'gross per lot-day',
      legwise: 'net per lot, after costs',
    };
    const mixed = { ...response(['list:A', 'nifty_x']), basis } as CorrelationResponse;
    expect(basisNote(mixed)).toContain(
      'A list is gross per lot-day; a strategy is net per lot, after costs.',
    );
    const listsOnly = {
      ...response(['list:A', 'list:B']),
      basis: { list: 'gross per lot-day' },
    } as CorrelationResponse;
    expect(basisNote(listsOnly)).toBeNull();
    expect(basisNote(response(['N_wide_0917']))).toBeNull();
  });

  it('says how many compared days were re-scored', () => {
    expect(reconstructedNotes(response(['list:A', 'N_wide_0917'], { 'list:A': 30 }))).toEqual([
      'Steady: 30 of 60 compared days were re-scored from history, not recorded forward.',
    ]);
    expect(reconstructedNotes(response(['list:A'], { 'list:A': 0 }))).toEqual([]);
    expect(reconstructedNotes(response(['N_wide_0917']))).toEqual([]);
  });
});
