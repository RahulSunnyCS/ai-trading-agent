// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PulseAvailable, PulseCell, PulseStat } from '../../../types/rotationPulse';

const hook = vi.hoisted(() => ({
  state: { data: null, loading: false, error: null, refetch: vi.fn() } as {
    data: unknown;
    loading: boolean;
    error: string | null;
    refetch: () => void;
  },
  lastArgs: [] as unknown[],
  navigate: vi.fn(),
}));

vi.mock('../../../hooks/useRotationPulse', () => ({
  useRotationPulse: (...args: unknown[]) => {
    hook.lastArgs = args;
    return hook.state;
  },
}));
vi.mock('../../../hooks/useQueryState', () => ({
  navigateToLink: (link: string) => hook.navigate(link),
}));

import { RotationPulse } from '../RotationPulse';

const stat = (avg: number | null, over: Partial<PulseStat> = {}): PulseStat =>
  avg === null
    ? {
        st: 'missing',
        avg: null,
        n: 0,
        nv: 0,
        variants: 0,
        reason: 'no stored result in this window',
      }
    : { st: 'ok', avg, n: 21, nv: 336, variants: 16, forward: 0, ...over };

function cell(over: Partial<PulseCell> = {}): PulseCell {
  return {
    key: 'dir_A',
    kind: 'dir',
    band: 'A',
    label: 'Dir 09:17-10:02',
    kind_label: 'Dir',
    band_label: '09:17-10:02',
    slots: ['0917', '1002'],
    variants: 16,
    st: 'ok',
    windows: { '5': stat(1031), '21': stat(676), '63': stat(322, { n: 63 }) },
    p1: stat(312, { n: 206 }),
    p2: stat(null),
    spark: { days: ['2026-10-08', '2026-10-09'], values: [600, 676], p1_mean: 312 },
    flag: { state: 'above', windows: 190, p10: -181, p90: 640, last21: 676 },
    rank: { value: 4080, rank: 1, of: 12 },
    chips: [{ list: 'A', variant: 'N_dir_0917', role: 'core' }],
    share: { recorded: null, reconstructed: { core: 3, share: 0.0476, buy_days: 0 } },
    matrix: { view: 'pulse', family: 'dirs', slot: '0917,1002', index: null },
    ...over,
  };
}

function data(over: Partial<PulseAvailable> = {}): PulseAvailable {
  return {
    available: true,
    basis: 'gross',
    as_of: '2026-10-09',
    as_of_requested: null,
    store: { first: '2024-10-09', last: '2026-10-09', sessions: 490, weekend_excluded: [] },
    next_pick_day: '2026-10-12',
    list: 'A',
    index: 'both',
    windows: [5, 21, 63],
    periods: {
      P1: { label: 'P1 · Dec 2025 to Oct 2026', from: '2025-12-03', to: '2026-10-08' },
      P2: { label: 'P2 · Jan to Aug 2025', from: '2025-01-10', to: '2025-08-29' },
    },
    rank: {
      available: true,
      reason: null,
      history_days: 486,
      history_to: '2026-10-09',
      of: 12,
      basis: 'net',
      for: '2026-10-12',
      weights: { A: 0.05, B: 0.05, C: 0.05, REF: 0 },
    },
    picks: {
      source: 'reconstructed',
      day: '2026-10-09',
      late: false,
      lists: { A: [{ variant: 'N_dir_0917', role: 'core' }] },
    },
    share: {
      list: 'A',
      sessions: 21,
      recorded: null,
      reconstructed: {
        sessions: 21,
        core_total: 63,
        list: 'A',
        from: '2026-09-09',
        to: '2026-10-09',
      },
    },
    journal: {
      entries: 0,
      on_time: 0,
      late: [],
      chain: { intact: true, problems: [], error: null },
    },
    flag_rule: 'A cell is flagged when ...',
    cells: [
      cell(),
      cell({
        key: 'buy_D',
        kind: 'buy',
        band: 'D',
        label: 'Buy 14:17-15:17',
        kind_label: 'Buy',
        band_label: '14:17-15:17',
        windows: { '5': stat(-171), '21': stat(-121), '63': stat(-96, { n: 63 }) },
        flag: { state: 'below', windows: 190, p10: -99, p90: 104, last21: -121 },
        rank: { value: -853, rank: 12, of: 12 },
        chips: [],
        share: { recorded: null, reconstructed: { core: 0, share: null, buy_days: 4 } },
        matrix: { view: 'pulse', family: 'buy', slot: '1417,1517', index: null },
      }),
    ],
    ...over,
  };
}

beforeEach(() => {
  hook.state = { data: null, loading: false, error: null, refetch: vi.fn() };
  hook.navigate.mockClear();
});
afterEach(cleanup);

describe('RotationPulse', () => {
  it('asks for the focus list and the chosen index', () => {
    hook.state.data = data();
    render(<RotationPulse focus="B" />);
    expect(hook.lastArgs).toEqual(['B', 'both']);
    fireEvent.click(screen.getByRole('radio', { name: 'NIFTY' }));
    expect(hook.lastArgs).toEqual(['B', 'NIFTY']);
    expect(
      screen.getByText(/narrows the means only; it is not what the ranking uses/),
    ).toBeTruthy();
  });

  it('shows the figures, the rank, the drift flag, the chips and the share', () => {
    hook.state.data = data();
    render(<RotationPulse focus="A" />);
    const dir = screen.getByText('Dir').closest('tr') as HTMLElement;
    expect(within(dir).getByText('₹1,031')).toBeTruthy();
    expect(within(dir).getByText('₹676')).toBeTruthy();
    expect(within(dir).getByText('1/12')).toBeTruthy();
    expect(within(dir).getByText('Above')).toBeTruthy();
    expect(within(dir).getByText('A')).toBeTruthy();
    expect(within(dir).getByText('5% · 3/63')).toBeTruthy();
    const buy = screen.getByText('Buy').closest('tr') as HTMLElement;
    expect(within(buy).getByText('Below')).toBeTruthy();
    expect(within(buy).getByText('4 of 21 d')).toBeTruthy();
    expect(
      screen.getByText(/carries 5% of the composite in A, B and C and none in REF/),
    ).toBeTruthy();
  });

  it('a missing window is a dash, never a zero', () => {
    hook.state.data = data();
    render(<RotationPulse focus="A" />);
    const dir = screen.getByText('Dir').closest('tr') as HTMLElement;
    const cells = within(dir).getAllByRole('cell');
    // cell, last 5, last 21, last 63, P1, P2: P2 has no stored result
    expect(cells[5]?.textContent).toBe('—');
    expect(cells[5]?.getAttribute('title')).toContain('no stored result in this window');
  });

  it('labels reconstructed picks as such and never as a record', () => {
    hook.state.data = data();
    render(<RotationPulse focus="A" />);
    expect(screen.getByText('Reconstructed 09 Oct 2026')).toBeTruthy();
    expect(screen.getByText(/not a record/)).toBeTruthy();
  });

  it('labels recorded picks and says a late entry is not forward', () => {
    hook.state.data = data({
      picks: {
        source: 'recorded',
        day: '2026-10-12',
        late: true,
        lists: { A: [{ variant: 'N_dir_0917', role: 'core' }] },
      },
      journal: {
        entries: 1,
        on_time: 0,
        late: ['2026-10-12'],
        chain: { intact: true, problems: [], error: null },
      },
    });
    render(<RotationPulse focus="A" />);
    expect(screen.getByText('Recorded 12 Oct 2026')).toBeTruthy();
    expect(screen.getByText(/not forward, and not counted anywhere/)).toBeTruthy();
    expect(screen.getByText(/1 late entry excluded/)).toBeTruthy();
  });

  it('says so when the journal chain is broken', () => {
    hook.state.data = data({
      journal: {
        entries: 2,
        on_time: 0,
        late: [],
        chain: { intact: false, problems: ['hash mismatch'], error: null },
      },
    });
    render(<RotationPulse focus="A" />);
    expect(screen.getByText(/Journal chain broken/)).toBeTruthy();
  });

  it('explains a ranking that cannot be rebuilt yet, with dashes in the column', () => {
    hook.state.data = data({
      rank: {
        ...data().rank,
        available: false,
        reason:
          'the ranking needs 63 stored sessions with day attributes and has 40 up to 2026-10-09',
      },
      cells: [cell({ rank: null })],
    });
    render(<RotationPulse focus="A" />);
    expect(screen.getByText(/Ranking sees: the ranking needs 63 stored sessions/)).toBeTruthy();
  });

  it('opens the matrix pulse view for a clicked row', () => {
    hook.state.data = data();
    render(<RotationPulse focus="A" />);
    fireEvent.click(screen.getByText('Dir').closest('tr') as HTMLElement);
    expect(hook.navigate).toHaveBeenCalledWith(
      '/optionslab/matrix?view=pulse&family=dirs&slot=0917%2C1002',
    );
  });

  it('shows loading, an empty store, and an error with Retry', () => {
    hook.state.loading = true;
    const { unmount } = render(<RotationPulse focus="A" />);
    expect(screen.queryByText('Ranking sees')).toBeNull();
    unmount();

    hook.state = {
      data: { available: false, reason: 'no strategy has stored results yet', basis: 'gross' },
      loading: false,
      error: null,
      refetch: vi.fn(),
    };
    const second = render(<RotationPulse focus="A" />);
    expect(screen.getByText('No strategy has stored results yet')).toBeTruthy();
    second.unmount();

    hook.state = { data: null, loading: false, error: 'HTTP 500', refetch: vi.fn() };
    render(<RotationPulse focus="A" />);
    expect(screen.getByText('Could not load the Family pulse')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(hook.state.refetch).toHaveBeenCalled();
  });

  it('keeps the previous result on screen with a warning when a later request fails', () => {
    hook.state = { data: data(), loading: false, error: 'HTTP 502', refetch: vi.fn() };
    render(<RotationPulse focus="A" />);
    expect(screen.getByText('The latest request failed; this is the previous result')).toBeTruthy();
    expect(screen.getByText('₹676')).toBeTruthy();
  });

  it('shows a cell the store has no variants for as not applicable, not as zero', () => {
    hook.state.data = data({
      cells: [
        cell({
          st: 'na',
          reason: 'no variant of this strategy kind starts in this band',
          windows: undefined as never,
        }),
      ],
    });
    render(<RotationPulse focus="A" />);
    expect(screen.getByText('no variant of this strategy kind starts in this band')).toBeTruthy();
  });
});
