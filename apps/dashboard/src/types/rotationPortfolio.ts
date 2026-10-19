/**
 * Wire types of the portfolio-stop routes (BL-095): `GET /legwise/rotation/portfolio/days` and
 * `/day` (packages/option-backtesting `rotation/portfolio_log.py`, `api/rotation_portfolio_routes.py`).
 * Gross, for the lots in `lots`; `gross_without` is what the daily log already shows.
 */

import type { RotationListKey } from './rotationDailyLog';

export type PortfolioFiredBy = 'stop' | 'trail' | 'lock';

export interface PortfolioSettingEcho {
  /** The stop in rupees, or null when none applies (empty, 0 or below). */
  amount: number | null;
  /** `sl:X,Y` | `lock:A,B` | `locktrail:A,B,X,Y`, or null. */
  trail: string | null;
}

export interface PortfolioBookRow {
  lots: number;
  /** The daily log's own gross for the list-day. */
  gross_log: number;
  gross_without: number;
  gross_with: number;
  /** Minute index (0 = 09:15) the book stopped at, or null when it never did. */
  stop_minute: number | null;
  /** `11:14` */
  stop_label: string | null;
  fired_by: PortfolioFiredBy | null;
  /** The replay with no stop equals the log's gross (to the paisa a pick). */
  matches_log: boolean;
}

/** A list, or `BASE`: the fixed base booked like a list (`book=base`). */
export type PortfolioBookKey = RotationListKey | 'BASE';

export interface PortfolioDays {
  /** `base` for the fixed base's book. */
  book?: 'base';
  basis: 'gross';
  source: string;
  setting: PortfolioSettingEcho;
  rows: { day: string; lists: Partial<Record<PortfolioBookKey, PortfolioBookRow>> }[];
  errors: { day: string; list: string; error: string }[];
  totals: Partial<
    Record<PortfolioBookKey, { n: number; without: number; with: number; fired: number }>
  >;
}

export interface PortfolioDayPick {
  name: string;
  lots: number;
  role: 'core' | 'buy' | null;
  gross: number;
  at_stop: number;
  /** The pick's rupee path for its lots, one value a minute from 09:15. */
  path: number[];
}

export interface PortfolioDay {
  day: string;
  list: RotationListKey;
  basis: 'gross';
  setting: PortfolioSettingEcho;
  book: PortfolioBookRow;
  minutes: number;
  first_minute_label: string;
  combined: number[];
  stopped: number[];
  /** The stop level at each minute up to the stop; null where no level applies. */
  level: (number | null)[];
  picks: PortfolioDayPick[];
}
