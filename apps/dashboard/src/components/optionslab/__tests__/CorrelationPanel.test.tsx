// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CorrelationResponse } from '../../../types/legwise';
import type { BasketPick, RotationBasketResponse } from '../../../types/rotationBasket';

const state = vi.hoisted(() => ({
  basket: null as unknown,
  idle: { data: null, loading: true, error: null, refetch: () => undefined },
}));

vi.mock('../../../hooks/useRotationBasket', () => ({
  useRotationBasket: () => ({
    data: state.basket,
    loading: false,
    error: null,
    refetch: () => undefined,
  }),
}));
vi.mock('../../../hooks/useLegwise', () => ({
  useCorrelationAvailable: () => state.idle,
  useCorrelation: () => state.idle,
  useCorrelationPick: () => state.idle,
}));

import { CorrelationPanel } from '../CorrelationPanel';

function pick(name: string, start: string): BasketPick {
  return {
    name,
    index: 'NIFTY',
    family: 'wide',
    kind: 'wide',
    start,
    band: 'A',
    role: 'core',
    lots: 2,
    composite: 0.8,
    has_results: true,
    first: '2024-10-09',
    last: '2026-10-09',
    n_days: 487,
  };
}

function basket(): RotationBasketResponse {
  const p = [
    [1, 0.1],
    [0.1, 1],
  ];
  const stats = { net: 1, max_dd: -1, worst_day: -1, loss_day_share: 0.4, mean_over_std: 0.1 };
  const correlation: CorrelationResponse = {
    names: ['N_wide_0932', 'S_dir_1202'],
    kinds: ['variant', 'variant'],
    days: ['2025-12-03', '2026-10-08'],
    n_days: 203,
    window: 63,
    order: [0, 1],
    pearson: p,
    spearman: p,
    loss_overlap: p,
    loss_corr: p,
    both_lose_days: [
      [80, 20],
      [20, 70],
    ],
    parts: { N_wide_0932: stats, S_dir_1202: stats },
    basket: {
      names: ['N_wide_0932', 'S_dir_1202'],
      net: 2,
      max_dd: -1,
      worst_day: -1,
      loss_day_share: 0.3,
      sum_of_part_dds: -2,
      dd_ratio: 0.5,
      mean_over_std: 0.1,
    },
    rolling: [],
    selectors: [],
    from: '2025-12-03',
    to: '2026-10-08',
    stale: [],
    in_sample: true,
  };
  return {
    list: 'A',
    label: 'List A',
    day: '2026-10-12',
    weekday: 'Mon',
    source: 'recorded',
    late: false,
    overridden: false,
    picks: [pick('N_wide_0932', '09:32'), pick('S_dir_1202', '12:02')],
    omitted: [],
    duplicates: [],
    lots: 4,
    windows: {
      P1: { id: 'P1', label: 'P1', from: '2025-12-03', to: '2026-10-08', n_days: 203 },
      P2: { id: 'P2', label: 'P2', from: '2025-01-10', to: '2025-08-29', n_days: 158 },
      last63: { id: 'last63', label: 'Last 63', from: null, to: null, n_days: 63 },
      forward: { id: 'forward', label: 'Forward', from: null, to: null, n_days: 0 },
    },
    window: { id: 'P1', label: 'P1', from: '2025-12-03', to: '2026-10-08' },
    correlation,
    reason: null,
    n_days: 203,
    enough: true,
    thin_days: 20,
    all_lose_days: 11,
    any_lose_days: 120,
    forward_days: 0,
    basis: 'gross',
    in_sample: true,
    notes: [],
  };
}

beforeEach(() => {
  state.basket = basket();
  window.history.replaceState(null, '', '/optionslab/correlation');
});
afterEach(cleanup);

describe('CorrelationPanel mode switch', () => {
  it('starts on the strategy picker and goes to the basket through ?mode=basket', () => {
    render(<CorrelationPanel />);
    expect(screen.queryByText('List A · Mon 12 Oct 2026')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: 'A day’s basket' }));
    expect(new URLSearchParams(window.location.search).get('mode')).toBe('basket');
    expect(screen.getByText(/List A/)).toBeTruthy();
  });

  it('opens the basket in the picker with only those names, any slot, and the window dates', () => {
    window.history.replaceState(null, '', '/optionslab/correlation?mode=basket');
    render(<CorrelationPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Open as custom' }));
    const q = new URLSearchParams(window.location.search);
    expect(q.get('mode')).toBeNull();
    expect(q.get('names')).toBe('N_wide_0932,S_dir_1202');
    // slot must be "any": the default 09:17 slot would AND with the names' group and select none
    expect(q.get('slot')).toBe('any');
    expect(q.get('family')).toBeNull();
    expect(q.get('from')).toBe('2025-12-03');
    expect(q.get('to')).toBe('2026-10-08');
  });
});
