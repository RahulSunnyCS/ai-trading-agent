// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { episode, response } from '../../../lib/__tests__/rotationDrawdownsFixture';
import { DEFAULT_SETTING } from '../../../lib/portfolioStop';

const hook = vi.hoisted(() => ({
  state: { data: null, loading: false, error: null, refetch: vi.fn() } as {
    data: unknown;
    loading: boolean;
    error: string | null;
    refetch: () => void;
  },
  lastArgs: null as unknown,
}));

vi.mock('../../../hooks/useRotationDrawdowns', () => ({
  useRotationDrawdowns: (args: unknown) => {
    hook.lastArgs = args;
    return hook.state;
  },
}));

import { RotationDrawdowns } from '../RotationDrawdowns';

beforeEach(() => {
  hook.state = { data: null, loading: false, error: null, refetch: vi.fn() };
  window.history.replaceState(null, '', '/');
});
afterEach(cleanup);

describe('RotationDrawdowns', () => {
  it('lists the episodes with their depth, length and the base over the same days', () => {
    hook.state.data = response();
    render(<RotationDrawdowns list="A" />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('-₹1,500')).toBeTruthy();
    expect(within(table).getByText('3 down, 2 to recover')).toBeTruthy();
    expect(within(table).getByText('-₹400')).toBeTruthy();
    expect(screen.getByText('6 sessions')).toBeTruthy();
    expect(screen.getByText('6 reconstructed')).toBeTruthy();
  });

  it('shows the deepest episode’s drivers first and the picked one when a row is chosen', () => {
    hook.state.data = response({
      episodes: [
        episode({ n: 1, depth: -700 }),
        episode({
          n: 2,
          depth: -1500,
          drivers: [
            { kind: 'dir', band: 'C', label: 'Dir · 12:17–14:02', total: -1500, pick_days: 5 },
          ],
        }),
      ],
    });
    render(<RotationDrawdowns list="A" />);
    expect(screen.getByText('Dir · 12:17–14:02')).toBeTruthy(); // the deepest, by default
    fireEvent.click(screen.getByRole('button', { name: 'Show what drove episode 1' }));
    expect(screen.getByText('Widesl · 09:17–10:02')).toBeTruthy();
  });

  it('forgets the chosen episode when the list changes', () => {
    hook.state.data = response({
      episodes: [
        episode({ n: 1, depth: -700 }),
        episode({
          n: 2,
          depth: -1500,
          drivers: [
            { kind: 'dir', band: 'C', label: 'Dir · 12:17–14:02', total: -1500, pick_days: 5 },
          ],
        }),
      ],
    });
    const { rerender } = render(<RotationDrawdowns list="A" />);
    fireEvent.click(screen.getByRole('button', { name: 'Show what drove episode 1' }));
    expect(screen.getByText('Widesl · 09:17–10:02')).toBeTruthy();
    hook.state.data = response({
      list: 'REF',
      episodes: [
        episode({ n: 1, depth: -700 }),
        episode({
          n: 2,
          depth: -1500,
          drivers: [
            { kind: 'dir', band: 'C', label: 'Dir · 12:17–14:02', total: -1500, pick_days: 5 },
          ],
        }),
      ],
    });
    rerender(<RotationDrawdowns list="REF" />);
    // back to the deepest episode, not REF's episode 1 that the user never chose
    expect(screen.getByText('Dir · 12:17–14:02')).toBeTruthy();
  });

  it('marks an episode that never got back as open', () => {
    hook.state.data = response({
      episodes: [episode({ open: true, end_day: null, sessions_back: null })],
    });
    render(<RotationDrawdowns list="A" />);
    expect(screen.getByText('open')).toBeTruthy();
    expect(screen.getByText('3 down, still open')).toBeTruthy();
  });

  it('says no fall reached the threshold rather than showing an empty table', () => {
    hook.state.data = response({ episodes: [] });
    render(<RotationDrawdowns list="A" />);
    expect(screen.getByText('No fall reached ₹500 per lot')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('says there are no scored forward sessions yet', () => {
    window.history.replaceState(null, '', '/?ddwin=forward');
    hook.state.data = response({
      window: { id: 'forward', label: 'Forward', from: null, to: null },
      n_days: 0,
      series: [],
      episodes: [],
    });
    render(<RotationDrawdowns list="A" />);
    expect(screen.getByText('No scored forward sessions yet')).toBeTruthy();
    expect(hook.lastArgs).toMatchObject({ list: 'A', window: 'forward', minDepth: 500 });
  });

  it('names what was left out of the series', () => {
    hook.state.data = response({ left_out: { late: 1, waiting: 2, no_entry: 1 } });
    render(<RotationDrawdowns list="A" />);
    expect(screen.getByText(/1 late, 2 not yet scored, 1 without an entry/)).toBeTruthy();
  });

  it('does not show a held response for another list or window', () => {
    hook.state.data = response({ list: 'B' });
    render(<RotationDrawdowns list="A" />);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the error instead of the held figures', () => {
    hook.state.data = response();
    hook.state.error = '422: window must be one of P1';
    render(<RotationDrawdowns list="A" />);
    expect(screen.getByText('Could not read the drawdowns')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('RotationDrawdowns with a portfolio stop', () => {
  const withStop = {
    setting: { amount: 8000, trail: null },
    max_dd: -900,
    total_per_lot: 1200,
    total_per_lot_without: 800,
    days_stopped: 2,
    replay_errors: 1,
    episodes: 1,
    all_episodes: 1,
    current: null,
  };

  it('asks for the stop and shows both worst falls and the stopped line', () => {
    const base = response();
    hook.state.data = response({
      with_stop: withStop,
      series: base.series.map((p) => ({ ...p, underwater_with: p.underwater / 2, stopped: false })),
    });
    render(<RotationDrawdowns list="A" portfolio={DEFAULT_SETTING} />);
    expect((hook.lastArgs as { portfolio: unknown }).portfolio).toEqual(DEFAULT_SETTING);
    expect(screen.getByText('Worst fall per lot, registered')).toBeTruthy();
    expect(screen.getByText('-₹900')).toBeTruthy();
    expect(screen.getByText(/2 of 6/)).toBeTruthy();
    expect(screen.getByText(/1 not replayed/)).toBeTruthy();
    expect(screen.getByText(/with the portfolio stop/)).toBeTruthy();
    expect(screen.getByText(/With the ₹8,000 stop replayed/)).toBeTruthy();
  });

  it('does not draw an answer made for another setting under this one', () => {
    hook.state.data = response({
      with_stop: { ...withStop, setting: { amount: 7000, trail: null } },
    });
    render(<RotationDrawdowns list="A" portfolio={DEFAULT_SETTING} />);
    expect(screen.queryByText('Worst fall per lot, registered')).toBeNull();
  });

  it('shows nothing extra when the stop is off', () => {
    hook.state.data = response();
    render(<RotationDrawdowns list="A" portfolio={{ ...DEFAULT_SETTING, stop: '' }} />);
    expect(screen.queryByText('Worst fall per lot, registered')).toBeNull();
    expect(screen.getByText('6 sessions')).toBeTruthy();
  });
});
