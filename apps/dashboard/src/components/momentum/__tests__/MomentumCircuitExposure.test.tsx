// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { MomentumCircuitExposure } from '../../../types/momentum';
import { MomentumCircuitExposureCard } from '../MomentumCircuitExposure';

afterEach(cleanup);

const exposure: MomentumCircuitExposure = {
  positions: 100,
  touched: 40,
  episodes: 55,
  blocked_entries: 3,
  blocked_exits: 2,
  lc: [
    {
      symbol: 'ATGL',
      start: '2023-01-27',
      end: '2023-02-28',
      days: 23,
      band_pct: 20,
      move_pct: -81.5,
      exit: 'sold_after',
      exit_date: '2023-10-27',
      realised_move_pct: -84.7,
      portfolio_share_pct: 15.3,
      portfolio_impact_pct: -12.96,
    },
  ],
  uc: [],
  lc_escaped: [
    {
      symbol: 'QUESS',
      start: '2020-03-18',
      end: '2020-03-23',
      days: 5,
      band_pct: 10,
      move_pct: -44.6,
      exit_date: '2020-01-31',
      days_before: 47,
      portfolio_share_pct: 7.6,
      avoided_impact_pct: -3.41,
    },
  ],
  lc_trapped_count: 9,
  lc_escaped_count: 1,
  lc_trapped_sold_during: 0,
  realism: {
    this_run_respects_locks: false,
    ignoring_locks: { cagr: 0.408, max_drawdown: -0.4463, total_return: 26.97, trades: 8315 },
    respecting_locks: { cagr: 0.3856, max_drawdown: -0.448, total_return: 22.93, trades: 8306 },
    cagr_impact: -0.0224,
  },
};

describe('MomentumCircuitExposureCard', () => {
  it('renders nothing when the backend could not compute it', () => {
    const { container } = render(<MomentumCircuitExposureCard exposure={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('compares the CAGR with locks ignored and respected, and marks this run', () => {
    render(<MomentumCircuitExposureCard exposure={exposure} />);
    expect(screen.getByText('Ignoring locks')).toBeTruthy();
    expect(screen.getByText('Respecting locks')).toBeTruthy();
    expect(screen.getByText('40.8%')).toBeTruthy();
    expect(screen.getByText('38.6%')).toBeTruthy();
    expect(screen.getByText('-2.2')).toBeTruthy();
    expect(screen.getAllByText('this run')).toHaveLength(1);
  });

  it('shows the trapped table first and switches tabs without losing the summary', () => {
    render(<MomentumCircuitExposureCard exposure={exposure} />);
    expect(screen.getByText('ATGL')).toBeTruthy();
    expect(screen.getByText('-81.5%')).toBeTruthy();
    expect(screen.getByText('sold 27 Oct 2023, after the lock')).toBeTruthy();
    expect(screen.queryByText('QUESS')).toBeNull();
    expect(screen.getByText(/already out before 1 \(10%\)/)).toBeTruthy();
    expect(screen.getByText(/still holding in 9/)).toBeTruthy();

    // The shared Tabs (Radix) selects on mouse down, not on click.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /got out in time \(1\)/ }));
    expect(screen.getByText('QUESS')).toBeTruthy();
    expect(screen.getByText('31 Jan 2020 (47 days before)')).toBeTruthy();
    expect(screen.getByText('-3.41%')).toBeTruthy();
    expect(screen.queryByText('ATGL')).toBeNull();
    expect(screen.getByText(/already out before 1 \(10%\)/)).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole('tab', { name: /Upper circuit/ }));
    expect(screen.getByText(/No upper-circuit run hit a stock/)).toBeTruthy();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });
});
