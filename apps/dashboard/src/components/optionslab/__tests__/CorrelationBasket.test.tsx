// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CorrelationResponse } from '../../../types/legwise';
import type { BasketPick, RotationBasketResponse } from '../../../types/rotationBasket';

const hook = vi.hoisted(() => ({
  state: { data: null, loading: false, error: null, refetch: vi.fn() } as {
    data: unknown;
    loading: boolean;
    error: string | null;
    refetch: () => void;
  },
  lastArgs: null as unknown,
}));

vi.mock('../../../hooks/useRotationBasket', () => ({
  useRotationBasket: (args: unknown) => {
    hook.lastArgs = args;
    return hook.state;
  },
}));

import { CorrelationBasket } from '../correlation/CorrelationBasket';

function corr(): CorrelationResponse {
  const p = [
    [1, -0.05, 0.16],
    [-0.05, 1, 0.14],
    [0.16, 0.14, 1],
  ];
  const stats = {
    net: 1000,
    max_dd: -20000,
    worst_day: -2500,
    loss_day_share: 0.4,
    mean_over_std: 0.1,
  };
  return {
    names: ['N_wide_0932', 'S_dir_1202', 'S_wide_1347'],
    kinds: ['variant', 'variant', 'variant'],
    days: ['2025-12-03', '2026-10-08'],
    n_days: 203,
    window: 63,
    order: [0, 1, 2],
    pearson: p,
    spearman: p,
    loss_overlap: p,
    loss_corr: p,
    both_lose_days: [
      [77, 25, 36],
      [25, 68, 25],
      [36, 25, 81],
    ],
    parts: { N_wide_0932: stats, S_dir_1202: stats, S_wide_1347: stats },
    basket: {
      names: ['N_wide_0932', 'S_dir_1202', 'S_wide_1347'],
      net: 3000,
      max_dd: -106202,
      worst_day: -4000,
      loss_day_share: 0.3,
      sum_of_part_dds: -147354,
      dd_ratio: 0.72,
      mean_over_std: 0.2,
    },
    rolling: [],
    selectors: ['N_wide_0932'],
    from: '2025-12-03',
    to: '2026-10-08',
    stale: [],
    in_sample: true,
  };
}

function pick(name: string, start: string, over: Partial<BasketPick> = {}): BasketPick {
  return {
    name,
    index: name.startsWith('N') ? 'NIFTY' : 'SENSEX',
    family: name.split('_')[1] ?? null,
    kind: name.includes('dir') ? 'dir' : 'wide',
    start,
    band: 'A',
    role: 'core',
    lots: 2,
    composite: 0.85,
    has_results: true,
    first: '2024-10-09',
    last: '2026-10-09',
    n_days: 487,
    ...over,
  };
}

function basket(over: Partial<RotationBasketResponse> = {}): RotationBasketResponse {
  const window = {
    id: 'P1' as const,
    label: 'P1 · Dec 2025 to Oct 2026',
    from: '2025-12-03',
    to: '2026-10-08',
  };
  return {
    list: 'A',
    label: 'List A',
    day: '2026-10-12',
    weekday: 'Mon',
    source: 'recorded',
    late: false,
    overridden: false,
    picks: [
      pick('S_wide_1347', '13:47'),
      pick('N_wide_0932', '09:32'),
      pick('S_dir_1202', '12:02'),
    ],
    omitted: [],
    duplicates: [],
    lots: 6,
    windows: {
      P1: { id: 'P1', label: 'P1', from: '2025-12-03', to: '2026-10-08', n_days: 203 },
      P2: { id: 'P2', label: 'P2', from: '2025-01-10', to: '2025-08-29', n_days: 158 },
      last63: { id: 'last63', label: 'Last 63', from: '2026-07-08', to: '2026-10-09', n_days: 63 },
      forward: { id: 'forward', label: 'Forward', from: null, to: null, n_days: 0 },
    },
    window,
    correlation: corr(),
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
    ...over,
  };
}

beforeEach(() => {
  hook.state = { data: null, loading: false, error: null, refetch: vi.fn() };
  window.history.replaceState(null, '', '/');
});
afterEach(cleanup);

describe('CorrelationBasket', () => {
  it('shows the picks in start-time order with where they came from, and the figures', () => {
    hook.state.data = basket();
    render(<CorrelationBasket onOpenCustom={() => undefined} />);
    const names = screen.getAllByText(/^(N|S)_(wide|dir)_\d{4}$/).map((el) => el.textContent);
    expect(names).toEqual(['N_wide_0932', 'S_dir_1202', 'S_wide_1347']);
    expect(screen.getByText('Recorded')).toBeTruthy();
    // lost together: the stat tile and the table's sentence both say it
    expect(screen.getAllByText('11 of 203').length).toBeGreaterThan(0);
    expect(screen.getByText(/close to independent/)).toBeTruthy();
    expect(screen.getByText(/28% shallower/)).toBeTruthy();
  });

  it('mutes thin windows and says so, instead of hiding the figures', () => {
    hook.state.data = basket({ enough: false, n_days: 5 });
    const { container } = render(<CorrelationBasket onOpenCustom={() => undefined} />);
    expect(screen.getByText(/5 days is too few to read/)).toBeTruthy();
    expect(container.querySelector('[data-thin="true"]')).not.toBeNull();
  });

  it('names a pick with no results and gives the reason where there are no figures', () => {
    hook.state.data = basket({
      picks: [pick('N_wide_0932', '09:32', { has_results: false })],
      omitted: ['N_wide_0932'],
      correlation: null,
      reason: 'no stored results for N_wide_0932',
    });
    render(<CorrelationBasket onOpenCustom={() => undefined} />);
    expect(screen.getByText('no results')).toBeTruthy();
    expect(screen.getByText('No figures for this window')).toBeTruthy();
    expect(screen.getByText('no stored results for N_wide_0932')).toBeTruthy();
  });

  it('calls a reconstructed day reconstructed and a late one late', () => {
    hook.state.data = basket({ source: 'reconstructed' });
    const { rerender } = render(<CorrelationBasket onOpenCustom={() => undefined} />);
    expect(screen.getByText('Reconstructed')).toBeTruthy();
    hook.state.data = basket({ late: true });
    rerender(<CorrelationBasket onOpenCustom={() => undefined} />);
    expect(screen.getByText('Recorded late')).toBeTruthy();
  });

  it('opens the picks in the strategy picker with the window dates', () => {
    hook.state.data = basket();
    const onOpen = vi.fn();
    render(<CorrelationBasket onOpenCustom={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open as custom' }));
    expect(onOpen).toHaveBeenCalledWith(['S_wide_1347', 'N_wide_0932', 'S_dir_1202'], {
      from: '2025-12-03',
      to: '2026-10-08',
    });
  });

  it('cannot open the base as custom, and does not send a day for it', () => {
    hook.state.data = basket({ list: 'BASE', source: 'base', day: null, weekday: null });
    window.history.replaceState(null, '', '/?blist=BASE&bday=2026-10-12');
    render(<CorrelationBasket onOpenCustom={() => undefined} />);
    expect(
      (screen.getByRole('button', { name: 'Open as custom' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(hook.lastArgs).toMatchObject({ list: 'BASE' });
  });

  it('does not show the previous list under controls that ask for another', () => {
    hook.state.data = basket(); // List A's response is still held
    window.history.replaceState(null, '', '/?blist=BASE');
    render(<CorrelationBasket onOpenCustom={() => undefined} />);
    expect(screen.queryByText('N_wide_0932')).toBeNull();
    expect(screen.queryByText('Recorded')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Open as custom' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows the error, not the held basket, when the new request failed', () => {
    hook.state.data = basket();
    hook.state.error = '404: 2025-01-02 cannot be re-scored';
    render(<CorrelationBasket onOpenCustom={() => undefined} />);
    expect(screen.getByText('No basket to show')).toBeTruthy();
    expect(screen.getByText('404: 2025-01-02 cannot be re-scored')).toBeTruthy();
    expect(screen.queryByText('N_wide_0932')).toBeNull();
  });

  it('shows a request error when there is nothing to fall back on', () => {
    hook.state.error = '404: no basket';
    render(<CorrelationBasket onOpenCustom={() => undefined} />);
    expect(screen.getByText('No basket to show')).toBeTruthy();
    expect(screen.getByText('404: no basket')).toBeTruthy();
  });
});
