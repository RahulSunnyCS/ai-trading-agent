// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  overview: null as unknown,
  summary: null as unknown,
  mounted: [] as string[],
  summaryArgs: [] as unknown[],
  portfolioArgs: [] as unknown[],
  stopKeys: [] as unknown[],
}));

vi.mock('../../../hooks/useRotation', () => ({
  ROTATION_PAGE_LOTS: 1,
  useRotationOverview: () => ({
    data: mocks.overview,
    loading: false,
    error: null,
    refetch: () => undefined,
  }),
  useRotationSummary: (opts: unknown) => {
    mocks.summaryArgs.push(opts);
    return {
      data: mocks.summary,
      loading: false,
      error: null,
      refetch: () => undefined,
    };
  },
}));
vi.mock('../../../hooks/useRotationPortfolio', () => ({
  useRotationPortfolioDays: (...args: unknown[]) => {
    mocks.portfolioArgs.push(args[3]);
    return { data: null, loading: false, error: null, refetch: () => undefined };
  },
}));
vi.mock('../../../hooks/usePortfolioStop', () => ({
  usePortfolioStop: (keys: unknown) => {
    mocks.stopKeys.push(keys);
    return [{ stop: '', mode: 'none', a: '', b: '', x: '', y: '' }, () => undefined];
  },
}));

// Each widget is replaced by a stub that records that it mounted, so the test can say which
// ones the page loads at once and which wait to be opened.
function stub(name: string) {
  return function Stub() {
    mocks.mounted.push(name);
    return <div data-testid={name}>{name}</div>;
  };
}
vi.mock('../RotationDailyLog', () => ({ RotationDailyLog: stub('DailyLog') }));
vi.mock('../RotationDrawdowns', () => ({ RotationDrawdowns: stub('Drawdowns') }));
vi.mock('../RotationDrift', () => ({ RotationDrift: stub('Drift') }));
vi.mock('../RotationExplain', () => ({ RotationExplain: stub('Explain') }));
vi.mock('../RotationPulse', () => ({ RotationPulse: stub('Pulse') }));
vi.mock('../RotationRegime', () => ({ RotationRegime: stub('Regime') }));
vi.mock('../RotationShadowScoreboard', () => ({ RotationShadowScoreboard: stub('Shadow') }));
vi.mock('../results/EveningRunBar', () => ({ EveningRunBar: stub('EveningRun') }));
vi.mock('../PortfolioStopButton', () => ({ PortfolioStopButton: () => null }));
vi.mock('../rotation/RotationBaskets', () => ({ RotationBaskets: () => null }));
vi.mock('../rotation/RotationHeadline', () => ({ RotationHeadline: () => null }));
vi.mock('../rotation/RotationHealth', () => ({ RotationHealthStrip: () => null }));
vi.mock('../rotation/RotationHero', () => ({ RotationHero: () => null }));
vi.mock('../rotation/RotationReadout', () => ({ RotationReadoutBanner: () => null }));
vi.mock('../rotation/RotationVerdict', () => ({ RotationVerdict: () => null }));

import { RotationPanel } from '../RotationPanel';

const stats = {
  total: 100,
  max_drawdown: 0,
  per_lot_day: 10,
  max_drawdown_per_lot: 0,
  lots_per_day: 6,
  beats_random_pct: 50,
  vs_base: { mean: 1, lower: 0, upper: 2, drawdown_no_worse: true, beats_base: false },
  vs_ref: null,
  random: { p10: 0, p50: 0, p90: 0, max: 0 },
  mean_daily_random_percentile: 0.5,
  random_path: { p10: [], p50: [], p90: [] },
  mean_day: 10,
};

beforeEach(() => {
  mocks.mounted = [];
  mocks.summaryArgs = [];
  mocks.portfolioArgs = [];
  mocks.stopKeys = [];
  mocks.overview = {
    health: { as_of: '2026-10-14T20:00:00+05:30', checks: [] },
    readout_days: 60,
    first_entry_day: '2026-10-12',
    baskets: { entry: null, lists: {}, changed: {} },
    lists: {},
  };
  mocks.summary = {
    n_days: 3,
    first_day: '2026-10-12',
    last_day: '2026-10-14',
    lists: { A: stats, B: stats, C: stats, REF: stats },
    base: {
      per_lot_day: 5,
      cumulative_per_lot: 15,
      max_drawdown_per_lot: 0,
      lots_per_day: 6,
      total: 90,
      max_drawdown: 0,
      definition: '',
    },
    days: [],
    late_entries: [],
    pending_reasons: {},
    pending_days: [],
    settings: {},
  };
  window.history.replaceState(null, '', '/optionslab/rotation');
});
afterEach(cleanup);

describe('RotationPanel as one page', () => {
  it('has no Overview / Journal / Research switch', () => {
    render(<RotationPanel />);
    expect(screen.queryByRole('radio', { name: 'Overview' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Journal' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Research' })).toBeNull();
  });

  it('carries the evening run (its status and Run button) at the top', () => {
    render(<RotationPanel />);
    expect(screen.getByTestId('EveningRun')).toBeTruthy();
  });

  it('opens on the Adaptive Classic, Adaptive Tuned and Fixed base cards, then the log', () => {
    render(<RotationPanel />);
    expect(screen.getByRole('region', { name: 'Adaptive Classic list' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Adaptive Tuned list' })).toBeTruthy();
    const base = screen.getByRole('region', { name: 'Fixed base list' });
    expect(base.textContent).not.toMatch(/Against the fixed base/);
    for (const name of ['Steady', 'Calendar', 'Baseline']) {
      expect(screen.queryByRole('region', { name: `${name} list` })).toBeNull();
    }
    expect(screen.getByRole('heading', { name: 'What happened' })).toBeTruthy();
    expect(screen.getByTestId('DailyLog')).toBeTruthy();
  });

  it('reads both books at 1 lot, Tuned from the T1 track, each with its own stop', () => {
    render(<RotationPanel />);
    expect(screen.getByText('Forward · gross · 1 lot per strategy')).toBeTruthy();
    expect(mocks.summaryArgs).toContainEqual({ lots: 1 });
    expect(mocks.summaryArgs).toContainEqual({ lots: 1, track: 't1' });
    expect(mocks.portfolioArgs).toContainEqual({ lots: 1 });
    expect(mocks.portfolioArgs).toContainEqual({ lots: 1, track: 't1' });
    // Classic on the default keys, Tuned on its own
    expect(mocks.stopKeys).toContain(undefined);
    expect(mocks.stopKeys).toContainEqual(
      expect.objectContaining({ stopParam: 'pfstop_t1', trailParam: 'pftrail_t1' }),
    );
    // the Fixed base: its own book at 1 lot and its own stop keys
    expect(mocks.portfolioArgs).toContainEqual({ lots: 1, book: 'base' });
    expect(mocks.stopKeys).toContainEqual(
      expect.objectContaining({ stopParam: 'pfstop_base', trailParam: 'pftrail_base' }),
    );
  });

  it('names the list and its universe instead of a one-option focus control', () => {
    render(<RotationPanel />);
    expect(screen.queryByRole('radiogroup', { name: 'Focus list' })).toBeNull();
    expect(screen.getByText('Adaptive · Core (298 variants)')).toBeTruthy();
    // the comparison picker offers the fixed base and random baskets, not Baseline
    const bench = screen.getByRole('radiogroup', { name: 'Benchmark' });
    expect(Array.from(bench.querySelectorAll('[role="radio"]')).map((r) => r.textContent)).toEqual([
      'Fixed base',
      'Random median',
    ]);
  });

  it('keeps the diagnostics closed, and loads each only when it is opened', () => {
    render(<RotationPanel />);
    expect(screen.getByRole('heading', { name: 'Is the rule still working?' })).toBeTruthy();
    for (const name of ['Pulse', 'Explain', 'Regime', 'Shadow', 'Drawdowns', 'Drift']) {
      expect(screen.queryByTestId(name), name).toBeNull();
      expect(mocks.mounted).not.toContain(name);
    }
    fireEvent.click(screen.getByRole('button', { name: /^Why these picks/ }));
    expect(screen.getByTestId('Pulse')).toBeTruthy();
    expect(screen.getByTestId('Explain')).toBeTruthy();
    expect(screen.queryByTestId('Regime')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Ideas being watched/ }));
    expect(screen.getByTestId('Shadow')).toBeTruthy();
  });

  it('shows the log and the bands even before a forward day has been scored', () => {
    mocks.summary = { ...(mocks.summary as object), n_days: 0 };
    render(<RotationPanel />);
    expect(screen.getByTestId('DailyLog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Is the rule still working?' })).toBeTruthy();
  });

  it('loads the day log and the bands without waiting for the read-out', () => {
    mocks.summary = null; // still loading
    render(<RotationPanel />);
    expect(screen.getByTestId('DailyLog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'What happened' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Experiments' })).toBeTruthy();
  });

  it('ignores the old ?rotationView= address', () => {
    window.history.replaceState(null, '', '/optionslab/rotation?rotationView=research');
    render(<RotationPanel />);
    expect(screen.getByTestId('DailyLog')).toBeTruthy();
    expect(screen.queryByTestId('Pulse')).toBeNull();
  });
});
