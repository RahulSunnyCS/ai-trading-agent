// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { response } from '../../../lib/__tests__/rotationDriftFixture';

const hook = vi.hoisted(() => ({
  state: { data: null, loading: false, error: null, refetch: vi.fn() } as {
    data: unknown;
    loading: boolean;
    error: string | null;
    refetch: () => void;
  },
}));

vi.mock('../../../hooks/useRotationDrift', () => ({ useRotationDrift: () => hook.state }));

import { RotationDrift } from '../RotationDrift';

beforeEach(() => {
  hook.state = { data: null, loading: false, error: null, refetch: vi.fn() };
});
afterEach(cleanup);

describe('RotationDrift', () => {
  it('shows a bar per window for each dimension and badges what is outside its range', () => {
    hook.state.data = response();
    render(<RotationDrift list="A" />);
    expect(screen.getByText('Selection drift')).toBeTruthy();
    expect(screen.getByText('4 outside its range')).toBeTruthy();
    // three rows (P1, Last 63, Last 21) for each of the two dimensions
    expect(screen.getAllByText('Last 21')).toHaveLength(2 + 1); // two bars and the table header
    expect(
      screen.getAllByText('SENSEX 100% over the last 21, above its usual 24% to 51%').length,
    ).toBeGreaterThan(0);
  });

  it('puts the concentration measures in a table with the usual range and the flag', () => {
    hook.state.data = response();
    render(<RotationDrift list="A" />);
    const table = screen.getByRole('table');
    expect(within(table).getByText('Distinct variants picked')).toBeTruthy();
    expect(within(table).getByText('49')).toBeTruthy();
    expect(within(table).getByText('36 to 44')).toBeTruthy();
    expect(within(table).getByText('3 · N_p100_1217')).toBeTruthy();
  });

  it('says there is not enough to read instead of flagging', () => {
    hook.state.data = response({ enough: false, flags: 0 });
    render(<RotationDrift list="A" />);
    expect(screen.getByText(/flags nothing/)).toBeTruthy();
    expect(screen.queryByText(/outside its range/)).toBeNull();
  });

  it('says there are no picks yet', () => {
    const d = response();
    hook.state.data = {
      ...d,
      windows: { ...d.windows, last21: { ...d.windows.last21, n_days: 0 } },
    };
    render(<RotationDrift list="A" />);
    expect(screen.getByText('No picks to count yet')).toBeTruthy();
  });

  it('does not show another list’s response, and shows an error instead of held figures', () => {
    hook.state.data = response({ list: 'B' });
    const { unmount } = render(<RotationDrift list="A" />);
    expect(screen.queryByRole('table')).toBeNull();
    unmount();
    hook.state.data = response();
    hook.state.error = '500: the stored rotation files cannot be read';
    render(<RotationDrift list="A" />);
    expect(screen.getByText('Could not read the picks')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});
