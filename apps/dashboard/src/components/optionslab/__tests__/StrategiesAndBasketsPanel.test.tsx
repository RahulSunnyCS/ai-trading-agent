// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  strategies: [] as unknown[],
  starred: { lists: ['A'] as string[], strategies: ['nifty_buy_range_breakout'] as string[] },
  loaded: true,
  toggleList: vi.fn(),
  toggleStrategy: vi.fn(),
  summary: null as unknown,
}));

vi.mock('../../../hooks/useFavourites', () => ({
  useFavourites: () => ({
    set: mocks.loaded ? mocks.starred : null,
    loading: !mocks.loaded,
    error: null,
    warning: null,
    isDefault: false,
    isListStarred: (k: string) => mocks.starred.lists.includes(k),
    isStrategyStarred: (n: string) => mocks.starred.strategies.includes(n),
    toggleList: mocks.toggleList,
    toggleStrategy: mocks.toggleStrategy,
    refetch: () => undefined,
  }),
}));
vi.mock('../../../hooks/useLegwise', () => ({
  useLegwiseStrategies: () => ({
    data: mocks.strategies,
    loading: false,
    error: null,
    refetch: () => undefined,
  }),
  useLegwiseResults: () => ({
    data: { results: [] },
    loading: false,
    error: null,
    refetch: () => undefined,
  }),
}));
vi.mock('../../../hooks/useRotation', () => ({
  useRotationOverview: () => ({
    data: null,
    loading: false,
    error: null,
    refetch: () => undefined,
  }),
  useRotationSummary: () => ({
    data: mocks.summary,
    loading: false,
    error: null,
    refetch: () => undefined,
  }),
}));

import { StrategiesAndBasketsPanel } from '../StrategiesAndBasketsPanel';

function strategy(name: string, sha = 'abcdef1234') {
  return {
    name,
    sha,
    strategy: {
      id: name,
      underlying: 'NIFTY',
      entry_time: '09:17',
      exit_time: '15:28',
      square_off: 'partial',
      legs: [
        {
          id: 'ce',
          lots: 1,
          position: 'sell',
          option_type: 'CE',
          expiry: 'weekly',
          strike: { strike_type: 'OTM1' },
        },
        {
          id: 'pe',
          lots: 1,
          position: 'sell',
          option_type: 'PE',
          expiry: 'weekly',
          strike: { strike_type: 'OTM1' },
        },
      ],
      overall: {},
      execution: { slippage_pct: 0, cost_per_order_inr: 0 },
    },
  };
}

beforeEach(() => {
  mocks.strategies = [
    strategy('nifty_buy_range_breakout'),
    strategy('nifty_widesl_917_otm1'),
    strategy('sensex_widesl_917_otm2'),
  ];
  mocks.starred = { lists: ['A'], strategies: ['nifty_buy_range_breakout'] };
  mocks.loaded = true;
  mocks.toggleList.mockClear();
  mocks.toggleStrategy.mockClear();
  mocks.summary = {
    first_day: '2026-10-12',
    lists: {
      A: { total: 25025, max_drawdown: 0 },
      B: { total: -1200, max_drawdown: -3400 },
    },
  };
  window.history.replaceState(null, '', '/optionslab/strategies');
});
afterEach(cleanup);

describe('StrategiesAndBasketsPanel', () => {
  it('lists the three baskets by name with their forward figures', () => {
    render(<StrategiesAndBasketsPanel />);
    for (const name of ['Steady', 'Calendar', 'Adaptive']) {
      expect(screen.getByRole('heading', { name })).toBeTruthy();
    }
    // A list with no scored days yet shows a dash, never a zero.
    const adaptive = screen.getByRole('region', { name: 'Adaptive basket' });
    expect(within(adaptive).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('shows every strategy with its star state', () => {
    render(<StrategiesAndBasketsPanel />);
    expect(
      screen.getByRole('button', { name: 'Remove the star from nifty_buy_range_breakout' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Star nifty_widesl_917_otm1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Star sensex_widesl_917_otm2' })).toBeTruthy();
  });

  it('stars a strategy and a basket through the favourites', () => {
    render(<StrategiesAndBasketsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Star nifty_widesl_917_otm1' }));
    expect(mocks.toggleStrategy).toHaveBeenCalledWith('nifty_widesl_917_otm1');
    fireEvent.click(screen.getByRole('button', { name: 'Star Calendar' }));
    expect(mocks.toggleList).toHaveBeenCalledWith('B');
  });

  it('narrows to the starred ones, baskets and strategies alike', () => {
    render(<StrategiesAndBasketsPanel />);
    fireEvent.click(screen.getByRole('radio', { name: 'Starred only' }));
    expect(screen.getByRole('heading', { name: 'Steady' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Calendar' })).toBeNull();
    expect(screen.getByText('nifty_buy_range_breakout')).toBeTruthy();
    expect(screen.queryByText('nifty_widesl_917_otm1')).toBeNull();
  });

  it('says so when nothing is starred', () => {
    mocks.starred = { lists: [], strategies: [] };
    render(<StrategiesAndBasketsPanel />);
    fireEvent.click(screen.getByRole('radio', { name: 'Starred only' }));
    expect(screen.getByText('No basket is starred')).toBeTruthy();
    expect(screen.getByText('No strategy is starred')).toBeTruthy();
  });

  it('opens Correlation with the item and the other starred ones', () => {
    render(<StrategiesAndBasketsPanel />);
    const row = screen.getByText('nifty_widesl_917_otm1').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: 'Correlate' }));
    expect(window.location.pathname).toBe('/optionslab/correlation');
    expect(new URLSearchParams(window.location.search).get('names')).toBe(
      'nifty_widesl_917_otm1,list:A,nifty_buy_range_breakout',
    );
  });

  it('opens a strategy in the builder and its results in Runs', () => {
    render(<StrategiesAndBasketsPanel />);
    const row = screen.getByText('nifty_widesl_917_otm1').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Open in builder/ }));
    expect(window.location.pathname).toBe('/optionslab/builder');
    expect(new URLSearchParams(window.location.search).get('load')).toBe('nifty_widesl_917_otm1');
  });

  it('cannot star or correlate until the stars have loaded', () => {
    mocks.loaded = false;
    render(<StrategiesAndBasketsPanel />);
    const row = screen.getByText('nifty_widesl_917_otm1').closest('tr') as HTMLElement;
    expect(within(row).getByRole('button', { name: 'Correlate' })).toHaveProperty('disabled', true);
  });
});
