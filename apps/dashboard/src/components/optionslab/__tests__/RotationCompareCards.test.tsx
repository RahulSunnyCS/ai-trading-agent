// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { RotationCompareResponse } from '../../../types/rotationCompare';
import { RotationCompareCards } from '../rotation/RotationCompareCards';

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
          gap_lower: -265,
          gap_upper: 458,
          better_days_pct: 54,
        },
        base: { edge_sigma: 0.2, recorded_days: 0 },
      },
    },
  },
  alarm: {
    window: 60,
    below: -500,
    books: {
      t1: { gap: 91, state: 'quiet', last_review_day: null },
      core: { gap: -900, state: 'review', last_review_day: '2026-10-30' },
    },
  },
};

describe('RotationCompareCards', () => {
  it('shows the gap, its range and that it includes zero', () => {
    render(<RotationCompareCards read={{ data, loading: false, error: null }} window="months6" />);
    expect(screen.getByText('Adaptive Tuned minus base')).toBeTruthy();
    expect(screen.getAllByText(/includes 0/).length).toBe(2);
    expect(screen.getByText(/ahead on 53% of days/)).toBeTruthy();
    expect(screen.getByText('0.2 σ')).toBeTruthy();
  });

  it('says the history is mostly replayed and Tuned is in-sample', () => {
    render(<RotationCompareCards read={{ data, loading: false, error: null }} window="months6" />);
    expect(screen.getByText(/stored results replayed through the 09:16 rule/)).toBeTruthy();
    expect(screen.getByText(/Tuned's settings were chosen on this history/)).toBeTruthy();
  });

  it('shows each book alarm state and the last review', () => {
    render(<RotationCompareCards read={{ data, loading: false, error: null }} window="months6" />);
    expect(screen.getByText('quiet')).toBeTruthy();
    expect(screen.getByText('review')).toBeTruthy();
    expect(screen.getByText(/last review/)).toBeTruthy();
    expect(screen.getByText(/no Telegram alert yet/)).toBeTruthy();
  });

  it('says so while reading and when the read failed', () => {
    const { rerender } = render(
      <RotationCompareCards read={{ data: null, loading: true, error: null }} window="months6" />,
    );
    expect(screen.getByText(/Reading the head-to-head/)).toBeTruthy();
    rerender(
      <RotationCompareCards
        read={{ data: null, loading: false, error: 'boom' }}
        window="months6"
      />,
    );
    expect(screen.getByText(/could not be read: boom/)).toBeTruthy();
  });
});
