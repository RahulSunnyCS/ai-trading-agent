/** GET /legwise/rotation/beats/compare (packages/option-backtesting rotation/beats.py `compare`). */

export type CompareWindow = 'sessions60' | 'months6' | 'year1' | 'years2';
export type CompareBook = 'core' | 't1' | 'base';

export interface CompareBookFigures {
  /** The window's book total minus the random baskets' mean, in their standard deviations. */
  edge_sigma: number | null;
  /** Sessions in the window the journal recorded at 09:16; the rest are re-derived. */
  recorded_days: number;
  /** ₹ per lot-day against the fixed base, with a 90% block-bootstrap range; the base has none. */
  gap_mean?: number;
  gap_lower?: number;
  gap_upper?: number;
  /** Share of the window's days the book was ahead of the base, 0 to 100. */
  better_days_pct?: number;
}

export interface CompareWindowRow {
  days: number;
  from: string;
  books: Record<CompareBook, CompareBookFigures>;
}

export type AlarmState = 'quiet' | 'watch' | 'review';

export interface RotationCompareResponse {
  /** Sessions all three books have, the basis of every figure. */
  n_days: number;
  first_day: string | null;
  last_day: string | null;
  windows: Partial<Record<CompareWindow | 'all', CompareWindowRow>>;
  alarm: {
    window: number;
    below: number;
    books: Partial<
      Record<'core' | 't1', { gap: number; state: AlarmState; last_review_day: string | null }>
    >;
  };
}
