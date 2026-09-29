/**
 * Types for the Options Lab tab — mirrors packages/option-backtesting's
 * legwise/schema.py (the strategy) and api/legwise_routes.py (responses).
 * The Python side is the validator; these types only shape the form.
 */

export type Underlying = 'NIFTY' | 'BANKNIFTY' | 'MIDCPNIFTY' | 'FINNIFTY' | 'SENSEX';

export interface Amount {
  points?: number | undefined;
  percent?: number | undefined;
}

export interface TrailSL {
  points?: [number, number] | undefined;
  percent?: [number, number] | undefined;
}

export interface ReEntry {
  mode: 'asap' | 'cost';
  count: number;
}

export interface RangeBreakout {
  until: string;
  side: 'high' | 'low';
  source: 'instrument' | 'underlying';
}

export interface Leg {
  id: string;
  lots: number;
  position: 'buy' | 'sell';
  option_type: 'CE' | 'PE';
  expiry: 'weekly' | 'next_weekly' | 'monthly';
  strike: { strike_type?: string | undefined; closest_premium?: number | undefined };
  stop_loss?: Amount | undefined;
  target?: Amount | undefined;
  trail_sl?: TrailSL | undefined;
  reentry_on_sl?: ReEntry | undefined;
  reentry_on_target?: ReEntry | undefined;
  range_breakout?: RangeBreakout | undefined;
}

export interface LegwiseStrategy {
  id: string;
  underlying: Underlying;
  entry_time: string;
  exit_time: string;
  no_reentry_after?: string | undefined;
  square_off: 'partial' | 'complete';
  legs: Leg[];
  overall: { stop_loss_inr?: number | undefined; target_inr?: number | undefined };
  execution: { slippage_pct: number; cost_per_order_inr: number };
}

export interface SavedStrategy {
  name: string;
  sha: string;
  strategy: LegwiseStrategy;
}

export interface TradeRow {
  leg: string;
  contract: string;
  entry: string;
  entry_price: number;
  exit: string | null;
  exit_price: number | null;
  reason: string;
  pnl: number;
}

export interface DayRow {
  day: string;
  gross: number;
  costs: number;
  net: number;
  worst_mtm: number;
  best_mtm: number;
  stopped_by: string | null;
  notes: string[];
  trades: TradeRow[];
}

export interface BacktestResponse {
  strategy_id: string;
  days: DayRow[];
}

export interface SavedResult extends DayRow {
  strategy_id: string;
  strategy_sha: string;
  current: boolean;
}

export interface ResultsResponse {
  strategies: { id: string; name: string; sha: string }[];
  results: SavedResult[];
  results_dir: string;
}

export interface DataStatus {
  data_dir: string;
  days: Record<string, string[]>;
  token: {
    ok: boolean;
    source?: string | undefined;
    expires_at?: string | null | undefined;
    message?: string | undefined;
  };
}

export interface DailyJob {
  state: 'idle' | 'running' | 'done' | 'failed';
  day: string | null;
  started: string | null;
  finished: string | null;
  log: string[];
}
