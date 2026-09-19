/**
 * Types for the Backtest tab (GET/POST /api/backtest/*).
 *
 * Unlike the trading endpoints (types/trading.ts), these responses come
 * straight from the Python FastAPI service's own pydantic models — never
 * wrapped in the `{ data }` ApiEnvelope, and numeric fields are real JSON
 * numbers (pydantic serialises floats as numbers, not NUMERIC strings).
 */

export interface PresetSummary {
  name: string;
}

export interface PresetDetail {
  name: string;
  yaml: string;
}

export interface ValidateResponse {
  valid: boolean;
  errors: string[];
  strategy_id: string | null;
  n_features: number;
  n_ladders: number;
  n_exits: number;
}

export interface SessionResult {
  date: string;
  dte: number;
  net: number;
  gross: number;
  cost: number;
  lot_days: number;
  peak_loss: number;
  total_lots: number;
}

export interface BootstrapResult {
  net_lo: number;
  net_hi: number;
  inr_per_lot_day_lo: number;
  inr_per_lot_day_hi: number;
  n_resamples: number;
  seed: number;
}

export interface MarginResult {
  strategy_type: string;
  peak_lots: number;
  peak_date: string;
  margin_per_lot_inr: number;
  peak_margin_inr: number;
  return_on_peak_margin: number;
}

export interface RunResult {
  run_id: string;
  net_inr: number;
  gross_inr: number;
  win_days: number;
  worst_day: number;
  sum_peak_loss: number;
  worst_intraday_mtm: number;
  lot_days: number;
  inr_per_lot_day: number;
  dte_buckets: Record<string, number>;
  sessions: SessionResult[];
  bootstrap: BootstrapResult | null;
  /** null when the strategy's leg shape isn't a classifiable margin
   * category, or no margin.csv row applies for the run's date range. */
  margin: MarginResult | null;
  /** null when regime data isn't available (DATABASE_URL unset server-side)
   * or no regime row applies to this window. */
  regime_buckets: Record<string, number> | null;
}

export interface RunSummary {
  run_id: string;
  strategy_id: string;
  strategy_version: number;
  strategy_hash: string;
  date_from: string;
  date_to: string;
  created_at: string;
  net_inr: number;
  win_days: number;
  worst_day: number;
  sum_peak_loss: number;
  lot_days: number;
  inr_per_lot_day: number;
  n_sessions: number;
}

/** `{ "15m": { start, end } }` — one entry per cached timeframe. */
export type CoverageResponse = Record<string, { start: string; end: string }>;
