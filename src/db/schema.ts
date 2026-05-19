/**
 * TypeScript interfaces for every database table in the AI Trading Agent schema.
 *
 * IMPORTANT — NUMERIC columns are typed as `string`, not `number`.
 *
 * Reason: the pg client is configured with `pg.types.setTypeParser(1700, val => val)`
 * in src/db/client.ts. OID 1700 is the PostgreSQL NUMERIC type. This parser
 * returns the raw wire-format string instead of coercing it to a JS float.
 * Typing these columns as `number` would be a lie: callers receive a string at
 * runtime and must use string arithmetic or a decimal library (e.g. `decimal.js`)
 * for any precision math. Using `number` would silently introduce floating-point
 * rounding errors in P&L calculations, which are unacceptable in a trading context.
 *
 * All column names are camelCase to match TypeScript conventions. The pg driver
 * returns column names in lowercase by default, so the SQL column names use
 * snake_case and callers alias or map as needed when the column name differs
 * from camelCase.
 *
 * Additional interfaces from the payment/access-control system (migration 003+)
 * are also declared here.
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

/**
 * Public interface for paper trade records as consumed by the trading engine.
 *
 * Column name mapping from the DB schema:
 *   symbol              → underlying
 *   expiry              → expiryDate (ISO 'YYYY-MM-DD' string)
 *   strike              → atmStrike
 *   entry_time          → entryTimestamp
 *   pnl_abs             → pnl
 *
 * The DB schema uses short column names for query efficiency; this interface
 * uses descriptive names for readability in business logic.
 */
export interface PaperTradeRecord {
  id: string;
  underlying: string;
  /** ISO date string 'YYYY-MM-DD'. */
  expiryDate: string;
  atmStrike: number;
  entryStraddleValue: number;
  exitStraddleValue: number | null;
  entryTimestamp: Date;
  exitTimestamp: Date | null;
  exitReason: string | null;
  /** Short-straddle absolute P&L: entryStraddleValue - exitStraddleValue. Null until closed. */
  pnl: number | null;
  status: 'open' | 'closed';
  entryType: string;
  personalityId: string | null;
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

// ---------------------------------------------------------------------------
// M2 legacy interfaces (camelCase, used by position-monitor and other M2 code)
// ---------------------------------------------------------------------------

/**
 * One trading personality — camelCase version used by M2 trading engine code.
 * Maps to the same personality_configs table as PersonalityConfig above.
 */
export interface PersonalityConfigM2 {
  id: string;
  name: string;
  displayName: string;
  groupType: "reference" | "learning";
  entryType: "fixed_time" | "momentum_exhaustion" | "any_signal" | "sr_anchored";
  managementStyle: "hold" | "roll" | "cut_reenter";
  isFrozen: boolean;
  isActive: boolean;
  phase: number;
  params: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One immutable audit record capturing a parameter change on a personality.
 */
export interface PersonalityAuditLog {
  id: string;
  personalityId: string;
  changedAt: Date;
  changedBy: string;
  oldParams: Record<string, unknown>;
  newParams: Record<string, unknown>;
  reason: string | null;
}

/**
 * One signal event produced by the peak detection engine (M2 camelCase version).
 */
export interface StraddleSignalM2 {
  id: string;
  time: Date;
  underlying: string;
  signalType: "MOMENTUM_EXHAUSTION" | "SCHEDULED" | "PULLBACK";
  atmStrike: string;
  spot: string;
  straddleValue: string;
  vix: string | null;
  rawExhaustionScore: string | null;
  adjustedProbability: string;
  confidenceTier: "HIGH" | "MEDIUM" | "LOW";
  expansionPct: string | null;
  rocDeclineCandles: number | null;
  accelerationValue: string | null;
  adjustmentBreakdown: string | null;
}

/**
 * The in-memory shape consumed by the trigger engine to evaluate
 * whether an open position should be closed, rolled, or held.
 */
export interface OpenPosition {
  id: string;
  entryStraddleValue: string;
  lowestStraddleValueSeen: string;
  entryTimeMs: number;
  todayNetPnl: string;
}

// ---------------------------------------------------------------------------
// Payment / access-control interfaces (migration 003+)
// ---------------------------------------------------------------------------

export type GrantType = 'monthly_pass' | 'credits_pack';
export type GrantStatus = 'pending' | 'paid' | 'active' | 'expired';

export interface AccessGrant {
  id: string;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  grant_type: GrantType;
  days_granted: number;
  expires_at: Date | null;
  status: GrantStatus;
  created_at: Date;
  updated_at: Date;
}

export interface CreditTransaction {
  id: string;
  razorpay_order_id: string;
  credits_delta: number;
  feature: string | null;
  created_at: Date;
}

export interface ProcessedWebhookEvent {
  razorpay_event_id: string;
  processed_at: Date;
}
