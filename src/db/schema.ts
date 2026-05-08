// TypeScript types matching the database schema.
// These are plain data types — no ORM, no magic.

export type Underlying = 'NIFTY' | 'BANKNIFTY' | 'SENSEX';
export type OptionType = 'CE' | 'PE';
export type SignalType = 'MOMENTUM_EXHAUSTION' | 'SCHEDULED' | 'PULLBACK';
export type MarketRegime = 'RANGING' | 'TRENDING_STRONG' | 'VOLATILE_REVERTING' | 'EVENT_DAY';
export type TradeStatus = 'open' | 'closed' | 'stopped';
export type ExitReason = 'TARGET' | 'SL' | 'TSL' | 'EOD' | 'MANUAL';
export type EntryType = 'FIXED_TIME' | 'MOMENTUM_EXHAUSTION' | 'ANY_SIGNAL' | 'SR_ANCHORED';
export type ManagementStyle = 'HOLD' | 'ROLL' | 'CUT_REENTER';
export type ConfidenceTier = 'LOW' | 'MEDIUM' | 'HIGH';
export type MgmtVerdict = 'HELPED' | 'HURT' | 'NEUTRAL';

export interface MarketTick {
  time: Date;
  symbol: string;
  underlying: Underlying;
  expiry?: Date;
  strike?: number;
  option_type?: OptionType;
  ltp: number;
  bid?: number;
  ask?: number;
  volume?: number;
  oi?: number;
}

export interface StraddleSnapshot {
  time: Date;
  underlying: Underlying;
  expiry: Date;
  atm_strike: number;
  ce_ltp?: number;
  pe_ltp?: number;
  straddle_value?: number;
  straddle_change_pct?: number;
  roc?: number;
  acceleration?: number;
  vix?: number;
}

export interface StraddleSignal {
  id: string;
  created_at: Date;
  underlying: Underlying;
  expiry: Date;
  signal_time: Date;
  signal_type: SignalType;
  atm_strike: number;
  straddle_value?: number;
  expansion_pct?: number;
  probability?: number;
  confidence_tier?: ConfidenceTier;
  trigger_layer?: string;
  status: string;
  actual_peak_value?: number;
  actual_peak_time?: Date;
  signal_to_peak_gap_pct?: number;
}

export interface ExternalSignal {
  id: string;
  recorded_at: Date;
  signal_date: Date;
  signal_type: 'FII_DII' | 'GLOBAL_CUES' | 'SENTIMENT' | 'CALENDAR' | 'VIX';
  source?: string;
  data: Record<string, unknown>;
  relevance?: number;
}

export interface PersonalityConfig {
  id: string;
  name: string;
  version: number;
  is_active: boolean;
  is_frozen: boolean;
  created_at: Date;
  entry_type: EntryType;
  management_style: ManagementStyle;
  phase: number;
  min_probability?: number;
  max_daily_trades: number;
  max_daily_loss: number;
  entry_delay_secs: number;
  position_multiplier: number;
  adjustment_trigger_points?: number;
  max_open_legs?: number;
  reentry_min_probability?: number;
  min_vix: number;
  max_vix: number;
  require_profit_gate: boolean;
  profit_gate_amount?: number;
  profit_gate_days?: number;
  allow_reentry: boolean;
  reentry_delay_mins?: number;
  allowed_regimes?: MarketRegime[];
  allowed_strategies?: number[];
  cached_win_rate?: number;
  cached_sharpe?: number;
  cached_total_trades?: number;
  cache_updated_at?: Date;
  evolved_from?: string;
  evolution_reason?: string;
}

export interface PaperTrade {
  id: string;
  personality_id?: string;
  signal_id?: string;
  strategy_id: number;
  underlying: Underlying;
  expiry: Date;
  entry_time: Date;
  exit_time?: Date;
  status: TradeStatus;
  exit_reason?: ExitReason;
  entry_ce_strike?: number;
  entry_ce_price?: number;
  exit_ce_price?: number;
  entry_pe_strike?: number;
  entry_pe_price?: number;
  exit_pe_price?: number;
  lots: number;
  position_multiplier: number;
  gross_pnl?: number;
  net_pnl?: number;
  max_drawdown?: number;
  max_favorable_excursion?: number;
  vix_at_entry?: number;
  spot_at_entry?: number;
  straddle_at_entry?: number;
  market_regime?: MarketRegime;
  has_event_flag: boolean;
}

export interface RetrospectionResult {
  id: string;
  analysis_date: Date;
  personality_id: string;
  run_at: Date;
  market_regime: MarketRegime;
  vix_open?: number;
  index_move_pct?: number;
  total_trades?: number;
  winning_trades?: number;
  losing_trades?: number;
  win_rate?: number;
  total_pnl?: number;
  avg_pnl_per_trade?: number;
  max_drawdown?: number;
  sharpe_ratio?: number;
  clockwork_pnl_today?: number;
  beat_clockwork_by?: number;
  signals_received?: number;
  signals_acted_on?: number;
  signal_brier_score?: number;
  adjustments_made?: number;
  mgmt_pnl_delta?: number;
  mgmt_verdict?: MgmtVerdict;
  threshold_drift_flag: boolean;
  evolution_paused: boolean;
  insights?: Record<string, unknown>;
  suggested_changes?: Record<string, unknown>;
  applied: boolean;
  applied_at?: Date;
}
