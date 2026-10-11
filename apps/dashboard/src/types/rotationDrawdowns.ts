/**
 * `GET /legwise/rotation/drawdowns` (rotation/drawdowns.py): a list's drawdown episodes against
 * the fixed base. Gross, per lot-day; hand-written, the dashboard imports nothing from Python.
 */

export type DrawdownWindowId = 'P1' | 'P2' | 'last63' | 'forward';

export interface DrawdownDriver {
  kind: string;
  band: string;
  label: string;
  /** Rupees per lot over the episode's peak-to-trough days (negative is a loss). */
  total: number;
  pick_days: number;
}

export interface DrawdownEpisode {
  n: number;
  /** The last day at the running peak; null when the series began underwater. */
  peak_day: string | null;
  trough_day: string;
  /** The first day back at the peak; null while the episode is open. */
  end_day: string | null;
  open: boolean;
  /** Rupees per lot below the peak at the trough (negative). */
  depth: number;
  /** The same fall for the lots the list held (2 per strategy). */
  depth_basket: number | null;
  sessions_down: number;
  sessions_back: number | null;
  /** The fixed base's per-lot P&L over the same peak-to-trough days; null when it has none. */
  base_change: number | null;
  base_missing: number;
  stops: number;
  drivers: DrawdownDriver[];
}

export interface DrawdownPoint {
  day: string;
  source: 'recorded' | 'reconstructed';
  per_lot: number;
  cum: number;
  underwater: number;
  base_per_lot: number | null;
  base_underwater: number | null;
  /** Only with a portfolio stop (BL-095): the same day through the stop. */
  per_lot_with?: number;
  cum_with?: number;
  underwater_with?: number;
  /** The book closed at the portfolio stop (or a lock) that day. */
  stopped?: boolean;
}

/** The series run through the portfolio stop, beside the registered figures. */
export interface DrawdownWithStop {
  setting: { amount: number | null; trail: string | null };
  /** Worst fall per lot with the stop (negative). */
  max_dd: number;
  total_per_lot: number;
  total_per_lot_without: number;
  days_stopped: number;
  /** Days that could not be replayed and kept their registered figure. */
  replay_errors: number;
  episodes: number;
  all_episodes: number;
  current: { underwater: number } | null;
}

export interface RotationDrawdownsResponse {
  list: 'A' | 'B' | 'C' | 'REF';
  window: { id: DrawdownWindowId; label: string; from: string | null; to: string | null };
  min_depth: number;
  n_days: number;
  recorded_days: number;
  reconstructed_days: number;
  left_out: { late: number; waiting: number; no_entry: number };
  lots: number[];
  base_lots: number;
  series: DrawdownPoint[];
  episodes: DrawdownEpisode[];
  /** Every episode at any depth, so the page can say how many the threshold hid. */
  all_episodes: number;
  max_dd: number;
  base_max_dd: number | null;
  base_days: number;
  current: { underwater: number; since: string | null; sessions: number } | null;
  basis: 'gross';
  unit: 'per_lot';
  in_sample: boolean;
  /** null (or absent) when no portfolio stop was asked for. */
  with_stop?: DrawdownWithStop | null;
  /** True while the stopped replay is still running: the registered figures are complete and
   * `with_stop` is null; the hook asks again. */
  with_stop_pending?: boolean;
}
