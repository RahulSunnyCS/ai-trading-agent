// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { period, response } from '../../../lib/__tests__/rotationRegimeFixture';

const hook = vi.hoisted(() => ({
  state: { data: null, loading: false, error: null, refetch: vi.fn() } as {
    data: unknown;
    loading: boolean;
    error: string | null;
    refetch: () => void;
  },
}));

vi.mock('../../../hooks/useRotationRegime', () => ({ useRotationRegime: () => hook.state }));

import { RotationRegime } from '../RotationRegime';

beforeEach(() => {
  hook.state = { data: null, loading: false, error: null, refetch: vi.fn() };
});
afterEach(cleanup);

describe('RotationRegime', () => {
  it('shows each period, the P3 gap and the nearer period', () => {
    hook.state.data = response();
    render(<RotationRegime />);
    expect(screen.getByText('Forward days vs research periods')).toBeTruthy();
    expect(screen.getByText('200 sessions')).toBeTruthy(); // P1
    expect(screen.getByText('157 sessions')).toBeTruthy(); // P2
    expect(screen.getByText('18 sessions')).toBeTruthy(); // forward
    expect(screen.getByText('not in the store')).toBeTruthy(); // P3
    expect(screen.getByText('18 of 20 sessions')).toBeTruthy(); // thin badge
    const table = screen.getByRole('table');
    expect(within(table).getByText('Average')).toBeTruthy();
    expect(screen.getByText(/nearer P1/)).toBeTruthy();
  });

  it('draws the mixes as labelled images that read in words', () => {
    hook.state.data = response();
    render(<RotationRegime />);
    const bars = screen.getAllByRole('img');
    expect(bars.length).toBeGreaterThan(8);
    expect(bars[0]?.getAttribute('aria-label')).toContain('%');
  });

  it('says there are no forward sessions yet instead of an empty table', () => {
    hook.state.data = response({
      distances: null,
      forward_days: 0,
      periods: response().periods.map((p) =>
        p.id === 'forward'
          ? period('forward', {
              status: 'empty',
              n: 0,
              mix: null,
              reason: 'none',
              vix_open: null,
              range: null,
            })
          : p,
      ),
    });
    render(<RotationRegime />);
    expect(screen.getByText('No forward sessions yet')).toBeTruthy();
    expect(screen.getByText('no sessions yet')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows the error when nothing has loaded', () => {
    hook.state.error = '500: the journal cannot be read';
    render(<RotationRegime />);
    expect(screen.getByText('Could not read the periods')).toBeTruthy();
  });

  it('keeps the last response and says so when a refresh fails', () => {
    hook.state.data = response();
    hook.state.error = 'network down';
    render(<RotationRegime />);
    expect(screen.getByText('The periods could not be refreshed')).toBeTruthy();
    expect(screen.getByText('200 sessions')).toBeTruthy();
  });
});
