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
  props: {} as Record<string, Record<string, unknown>>,
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
vi.mock('../../../hooks/useRotationPlan', () => ({
  useRotationPlan: () => ({ data: null, loading: false, error: null, refetch: () => undefined }),
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
  return function Stub(props: Record<string, unknown>) {
    mocks.mounted.push(name);
    mocks.props[name] = props;
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
vi.mock('../rotation/RotationHealth', () => ({ RotationHealthStrip: () => null }));
vi.mock('../rotation/RotationHero', () => ({
  RotationHero: (props: Record<string, unknown>) => {
    mocks.props.Hero = props;
    return null;
  },
}));
vi.mock('../rotation/RotationReadout', () => ({ RotationReadoutChip: stub('ReadoutChip') }));
vi.mock('../rotation/RotationVerdict', () => ({ RotationVerdict: stub('Verdict') }));

import { ROTATION_BOOK_STORAGE_KEY, useRotationBookStore } from '../../../store/rotationBook';
import { RotationPanel } from '../RotationPanel';

function show(name: string) {
  const group = screen.getByRole('radiogroup', { name: 'Book shown' });
  const radio = Array.from(group.querySelectorAll('[role="radio"]')).find(
    (r) => r.textContent === name,
  );
  if (!radio) throw new Error(name);
  fireEvent.click(radio);
}

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
  mocks.props = {};
  window.localStorage.removeItem(ROTATION_BOOK_STORAGE_KEY);
  useRotationBookStore.setState({ view: 'tuned', hydrated: true });
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

  it('opens on one Books table (Tuned first, then Classic and the Fixed base) with the verdict, then the log', () => {
    render(<RotationPanel />);
    const books = screen.getByRole('region', { name: 'Books' });
    const rows = Array.from(books.querySelectorAll('tbody tr')).map((r) => r.textContent ?? '');
    expect(rows).toHaveLength(3);
    // owner, 2026-10-30: Adaptive Tuned is the primary, so it leads and is the focus row
    expect(rows[0]).toMatch(/^Adaptive Tuned\s*focus/);
    expect(rows[1]).toMatch(/^Adaptive Classic/);
    expect(rows[2]).toMatch(/^Fixed base/);
    expect(rows[2]).toMatch(/the base/);
    for (const name of ['Steady', 'Calendar', 'Baseline']) {
      expect(books.textContent).not.toMatch(name);
    }
    expect(screen.getByTestId('Verdict')).toBeTruthy();
    expect(screen.getByTestId('ReadoutChip')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Headline' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'What happened' })).toBeTruthy();
    expect(screen.getByTestId('DailyLog')).toBeTruthy();
  });

  it('shows the per-lot-day gap against the picked benchmark', () => {
    render(<RotationPanel />);
    const books = screen.getByRole('region', { name: 'Books' });
    // Classic 10 per lot-day minus the base's 5.
    const classic = Array.from(books.querySelectorAll('tbody tr')).find((r) =>
      r.textContent?.startsWith('Adaptive Classic'),
    );
    const cells = classic?.querySelectorAll('td') ?? [];
    expect(cells[5]?.textContent).toBe('+₹5');
    expect(books.textContent).toMatch(/vs base \/ lot-day/);
  });

  it('reads both books at 1 lot, Tuned from the T1 track, each with its own stop', () => {
    render(<RotationPanel />);
    // the slippage switch is on by default, and the chip says so
    expect(screen.getByText('Forward · gross · 0.5% slippage · 1 lot per strategy')).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'Slippage' })).toBeTruthy();
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
    // the Focus picker picks among Classic's lists, so it shows in the Classic view only
    expect(screen.queryByText('Adaptive · Core (298 variants)')).toBeNull();
    show('Adaptive Classic');
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

describe('RotationPanel Show selector', () => {
  it('leads with Adaptive Tuned: the T1 chart, the T1 daily log and its stop', () => {
    render(<RotationPanel />);
    const group = screen.getByRole('radiogroup', { name: 'Book shown' });
    expect(Array.from(group.querySelectorAll('[role="radio"]')).map((r) => r.textContent)).toEqual([
      'Adaptive Tuned',
      'Adaptive Classic',
      'Fixed base',
    ]);
    expect(group.querySelector('[aria-checked="true"]')?.textContent).toBe('Adaptive Tuned');
    expect(screen.getByText('Cumulative gross, Adaptive Tuned and the fixed base')).toBeTruthy();
    const hero = mocks.props.Hero ?? {};
    expect(hero.baseOnly).toBeUndefined();
    expect((hero.nameOf as (k: string) => string)('C')).toBe('Adaptive Tuned');
    expect(mocks.props.DailyLog).toMatchObject({
      track: 't1',
      focus: 'C',
      bookName: 'Adaptive Tuned',
    });
    expect(mocks.props.DailyLog?.portfolio).toBeDefined();
  });

  it('switches to Adaptive Classic: its chart, its log without a track, and the Focus picker', () => {
    render(<RotationPanel />);
    show('Adaptive Classic');
    expect(screen.getByText('Cumulative gross, Adaptive Classic and the fixed base')).toBeTruthy();
    expect(screen.getByText('Adaptive · Core (298 variants)')).toBeTruthy();
    expect(mocks.props.DailyLog?.track).toBeUndefined();
    const rows = Array.from(
      screen.getByRole('region', { name: 'Books' }).querySelectorAll('tbody tr'),
    ).map((r) => r.textContent ?? '');
    expect(rows[0]).toMatch(/^Adaptive Classic\s*focus/);
    // the choice is kept for this browser
    expect(window.localStorage.getItem(ROTATION_BOOK_STORAGE_KEY)).toBe('{"view":"core"}');
  });

  it('switches to the Fixed base: the base line alone and no daily log, with a way back', () => {
    render(<RotationPanel />);
    show('Fixed base');
    expect(screen.getByText('Cumulative gross, Fixed base')).toBeTruthy();
    expect(mocks.props.Hero?.baseOnly).toBe(true);
    expect(screen.queryByTestId('DailyLog')).toBeNull();
    expect(screen.getByText(/The fixed base has no daily picks to log/)).toBeTruthy();
    const rows = Array.from(
      screen.getByRole('region', { name: 'Books' }).querySelectorAll('tbody tr'),
    ).map((r) => r.textContent ?? '');
    expect(rows[0]).toMatch(/^Fixed base\s*focus/);
    fireEvent.click(screen.getByRole('button', { name: 'Show Adaptive Tuned' }));
    expect(mocks.props.DailyLog).toMatchObject({ track: 't1' });
  });

  it('says the Classic-only diagnostics are Classic only outside the Classic view', () => {
    render(<RotationPanel />);
    fireEvent.click(screen.getByRole('button', { name: /^Drawdowns and selection drift/ }));
    expect(
      screen.getByText('Adaptive Classic only: these reads have no Adaptive Tuned history yet.'),
    ).toBeTruthy();
    show('Adaptive Classic');
    expect(screen.queryByText(/Adaptive Classic only/)).toBeNull();
  });
});
