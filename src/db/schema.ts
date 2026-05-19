/**
 * TypeScript interfaces for every database table in the AI Trading Agent schema.
 *
 * Conventions:
 * - Interface names are the PascalCase singular of the table name.
 * - Property names match the exact column names from the SQL migration.
 * - TIMESTAMPTZ → Date  (the `pg` driver automatically parses these)
 * - DATE        → Date  (same — pg returns a Date object for DATE columns)
 * - TEXT        → string
 * - NUMERIC, INTEGER, BIGINT → number
 * - BOOLEAN     → boolean
 * - JSONB       → unknown  (shape varies by rule type; callers narrow as needed)
 * - Nullable columns are typed as `T | null` (strictNullChecks is on)
 * - TIME columns → string  (pg returns TIME as "HH:MM:SS" string, not Date)
 *
 * No ORM imports. No default exports (project convention).
 */

// ---------------------------------------------------------------------------
// Hypertable interfaces
// ---------------------------------------------------------------------------

export interface MarketTick {
  id: number;
  symbol: string;
  time: Date;
  ltp: number;
  volume: number | null;
  oi: number | null;
  bid: number | null;
  ask: number | null;
  source: string;
}

export interface StraddleSnapshot {
  id: number;
  time: Date;
  symbol: string;
  expiry: Date;
  strike: number;
  call_ltp: number;
  put_ltp: number;
  straddle_value: number;
  roc: number | null;
  roc_acceleration: number | null;
  vix: number | null;
}

export interface OptionTick {
  id: number;
  time: Date;
  symbol: string;
  ltp: number;
  volume: number | null;
  oi: number | null;
  delta: number | null;
  iv: number | null;
}

// ---------------------------------------------------------------------------
// Regular table interfaces
// ---------------------------------------------------------------------------

/** Valid values for StraddleSignal.signal_type */
export type SignalType = 'MOMENTUM_EXHAUSTION' | 'SCHEDULED' | 'PULLBACK';

/** Valid values for StraddleSignal.direction and trade direction fields */
export type TradeDirection = 'LONG' | 'SHORT';

/** Valid values for StraddleSignal.status */
export type SignalStatus = 'pending' | 'consumed' | 'expired';

export interface StraddleSignal {
  id: string;
  time: Date;
  symbol: string;
  signal_type: SignalType;
  direction: TradeDirection | null;
  probability: number | null;
  peak_roc: number | null;
  peak_acceleration: number | null;
  vix_at_signal: number | null;
  status: SignalStatus;
  created_at: Date;
}

/** Valid values for PersonalityConfig.management_style */
export type ManagementStyle = 'HOLD' | 'ADJUST' | 'REDUCE';

export interface PersonalityConfig {
  id: string;
  name: string;
  description: string | null;
  phase: number;
  is_frozen: boolean;
  entry_type: string;
  management_style: ManagementStyle;
  min_probability: number;
  sl_pct: number;
  target_pct: number;
  tsl_trigger_pct: number | null;
  max_daily_loss_pct: number;
  entry_window_start: string; // TIME column — pg returns "HH:MM:SS"
  entry_window_end: string;
  exit_time: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

/** Valid values for exit_reason and market_regime across paper_trades / retrospection */
export type ExitReason = 'SL' | 'TSL' | 'TARGET' | 'EOD' | 'TIME' | 'DAILY_LOSS_CAP' | 'MANUAL';

export type MarketRegime = 'RANGING' | 'TRENDING_STRONG' | 'VOLATILE_REVERTING' | 'EVENT_DAY';

/** Valid values for PaperTrade.status */
export type TradeStatus = 'open' | 'closed';

export interface PaperTrade {
  id: string;
  personality_id: string;
  signal_id: string | null;
  symbol: string;
  expiry: Date;
  strike: number;
  entry_type: string;
  entry_time: Date;
  entry_straddle_value: number;
  exit_time: Date | null;
  exit_straddle_value: number | null;
  exit_reason: ExitReason | null;
  pnl_pct: number | null;
  pnl_abs: number | null;
  status: TradeStatus;
  market_regime: MarketRegime | null;
  created_at: Date;
  updated_at: Date;
}

export interface RetrospectionResult {
  id: string;
  personality_id: string;
  trade_date: Date;
  market_regime: MarketRegime;
  total_trades: number;
  winning_trades: number;
  total_pnl_pct: number | null;
  beat_clockwork_delta: number | null;
  signal_brier_score: number | null;
  management_effectiveness: number | null;
  proposed_adjustments: unknown | null; // JSONB — shape varies by rule type
  adjustments_applied: boolean;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Continuous aggregate interface
// ---------------------------------------------------------------------------

/** One row of the straddle_1min continuous aggregate view. */
export interface Straddle1Min {
  bucket: Date; // time_bucket('1 minute', time)
  symbol: string;
  expiry: Date;
  strike: number;
  open: number;
  high: number;
  low: number;
  close: number;
  avg_roc: number | null; // nullable because roc itself is nullable
  avg_vix: number | null; // nullable because vix is not always available
}
