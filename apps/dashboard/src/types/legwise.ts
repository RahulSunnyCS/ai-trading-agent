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

// ---------------------------------------------------------------------------
// Day forensics + anatomy — mirror legwise/forensics.py and legwise/anatomy.py
// ---------------------------------------------------------------------------

/** `ts` is the IST wall-clock read as UTC seconds, so a UTC chart axis shows 09:15..15:29. */
export interface TimedValue {
  ts: number;
  t: string;
  v: number;
}

export type SegmentLabel = 'QUIET' | 'CHOP' | 'TREND_UP' | 'TREND_DOWN' | 'UNKNOWN';

export interface AnatomySegment {
  start: string;
  end: string;
  ret_pct: number;
  range_pct: number;
  er: number;
  /** er × √bars: times more directional than a random walk (chance ≈ 1). */
  strength: number;
  rv_ann_pct: number | null;
  implied_pct: number | null;
  range_over_implied: number | null;
  label: SegmentLabel;
}

export interface DayAnatomy {
  day: string;
  weekday: string;
  gap_pct: number | null;
  vix_open: number | null;
  /** null before 2025-09-01: the reference expiry calendar is not trustworthy earlier. */
  dte: number | null;
  is_expiry: boolean | null;
  whole: AnatomySegment | null;
  segments: (AnatomySegment | null)[];
  /** apps/server's T-33 whole-day regime tag, when the API process can read Postgres. */
  t33?: string | null;
}

export interface AnatomyResponse {
  underlying: string;
  cuts: string[];
  thresholds: { quiet_range_over_implied: number; trend_strength: number };
  dte_reliable_from: string;
  t33: { status: 'unavailable' | 'empty' | 'ok' | 'error'; message: string | null };
  days: DayAnatomy[];
}

export interface ForensicsMarker {
  ts: number;
  kind: 'entry' | 'exit';
  leg: string;
  price: number;
  position?: 'buy' | 'sell';
  reason?: string;
}

export interface LegAttribution {
  leg: string;
  trades: number;
  gross: number;
  costs: number;
  net: number;
  sl_hits: number;
  target_hits: number;
  reentries: number;
}

export interface DayForensics {
  strategy_id: string;
  sha: string;
  day: string;
  underlying: string;
  gross: number;
  costs: number;
  net: number;
  worst_mtm: number;
  best_mtm: number;
  stopped_by: string | null;
  notes: string[];
  lots: number;
  net_per_lot: number;
  window: { start: string; end: string };
  mtm: TimedValue[];
  spot: TimedValue[];
  legs: { leg: string; contract: string; entry: string; exit: string; premium: TimedValue[] }[];
  markers: ForensicsMarker[];
  attribution: LegAttribution[];
  trades: TradeRow[];
  cuts: { ts: number; t: string }[];
  anatomy: DayAnatomy | null;
}
