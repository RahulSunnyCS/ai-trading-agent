/** GET /legwise/rotation/beats?book=core|t1 (packages/option-backtesting rotation/beats.py). */

export type BeatsBook = 'core' | 't1' | 'base';

export interface BeatsWindow {
  /** Sessions the window covers. */
  days: number;
  /** The first of them. */
  from: string;
  /** How many of them the journal recorded at 09:16; the rest are the rule re-derived. */
  recorded_days: number;
  /** The book's cumulative gross at one lot a strategy, and the random baskets' spread. */
  total: number;
  random_p10: number;
  random_p50: number;
  random_p90: number;
  /** Share of the random baskets' cumulative gross the book is above, 0 to 100. */
  beats_random_pct: number;
}

export type BeatsWindowName = 'sessions60' | 'months6' | 'year1' | 'years2' | 'all' | 'recorded';

export interface RotationBeatsResponse {
  book: BeatsBook;
  first_day: string | null;
  last_day: string | null;
  n_days: number;
  recorded_days: number;
  /** The fixed base: one rule every day, so no day is recorded or re-derived. */
  fixed: boolean;
  windows: Record<BeatsWindowName, BeatsWindow | null>;
}
