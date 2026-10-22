// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { day, group, response } from '../../../lib/__tests__/rotationLiveFixture';

const hook = vi.hoisted(() => ({
  state: { data: null, loading: false, error: null, refetch: vi.fn() } as {
    data: unknown;
    loading: boolean;
    error: string | null;
    refetch: () => void;
  },
}));

vi.mock('../../../hooks/useRotationLive', () => ({
  useRotationLive: () => hook.state,
}));

// the chart is Lightweight Charts (canvas): out of scope here, so a plain stand-in
vi.mock('../shared', () => ({
  CumulativeLines: ({ lines }: { lines: { id: string }[] }) => (
    <div data-testid="lines">{lines.map((l) => l.id).join(',')}</div>
  ),
  pnlClass: () => '',
}));

import { RotationLiveVsPaper } from '../RotationLiveVsPaper';

beforeEach(() => {
  hook.state = { data: null, loading: false, error: null, refetch: vi.fn() };
});
afterEach(cleanup);

describe('RotationLiveVsPaper', () => {
  it('shows the totals, the chart, the day and the shapes', () => {
    hook.state.data = response();
    render(<RotationLiveVsPaper />);
    expect(screen.getAllByText('AlgoTest · Shoonya · T1').length).toBeGreaterThan(0);
    expect(screen.getByTestId('lines').textContent).toBe('AlgoTest · Shoonya · T1');
    expect(screen.getByText('21 Oct 2026')).toBeTruthy();
    expect(screen.getByText('AlgoTest · Sell · 09:30–12:00')).toBeTruthy();
    expect(screen.getByText('Discretionary')).toBeTruthy();
  });

  it('flags a day that was not captured instead of showing a zero', () => {
    hook.state.data = response({
      days: [day({ captured: false, groups: [] })],
      running: [],
      shapes: [],
    });
    render(<RotationLiveVsPaper />);
    expect(screen.getByText('Not captured')).toBeTruthy();
    expect(screen.getByText('No day compared yet')).toBeTruthy();
    expect(screen.queryByTestId('lines')).toBeNull();
  });

  it('shows no percentage for Quantiply, which has no fills', () => {
    hook.state.data = response({
      running: [],
      shapes: [],
      days: [
        day({
          groups: [
            group({ platform: 'quantiply', broker: 'angelone', book: 'core', slippage_pct: null }),
          ],
        }),
      ],
    });
    render(<RotationLiveVsPaper />);
    expect(screen.getAllByText('Quantiply · Angel One · Core').length).toBeGreaterThan(0);
    expect(screen.queryByText(/%\)/)).toBeNull();
  });

  it('shows an error instead of held figures', () => {
    hook.state.data = response();
    hook.state.error = '500: the stored files cannot be read';
    render(<RotationLiveVsPaper />);
    expect(screen.getByText('Could not read the live results')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('shows a skeleton until the first answer', () => {
    render(<RotationLiveVsPaper />);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Not captured')).toBeNull();
  });
});
