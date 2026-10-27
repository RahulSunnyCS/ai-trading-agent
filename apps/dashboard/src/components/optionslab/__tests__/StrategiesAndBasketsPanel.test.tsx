// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  strategies: [] as unknown[],
  results: [] as unknown[],
  starred: { lists: ['C'] as string[], strategies: ['nifty_buy_range_breakout'] as string[] },
  loaded: true,
  toggleList: vi.fn(),
  toggleStrategy: vi.fn(),
  summary: null as unknown,
  summaryError: null as string | null,
  summaryOptions: [] as unknown[],
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
    data: { results: mocks.results },
    loading: false,
    error: null,
    refetch: () => undefined,
  }),
}));
vi.mock('../../../hooks/useRotation', () => ({
  ROTATION_PAGE_LOTS: 1,
  useRotationOverview: () => ({
    data: null,
    loading: false,
    error: null,
    refetch: () => undefined,
  }),
  useRotationSummary: (opts: unknown) => {
    mocks.summaryOptions.push(opts);
    return {
      data: mocks.summary,
      loading: false,
      error: mocks.summaryError,
      refetch: () => undefined,
    };
  },
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

const result = (id: string) => ({
  run_id: `daily:${id}`,
  strategy_id: id,
  strategy_sha: 'abcdef1234',
  day: '2026-10-14',
  gross: 120,
  costs: 20,
  net: 100,
  worst_mtm: -50,
  best_mtm: 150,
  stopped_by: '',
  notes: [],
  trades: [],
  current: true,
});

beforeEach(() => {
  mocks.results = [
    result('nifty_buy_range_breakout'),
    result('nifty_widesl_917_otm1'),
    result('sensex_widesl_917_otm2'),
  ];
  mocks.strategies = [
    strategy('nifty_buy_range_breakout'),
    strategy('nifty_widesl_917_otm1'),
    strategy('sensex_widesl_917_otm2'),
  ];
  mocks.starred = { lists: ['C'], strategies: ['nifty_buy_range_breakout'] };
  mocks.loaded = true;
  mocks.summaryError = null;
  mocks.toggleList.mockClear();
  mocks.toggleStrategy.mockClear();
  mocks.summaryOptions = [];
  mocks.summary = {
    n_days: 10,
    first_day: '2026-10-12',
    lists: {
      A: { total: -1200, max_drawdown: -3400 },
      C: { total: 25025, max_drawdown: -8382 },
    },
  };
  window.history.replaceState(null, '', '/optionslab/strategies');
});
afterEach(cleanup);

describe('StrategiesAndBasketsPanel', () => {
  it('lists the Adaptive basket alone, with its forward figures and its universe', () => {
    render(<StrategiesAndBasketsPanel />);
    const adaptive = screen.getByRole('region', { name: 'Adaptive basket' });
    expect(within(adaptive).getByText('+₹25,025')).toBeTruthy();
    expect(within(adaptive).getByText(/forward days since 12 Oct 2026/)).toBeTruthy();
    expect(within(adaptive).getByText('10')).toBeTruthy();
    expect(within(adaptive).getByText('-₹8,382')).toBeTruthy();
    expect(within(adaptive).getByRole('button', { name: /Open in Today/ })).toBeTruthy();
    for (const name of ['Steady', 'Calendar', 'Baseline']) {
      expect(screen.queryByRole('heading', { name })).toBeNull();
    }
    expect(screen.queryByText(/Steady|Calendar|Baseline/)).toBeNull();
    // Steady's figures are in the read-out, never on the page
    expect(screen.queryByText('-₹1,200')).toBeNull();
    expect(screen.getByText(/ranked over Core \(298 variants\)/)).toBeTruthy();
    // the fixed base stays as the comparator
    expect(screen.getByRole('button', { name: 'Star Fixed base' })).toBeTruthy();
  });

  it('shows a dash, never a zero, for a list with no scored days yet', () => {
    mocks.summary = { n_days: 0, first_day: null, lists: {} };
    render(<StrategiesAndBasketsPanel />);
    const adaptive = screen.getByRole('region', { name: 'Adaptive basket' });
    expect(within(adaptive).getByText('— no forward day scored yet')).toBeTruthy();
  });

  it('reads the forward figures the Today page reads, at its lots', () => {
    // It used to ask the registered read-out (two lots, another cache key), so it sat on a cold
    // build showing "Forward days —" while Today had ten scored days.
    render(<StrategiesAndBasketsPanel />);
    expect(mocks.summaryOptions[0]).toEqual({ lots: 1 });
  });

  it('says it is loading instead of showing a bare dash', () => {
    mocks.summary = null;
    render(<StrategiesAndBasketsPanel />);
    const adaptive = screen.getByRole('region', { name: 'Adaptive basket' });
    expect(within(adaptive).getByText('Reading the forward figures…')).toBeTruthy();
    expect(within(adaptive).queryByText('—')).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Remove the star from Adaptive' }));
    expect(mocks.toggleList).toHaveBeenCalledWith('C');
  });

  it('narrows to the starred ones, baskets and strategies alike', () => {
    render(<StrategiesAndBasketsPanel />);
    fireEvent.click(screen.getByRole('radio', { name: 'Starred only' }));
    expect(screen.getByRole('heading', { name: 'Adaptive' })).toBeTruthy();
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
      'nifty_widesl_917_otm1,list:C,nifty_buy_range_breakout',
    );
  });

  it('opens a strategy in the builder', () => {
    render(<StrategiesAndBasketsPanel />);
    const row = screen.getByText('nifty_widesl_917_otm1').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /Open in builder/ }));
    expect(window.location.pathname).toBe('/optionslab/builder');
    expect(new URLSearchParams(window.location.search).get('load')).toBe('nifty_widesl_917_otm1');
  });

  it("opens a strategy's saved days in its History drawer, in the address", () => {
    render(<StrategiesAndBasketsPanel />);
    const row = screen.getByText('nifty_widesl_917_otm1').closest('tr') as HTMLElement;
    fireEvent.click(within(row).getByRole('button', { name: /History/ }));
    expect(window.location.pathname).toBe('/optionslab/strategies');
    expect(new URLSearchParams(window.location.search).get('strategy')).toBe(
      'nifty_widesl_917_otm1',
    );
    const drawer = screen.getByRole('dialog');
    expect(within(drawer).getByText('nifty_widesl_917_otm1 · History')).toBeTruthy();
    expect(within(drawer).getByText('14 Oct 2026 ▸')).toBeTruthy();
  });

  it('opens the History drawer from an old Runs link', () => {
    window.history.replaceState(null, '', '/optionslab/strategies?strategy=sensex_widesl_917_otm2');
    render(<StrategiesAndBasketsPanel />);
    expect(
      within(screen.getByRole('dialog')).getByText('sensex_widesl_917_otm2 · History'),
    ).toBeTruthy();
  });

  it('cannot star or correlate until the stars have loaded', () => {
    mocks.loaded = false;
    render(<StrategiesAndBasketsPanel />);
    const row = screen.getByText('nifty_widesl_917_otm1').closest('tr') as HTMLElement;
    expect(within(row).getByRole('button', { name: 'Correlate' })).toHaveProperty('disabled', true);
  });

  it('stars and correlates by strategy id, which is what Correlation names its series', () => {
    mocks.strategies = [
      {
        ...strategy('file_name_one'),
        strategy: { ...strategy('x').strategy, id: 'the_strategy_id' },
      },
    ];
    mocks.results = [result('the_strategy_id')];
    mocks.starred = { lists: [], strategies: ['the_strategy_id'] };
    render(<StrategiesAndBasketsPanel />);
    const row = screen.getByText('file_name_one').closest('tr') as HTMLElement;
    // Starred because its id is, even though its file name is not in the set.
    expect(
      within(row).getByRole('button', { name: 'Remove the star from file_name_one' }),
    ).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Correlate' }));
    expect(new URLSearchParams(window.location.search).get('names')).toBe('the_strategy_id,list:C');
    fireEvent.click(within(row).getByRole('button', { name: /Remove the star from/ }));
    expect(mocks.toggleStrategy).toHaveBeenCalledWith('the_strategy_id');
  });

  it('does not offer Correlate for a strategy with no result for its current version', () => {
    mocks.results = [];
    render(<StrategiesAndBasketsPanel />);
    const row = screen.getByText('nifty_widesl_917_otm1').closest('tr') as HTMLElement;
    expect(within(row).getByRole('button', { name: 'Correlate' })).toHaveProperty('disabled', true);
  });

  it('waits for the stars instead of saying nothing is starred', () => {
    mocks.loaded = false;
    render(<StrategiesAndBasketsPanel />);
    fireEvent.click(screen.getByRole('radio', { name: 'Starred only' }));
    expect(screen.queryByText('No basket is starred')).toBeNull();
    expect(screen.queryByText('No strategy is starred')).toBeNull();
    // And nothing can be starred or correlated before they are there.
    fireEvent.click(screen.getByRole('radio', { name: 'All' }));
    const adaptive = screen.getByRole('region', { name: 'Adaptive basket' });
    expect(
      within(adaptive).getByRole('button', { name: 'Remove the star from Adaptive' }),
    ).toHaveProperty('disabled', true);
    expect(within(adaptive).getByRole('button', { name: 'Correlate' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('says when the forward figures could not be read, rather than showing dashes quietly', () => {
    mocks.summary = null;
    mocks.summaryError = 'HTTP 500';
    render(<StrategiesAndBasketsPanel />);
    expect(screen.getByText(/The forward figures could not be read \(HTTP 500\)/)).toBeTruthy();
  });

  it('still says a refresh failed when the last figures are kept', () => {
    mocks.summaryError = 'HTTP 500';
    render(<StrategiesAndBasketsPanel />);
    expect(screen.getByText(/could not be refreshed \(HTTP 500\)/)).toBeTruthy();
    expect(screen.getByText('+₹25,025')).toBeTruthy();
  });
});
