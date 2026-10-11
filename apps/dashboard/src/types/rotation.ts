/**
 * Wire types of `GET /legwise/rotation/overview` and `/summary` (BL-058 Phase 4). Hand-written, as
 * the dashboard imports nothing from the Python side; the source is `rotation/overview.py` and
 * `rotation/readout.py`.
 */

export type RotationListKey = 'A' | 'B' | 'C' | 'REF';
export type RotationCheckState = 'ok' | 'warn' | 'bad' | 'info';

export interface RotationCheck {
  id: string;
  label: string;
  value: string;
  state: RotationCheckState;
  detail: string;
}

export interface RotationHealth {
  checks: RotationCheck[];
  state: RotationCheckState;
  as_of: string;
}

export interface RotationPick {
  name: string;
  index: 'NIFTY' | 'SENSEX';
  family: string;
  kind: 'wide' | 'dir' | 'buy' | 'other';
  /** HH:MM */
  start: string;
  composite: number | null;
  shared_by: number;
}

export interface RotationBasket {
  core: RotationPick[];
  buy: RotationPick[];
  overridden: boolean;
}

export interface RotationEntry {
  day: string;
  weekday: string;
  vix_open: number;
  vix_band: string;
  dte: { NIFTY: string; SENSEX: string };
  recorded_at: string;
  on_time: boolean;
  hash: string;
  lots_per_strategy: number;
}

export interface RotationBaskets {
  entry: RotationEntry | null;
  lists: Partial<Record<RotationListKey, RotationBasket>>;
  changed: Partial<Record<RotationListKey, { added: string[]; removed: string[] }>>;
  readout_days: number;
}

export interface RotationListSpec {
  description: string;
  /** Percent: recent, weekday, dte, vix, rfam. */
  weights: Record<string, number>;
  lookbacks: { days: number; weight: number }[];
}

export interface RotationOverview {
  health: RotationHealth;
  baskets: RotationBaskets;
  lists: Record<RotationListKey, RotationListSpec>;
  first_entry_day: string;
  readout_days: number;
}

export interface RotationInterval {
  mean: number;
  lower: number;
  upper: number;
}

export interface RotationListStats {
  total: number;
  mean_day: number;
  per_lot_day: number;
  lots_per_day: number;
  max_drawdown: number;
  max_drawdown_per_lot: number;
  beats_random_pct: number;
  random: { p10: number; p50: number; p90: number; max: number };
  mean_daily_random_percentile: number;
  random_path: { p10: number[]; p50: number[]; p90: number[] };
  vs_base: RotationInterval & { drawdown_no_worse: boolean; beats_base: boolean };
  vs_ref: RotationInterval | null;
}

export interface RotationBase {
  definition: string;
  per_lot_day: number;
  cumulative_per_lot: number;
  max_drawdown_per_lot: number;
  lots_per_day: number;
  total: number;
  max_drawdown: number;
}

/** One scored day: ₹ per lot for each list (`A`…), 2-lot totals (`A_total`…), the base. */
export type RotationDayRow = {
  day: string;
  base: number;
  base_total: number;
} & Partial<Record<string, number | string>>;

export interface RotationSummary {
  settings: {
    lots_per_strategy: number;
    random_runs: number;
    random_seed: number;
    bootstrap_resamples: number;
    bootstrap_block_days: number;
    bootstrap_seed: number;
    interval: number;
    basis: string;
  };
  n_days: number;
  first_day: string | null;
  last_day: string | null;
  pending_days: string[];
  pending_reasons: Record<string, string>;
  late_entries: string[];
  short: boolean;
  lists: Partial<Record<RotationListKey, RotationListStats>>;
  base: RotationBase | null;
  days?: RotationDayRow[];
}
