import { describe, expect, it } from 'vitest';

import type { CorrelationResponse } from '../../types/legwise';
import type { BasketPick, RotationBasketResponse } from '../../types/rotationBasket';
import {
  asBasketList,
  asBasketWindow,
  customNames,
  drawdownSaving,
  familyWord,
  lossPairs,
  pairSummary,
  readingLine,
  sourceBadge,
  sourceNote,
} from '../rotationBasketView';

function corr(over: Partial<CorrelationResponse> = {}): CorrelationResponse {
  const p = [
    [1, -0.05, 0.16],
    [-0.05, 1, 0.14],
    [0.16, 0.14, 1],
  ];
  const stats = (net: number, dd: number) => ({
    net,
    max_dd: dd,
    worst_day: -2500,
    loss_day_share: 0.4,
    mean_over_std: 0.1,
  });
  return {
    names: ['N_wide_0932', 'S_dir_1202', 'S_wide_1347'],
    kinds: ['variant', 'variant', 'variant'],
    days: ['2025-12-03', '2026-10-08'],
    n_days: 100,
    window: 63,
    order: [0, 1, 2],
    pearson: p,
    spearman: p,
    loss_overlap: p,
    loss_corr: p,
    both_lose_days: [
      [40, 20, 30],
      [20, 40, 18],
      [30, 18, 40],
    ],
    parts: {
      N_wide_0932: stats(1000, -20000),
      S_dir_1202: stats(900, -30000),
      S_wide_1347: stats(800, -50000),
    },
    basket: {
      names: ['N_wide_0932', 'S_dir_1202', 'S_wide_1347'],
      net: 2700,
      max_dd: -60000,
      worst_day: -4000,
      loss_day_share: 0.3,
      sum_of_part_dds: -100000,
      dd_ratio: 0.6,
      mean_over_std: 0.2,
    },
    rolling: [],
    selectors: [],
    from: '2025-12-03',
    to: '2026-10-08',
    stale: [],
    in_sample: true,
    ...over,
  };
}

function pick(over: Partial<BasketPick> = {}): BasketPick {
  return {
    name: 'N_wide_0932',
    index: 'NIFTY',
    family: 'wide',
    kind: 'wide',
    start: '09:32',
    band: 'A',
    role: 'core',
    lots: 2,
    composite: 0.861,
    has_results: true,
    first: '2024-10-09',
    last: '2026-10-09',
    n_days: 487,
    ...over,
  };
}

function basket(over: Partial<RotationBasketResponse> = {}): RotationBasketResponse {
  return {
    list: 'A',
    label: 'List A',
    day: '2026-10-12',
    weekday: 'Mon',
    source: 'recorded',
    late: false,
    overridden: false,
    picks: [pick()],
    omitted: [],
    duplicates: [],
    lots: 6,
    windows: {
      P1: { id: 'P1', label: 'P1', from: null, to: null, n_days: 203 },
      P2: { id: 'P2', label: 'P2', from: null, to: null, n_days: 158 },
      last63: { id: 'last63', label: 'Last 63', from: null, to: null, n_days: 63 },
      forward: { id: 'forward', label: 'Forward', from: null, to: null, n_days: 0 },
    },
    window: { id: 'P1', label: 'P1', from: '2025-12-03', to: '2026-10-08' },
    correlation: corr(),
    reason: null,
    n_days: 100,
    enough: true,
    thin_days: 20,
    all_lose_days: 11,
    any_lose_days: 70,
    forward_days: 0,
    basis: 'gross',
    in_sample: true,
    notes: [],
    ...over,
  };
}

describe('controls', () => {
  it('falls back to list A and window P1 for anything it does not know', () => {
    expect(asBasketList(null)).toBe('A');
    expect(asBasketList('Z')).toBe('A');
    expect(asBasketList('BASE')).toBe('BASE');
    expect(asBasketWindow(null)).toBe('P1');
    expect(asBasketWindow('custom')).toBe('P1'); // not offered in the UI
    expect(asBasketWindow('forward')).toBe('forward');
  });
});

describe('where the picks came from', () => {
  it('names recorded, late, reconstructed and base apart', () => {
    expect(sourceBadge('recorded', false).label).toBe('Recorded');
    expect(sourceBadge('recorded', true)).toEqual({ label: 'Recorded late', tone: 'warning' });
    expect(sourceBadge('reconstructed', false).label).toBe('Reconstructed');
    expect(sourceBadge('base', false).label).toBe('Fixed base');
  });

  it('says in words that a late entry is not forward and a reconstruction is not a record', () => {
    expect(sourceNote('recorded', true)).toContain('not a forward day');
    expect(sourceNote('reconstructed', false)).toContain('No entry was recorded');
    expect(sourceNote('base', false)).toContain('Widesl OTM1 09:17');
  });

  it('says the family the way a reader would', () => {
    expect(familyWord(pick({ kind: 'wide' }))).toBe('Widesl');
    expect(familyWord(pick({ kind: 'dir' }))).toBe('Dir');
    expect(familyWord(pick({ kind: 'buy' }))).toBe('Buy');
    expect(familyWord(pick({ kind: null }))).toBe('');
  });
});

describe('lossPairs', () => {
  it('counts the days both lost out of the days either lost, per pair', () => {
    const pairs = lossPairs(corr());
    // each lost 40 days (the diagonal). both(0,1) = 20 -> either = 40 + 40 - 20 = 60
    expect(pairs).toHaveLength(3);
    const first = pairs[0];
    expect(first).toMatchObject({ a: 'N_wide_0932', b: 'S_dir_1202', both: 20, either: 60 });
    expect(first?.share).toBeCloseTo(20 / 60);
    expect(first?.r).toBe(-0.05);
  });

  it('has no share for a pair that never lost', () => {
    const r = corr({
      parts: {
        N_wide_0932: { net: 1, max_dd: 0, worst_day: 1, loss_day_share: 0, mean_over_std: 1 },
        S_dir_1202: { net: 1, max_dd: 0, worst_day: 1, loss_day_share: 0, mean_over_std: 1 },
        S_wide_1347: { net: 1, max_dd: 0, worst_day: 1, loss_day_share: 0, mean_over_std: 1 },
      },
      both_lose_days: [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
    });
    expect(lossPairs(r).every((p) => p.share === null && p.either === 0)).toBe(true);
  });
});

describe('a column that repeats another by construction', () => {
  it('is left out of the pair table and the pair summary', () => {
    const r = corr({
      names: ['W', 'W (2nd)', 'D'],
      pearson: [
        [1, 1, 0.28],
        [1, 1, 0.28],
        [0.28, 0.28, 1],
      ],
      both_lose_days: [
        [75, 75, 31],
        [75, 75, 31],
        [31, 31, 75],
      ],
    });
    const pairs = lossPairs(r, ['W (2nd)']);
    expect(pairs.map((p) => `${p.a}|${p.b}`)).toEqual(['W|D']);
    const sum = pairSummary(r, ['W (2nd)']);
    expect(sum.count).toBe(1);
    expect(sum.average).toBeCloseTo(0.28);
    expect(sum.most?.a).toBe('W');
    expect(sum.most?.b).toBe('D');
  });

  it('reads a two-strategy basket as one correlation, not a range', () => {
    const r = corr({
      names: ['W', 'W (2nd)', 'D'],
      pearson: [
        [1, 1, 0.28],
        [1, 1, 0.28],
        [0.28, 0.28, 1],
      ],
    });
    const text = readingLine(basket({ correlation: r, duplicates: ['W (2nd)'], list: 'BASE' }));
    expect(text).toContain('correlate +0.28');
    expect(text).not.toContain('look-alikes');
  });
});

describe('drawdownSaving', () => {
  it('is how much shallower the basket was than the sum of its parts', () => {
    expect(drawdownSaving(corr())).toBeCloseTo(40);
  });

  it('is negative when holding them together was worse', () => {
    const r = corr();
    r.basket = { ...r.basket, max_dd: -120000 };
    expect(drawdownSaving(r)).toBeCloseTo(-20);
  });

  it('is null when no part drew down', () => {
    const r = corr();
    r.basket = { ...r.basket, sum_of_part_dds: 0, dd_ratio: null };
    expect(drawdownSaving(r)).toBeNull();
  });
});

describe('readingLine', () => {
  it('calls near-zero correlations independent and gives the saving and the caveat', () => {
    const text = readingLine(basket());
    expect(text).toContain('close to independent');
    expect(text).toContain('-0.05 to +0.16');
    expect(text).toContain('40% less');
    expect(text).toContain('does not forecast');
  });

  it('warns when the picks move together', () => {
    const r = corr({
      pearson: [
        [1, 0.85, 0.7],
        [0.85, 1, 0.8],
        [0.7, 0.8, 1],
      ],
    });
    expect(readingLine(basket({ correlation: r }))).toContain('look-alikes');
  });

  it('is empty when there are no figures', () => {
    expect(readingLine(basket({ correlation: null }))).toBe('');
  });
});

describe('customNames', () => {
  it('hands the picks to the strategy picker, but not the base, whose Dir leg is not listed', () => {
    expect(customNames(basket({ picks: [pick(), pick({ name: 'S_dir_1202' })] }))).toEqual([
      'N_wide_0932',
      'S_dir_1202',
    ]);
    expect(customNames(basket({ list: 'BASE' }))).toBeNull();
  });
});
