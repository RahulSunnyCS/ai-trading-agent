// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTING } from '../../../lib/portfolioStop';
import type { BookRow } from '../../../lib/rotationBooks';
import type { RotationCompareResponse } from '../../../types/rotationCompare';
import { type BookLine, RotationBooks } from '../rotation/RotationBooks';

const row = (id: BookRow['id']): BookRow => ({
  id,
  latest: { day: '2026-11-05', total: 100 },
  total: 1000,
  firstDay: '2026-10-12',
  scoredDays: 16,
  perLotDay: 50,
  maxDrawdown: -100,
  maxDrawdownPerLot: -30,
  vsBenchmark: id === 'BASE' ? null : -10,
  beatsRandom: 50,
});

const line = (id: BookRow['id'], compareBook: BookLine['compareBook'], name: string): BookLine => ({
  row: row(id),
  name,
  note: '',
  focus: id === 'T1',
  compareBook,
  stop: {
    setting: DEFAULT_SETTING,
    onChange: () => undefined,
    defaults: DEFAULT_SETTING,
    title: 'Portfolio stop',
    effect: null,
    status: null,
  },
});

const data: RotationCompareResponse = {
  n_days: 439,
  first_day: '2025-01-10',
  last_day: '2026-11-05',
  windows: {
    months6: {
      days: 118,
      from: '2026-05-06',
      books: {
        t1: {
          edge_sigma: 2.6,
          recorded_days: 11,
          gap_mean: 208,
          gap_lower: -162,
          gap_upper: 596,
          better_days_pct: 53,
        },
        core: {
          edge_sigma: 1.8,
          recorded_days: 16,
          gap_mean: 102,
          gap_lower: 74,
          gap_upper: 458,
          better_days_pct: 57,
        },
        base: { edge_sigma: 0.2, recorded_days: 0 },
      },
    },
  },
  alarm: { window: 60, below: -500, books: {} },
};

function table(onWindow = vi.fn(), historyWindow: 'months6' | 'year1' = 'months6') {
  return render(
    <RotationBooks
      lines={[
        line('T1', 't1', 'Adaptive Tuned'),
        line('C', 'core', 'Adaptive Classic'),
        line('BASE', 'base', 'Fixed base'),
      ]}
      vsHeader="vs base"
      compare={{ data, loading: false, error: null }}
      historyWindow={historyWindow}
      onWindow={onWindow}
    />,
  );
}

describe('RotationBooks history columns', () => {
  it('names the picked window in the gap column header', () => {
    table();
    expect(screen.getByText(/6 months vs base \/ lot-day/)).toBeTruthy();
    expect(screen.getByText('Edge over random')).toBeTruthy();
  });

  it('shows each Adaptive book its gap and range, the base "the base", and σ for all three', () => {
    table();
    expect(screen.getByText('+₹208')).toBeTruthy();
    expect(screen.getByText(/includes 0/)).toBeTruthy();
    expect(screen.getByText(/clears 0/)).toBeTruthy();
    expect(screen.getAllByText('the base').length).toBeGreaterThan(0);
    expect(screen.getByText('2.6 σ')).toBeTruthy();
    expect(screen.getByText('0.2 σ')).toBeTruthy();
  });

  it('asks for another window when the picker changes', () => {
    const onWindow = vi.fn();
    table(onWindow);
    fireEvent.click(screen.getByRole('radio', { name: '1 year' }));
    expect(onWindow).toHaveBeenCalledWith('year1');
  });

  it('has no beats-random percentage column any more', () => {
    table();
    expect(screen.queryByText('Beats random')).toBeNull();
    expect(screen.queryByText('Last 60 sessions')).toBeNull();
  });
});
