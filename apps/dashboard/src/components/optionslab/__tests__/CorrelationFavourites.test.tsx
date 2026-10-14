// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CorrelationAvailable, CorrelationResponse } from '../../../types/legwise';

const mocks = vi.hoisted(() => ({
  favourites: {
    set: null as { lists: string[]; strategies: string[] } | null,
    error: null as string | null,
    toggleList: vi.fn(),
    toggleStrategy: vi.fn(),
  },
  available: null as unknown,
  response: null as unknown,
  correlationCalls: [] as unknown[][],
}));

vi.mock('../../../hooks/useFavourites', () => ({
  useFavourites: () => ({
    set: mocks.favourites.set,
    loading: mocks.favourites.set === null,
    error: mocks.favourites.error,
    warning: null,
    isDefault: false,
    isListStarred: () => false,
    isStrategyStarred: () => false,
    toggleList: mocks.favourites.toggleList,
    toggleStrategy: mocks.favourites.toggleStrategy,
    refetch: () => undefined,
  }),
}));
vi.mock('../../../hooks/useRotationBasket', () => ({
  useRotationBasket: () => ({ data: null, loading: false, error: null, refetch: () => undefined }),
}));
vi.mock('../../../hooks/useLegwise', () => ({
  useCorrelationAvailable: () => ({
    data: mocks.available,
    loading: false,
    error: null,
    refetch: () => undefined,
  }),
  useCorrelation: (...args: unknown[]) => {
    mocks.correlationCalls.push(args);
    return { data: mocks.response, loading: false, error: null, refetch: () => undefined };
  },
  useCorrelationPick: () => ({ data: null, loading: true, error: null, refetch: () => undefined }),
}));

import { CorrelationPanel } from '../CorrelationPanel';

function available(): CorrelationAvailable {
  return {
    strategies: [
      {
        name: 'nifty_buy_range_breakout',
        kind: 'legwise',
        index: null,
        family: null,
        slot: null,
        first: '2026-09-23',
        last: '2026-10-14',
        n_days: 15,
        stale: false,
      },
      {
        name: 'N_wide_0917',
        kind: 'variant',
        index: 'N',
        family: 'wide',
        slot: '0917',
        first: '2025-01-01',
        last: '2026-10-14',
        n_days: 400,
        stale: false,
      },
      {
        name: 'N_dir_0917',
        kind: 'variant',
        index: 'N',
        family: 'dir',
        slot: '0917',
        first: '2025-01-01',
        last: '2026-10-14',
        n_days: 400,
        stale: false,
      },
      {
        name: 'N_buy_0917',
        kind: 'variant',
        index: 'N',
        family: 'buy',
        slot: '0917',
        first: '2025-01-01',
        last: '2026-10-14',
        n_days: 400,
        stale: false,
      },
    ],
    lists: [
      { key: 'A', selector: 'list:A', name: 'Steady' },
      { key: 'B', selector: 'list:B', name: 'Calendar' },
      { key: 'C', selector: 'list:C', name: 'Adaptive' },
    ],
    groups: { slot: {}, family: {}, index: {}, kind: {} },
    max_strategies: 80,
    default_selectors: ['slot:0917'],
  } as unknown as CorrelationAvailable;
}

function response(names: string[], reconstructed: Record<string, number>): CorrelationResponse {
  const n = names.length;
  const m = names.map((_, i) => names.map((__, j) => (i === j ? 1 : 0.2)));
  const stats = { net: 1, max_dd: -1, worst_day: -1, loss_day_share: 0.4, mean_over_std: 0.1 };
  return {
    names,
    kinds: names.map(() => 'variant'),
    days: ['2026-01-01', '2026-10-01'],
    n_days: 60,
    window: 63,
    order: names.map((_, i) => i),
    pearson: m,
    spearman: m,
    loss_overlap: m,
    loss_corr: m,
    both_lose_days: names.map(() => names.map(() => 5)),
    parts: Object.fromEntries(names.map((x) => [x, stats])),
    basket: {
      names,
      net: n,
      max_dd: -1,
      worst_day: -1,
      loss_day_share: 0.3,
      sum_of_part_dds: -2,
      dd_ratio: 0.5,
      mean_over_std: 0.1,
    },
    rolling: [],
    selectors: names,
    from: null,
    to: null,
    stale: [],
    reconstructed,
    in_sample: true,
  } as unknown as CorrelationResponse;
}

beforeEach(() => {
  mocks.favourites.set = { lists: ['A', 'C'], strategies: ['nifty_buy_range_breakout'] };
  mocks.favourites.error = null;
  mocks.favourites.toggleList.mockClear();
  mocks.favourites.toggleStrategy.mockClear();
  mocks.available = available();
  mocks.response = response(['list:A', 'list:C', 'nifty_buy_range_breakout'], { 'list:A': 30 });
  mocks.correlationCalls.length = 0;
  window.history.replaceState(null, '', '/optionslab/correlation');
});
afterEach(cleanup);

const lastCall = () => mocks.correlationCalls[mocks.correlationCalls.length - 1] ?? [];

describe('Correlation opens on the favourites', () => {
  it('asks for the starred lists then the starred strategies', () => {
    render(<CorrelationPanel />);
    expect(lastCall()[0]).toBe('list:A,list:C,nifty_buy_range_breakout');
    expect(lastCall()[3]).toBe(true);
  });

  it('holds its request until the favourites have loaded', () => {
    mocks.favourites.set = null;
    render(<CorrelationPanel />);
    expect(lastCall()[3]).toBe(false);
  });

  it('falls back to the built-in three when nothing is starred', () => {
    mocks.favourites.set = { lists: [], strategies: [] };
    render(<CorrelationPanel />);
    expect(lastCall()[0]).toBe('N_wide_0917,N_dir_0917,N_buy_0917');
  });

  it('falls back to the built-in three, rather than waiting, when favourites cannot load', () => {
    mocks.favourites.set = null;
    mocks.favourites.error = 'HTTP 500';
    render(<CorrelationPanel />);
    expect(lastCall()[0]).toBe('N_wide_0917,N_dir_0917,N_buy_0917');
    expect(lastCall()[3]).toBe(true);
  });

  it('drops a starred strategy that no longer exists', () => {
    mocks.favourites.set = { lists: ['B'], strategies: ['deleted_strategy'] };
    render(<CorrelationPanel />);
    expect(lastCall()[0]).toBe('list:B');
  });

  it('lets ?names= in the address win over the favourites', () => {
    window.history.replaceState(null, '', '/optionslab/correlation?names=N_wide_0917,list:B');
    render(<CorrelationPanel />);
    expect(lastCall()[0]).toBe('N_wide_0917,list:B');
  });
});

describe('Correlation shows lists by name', () => {
  it('names the lists in the picker and the chips, and says what was re-scored', () => {
    render(<CorrelationPanel />);
    expect(screen.getByRole('checkbox', { name: 'Steady' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Calendar' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Steady ×$/ })).toBeTruthy();
    expect(screen.getByText(/Steady: 30 of 60 compared days were re-scored/)).toBeTruthy();
    // The raw selector never reaches the reader.
    expect(screen.queryByText('list:A')).toBeNull();
  });

  it('sends a star click to the favourites, as a list or as a strategy', () => {
    render(<CorrelationPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Star Calendar' }));
    expect(mocks.favourites.toggleList).toHaveBeenCalledWith('B');
    fireEvent.click(screen.getByRole('button', { name: 'Star N_wide_0917' }));
    expect(mocks.favourites.toggleStrategy).toHaveBeenCalledWith('N_wide_0917');
  });

  it('resets the picks to the favourites', () => {
    window.history.replaceState(null, '', '/optionslab/correlation?names=N_wide_0917');
    render(<CorrelationPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset to favourites' }));
    expect(new URLSearchParams(window.location.search).get('names')).toBeNull();
  });
});
