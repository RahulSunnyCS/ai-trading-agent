/**
 * TypeScript interfaces for every database table in the AI Trading Agent schema.
 *
 * Conventions:
 * - Interface names are the PascalCase singular of the table name.
 * - Property names match the exact column names from the SQL migration.
 * - TIMESTAMPTZ → Date  (the `pg` driver automatically parses these)
 * - DATE        → Date  (same — pg returns a Date object for DATE columns)
 * - TEXT        → string
 * - NUMERIC, INTEGER, BIGINT → number  (or string for financial precision fields
 *   when pg.types.setTypeParser(1700) returns raw strings — callers must be aware)
 * - BOOLEAN     → boolean
 * - JSONB       → unknown  (shape varies by rule type; callers narrow as needed)
 * - Nullable columns are typed as `T | null` (strictNullChecks is on)
 * - TIME columns → string  (pg returns TIME as "HH:MM:SS" string, not Date)
 *
 * No ORM imports. No default exports (project convention).
 *
 * IMPORTANT — NUMERIC columns in financial context:
 * The pg client is configured with `pg.types.setTypeParser(1700, val => val)`
 * in src/db/client.ts. OID 1700 is the PostgreSQL NUMERIC type. This parser
 * returns the raw wire-format string instead of coercing it to a JS float.
 * Typing these columns as `number` would be a lie for callers that receive
 * a string at runtime. Callers must use string arithmetic or a decimal library
 * (e.g. `decimal.js`) for any precision math. Some interfaces use `number`
 * where the upstream code from the payment branch expects numbers — those
 * callers should be aware of the potential for precision loss.
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
  /**
   * Candle resolution when source = 'fyers-historical' (migration 007).
   * NULL for all live rows (source = 'fyers' | 'simulator').
   * Example values: '1', '5', '15', 'D' (matches FyersResolution in fyers-historical.ts).
   */
  resolution: string | null;
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
  /**
   * Data source tag added by migration 007.
   * 'fyers'           — live WebSocket tick
   * 'fyers-historical' — historical backfill candle (written by backfill.ts)
   * Existing rows receive the default value 'fyers' at migration time.
   */
  source: string;
  /**
   * Candle resolution when source = 'fyers-historical' (migration 007).
   * NULL for all live rows (source = 'fyers').
   * Example values: '1', '5', '15', 'D' (matches FyersResolution in fyers-historical.ts).
   */
  resolution: string | null;
}

// ---------------------------------------------------------------------------
// Historical backfill tracking (migration 007)
// ---------------------------------------------------------------------------

/** Valid values for BackfillRange.status */
export type BackfillRangeStatus =
  | 'pending'   // Queued but not yet started
  | 'running'   // Currently executing (stale detection: check updated_at + timeout)
  | 'partial'   // Interrupted (FyersAuthError); resume from checkpoint_ts
  | 'complete'  // All candles written; NO calendar gaps detected
  | 'gapped'    // All candles written but calendar gaps were found; see gaps_json
  | 'error';    // Non-resumable failure

/**
 * One row in the backfill_ranges table.
 *
 * Tracks the progress of a historical candle backfill job for one
 * (symbol, from_ts, to_ts, resolution) range. Used by the backfill writer
 * in src/ingestion/historical/backfill.ts to implement resumable downloads
 * and calendar-gap recording.
 *
 * Invariant: if gaps_detected > 0, status MUST be 'partial' or 'gapped',
 * NEVER 'complete'. The writer enforces this; the CHECK constraint in
 * migration 007 provides a database-level guard.
 */
export interface BackfillRange {
  id: number;
  symbol: string;
  from_ts: Date;
  to_ts: Date;
  resolution: string;
  status: BackfillRangeStatus;
  rows_written: number;
  /**
   * Timestamp of the last successfully persisted candle.
   * NULL if no candles have been written yet (start from from_ts on resume).
   * Set by the writer on FyersAuthError so a re-run continues from here.
   */
  checkpoint_ts: Date | null;
  /**
   * Number of calendar gaps detected during NSE-calendar reconciliation.
   * When > 0, status must be 'partial' or 'gapped' — never 'complete'.
   */
  gaps_detected: number;
  /**
   * JSON-serialised array of gap records: [{ from: string, to: string, reason: string }].
   * NULL when no gaps were detected.
   * Parse with JSON.parse(gaps_json) and cast to GapRecord[].
   */
  gaps_json: string | null;
  updated_at: Date;
  created_at: Date;
}

/**
 * A single calendar gap record as stored in BackfillRange.gaps_json.
 * from and to are ISO-8601 strings (not Date objects) because the field is
 * stored as a JSON TEXT column — callers must new Date(gap.from) to get a Date.
 */
export interface BackfillGapRecord {
  from: string;
  to: string;
  reason: string;
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
  personality_id: string | null;
  signal_id: string | null;
  symbol: string;
  expiry: Date | null;
  strike: number | null;
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

/**
 * Legacy OpenPosition shape used by PositionMonitor in the milestones-0-1 branch.
 * Kept for backward compatibility with trigger-engine.ts which references these fields.
 */
export interface OpenPosition {
  id: string;
  entryStraddleValue: string;
  lowestStraddleValueSeen: string;
  entryTimeMs: number;
  todayNetPnl: string;
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
// Payment / access-control interfaces (UPI/Razorpay integration)
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
