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
  /**
   * Candle resolution tag added by migration 008 (T-33).
   * Populated only for historically reconstructed rows (via T-56 reconstructor).
   * NULL for live rows (source = 'fyers' | 'simulator').
   * Example values: '1' (1-min), '5' (5-min), '15' (15-min), 'D' (daily).
   * Persisting this here closes the T-56 gap: reconstruct-straddle.ts computed
   * the resolution per snapshot but had no DB column to store it previously.
   */
  resolution: string | null;
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
  | 'pending' // Queued but not yet started
  | 'running' // Currently executing (stale detection: check updated_at + timeout)
  | 'partial' // Interrupted (FyersAuthError); resume from checkpoint_ts
  | 'complete' // All candles written; NO calendar gaps detected
  | 'gapped' // All candles written but calendar gaps were found; see gaps_json
  | 'error'; // Non-resumable failure

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

/**
 * @deprecated M1 shape — not present on fresh installs; use StraddleSignalM2.
 * Valid values for StraddleSignal.status (M1 schema only).
 */
export type SignalStatus = 'pending' | 'consumed' | 'expired';

/**
 * @deprecated M1 shape — not present on fresh installs; use StraddleSignalM2.
 * Signal row as stored in the M1 straddle_signals table schema.
 */
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
  /**
   * S/R signal subtype added by migration 012.
   * NULL for all non-S/R signals (MOMENTUM_EXHAUSTION, SCHEDULED).
   * 'SR_REVERSAL' = price rejected at a support/resistance level.
   * TEXT CHECK rather than enum keeps DDL fully transactional and reversible.
   */
  sr_subtype: 'SR_REVERSAL' | null;
  /**
   * Continuous confidence score [0.0, 1.0] measuring how strongly price
   * reacted at the S/R level. NULL for non-S/R signals.
   * The pg NUMERIC column is returned as a string when the numeric type
   * parser is set to raw-string mode; callers must parseFloat() for math.
   */
  sr_strength: string | null;
  /**
   * TRUE when the Point of Control (POC) of the session's volume profile
   * contributed to the S/R level used for this signal.
   * NULL (not FALSE) for non-S/R signals to avoid misleading semantics.
   */
  poc_used: boolean | null;
  /**
   * JSONB blob describing which S/R levels were consulted and their weights.
   * Example: {"levels": [{"price": 22500, "type": "swing_high", "weight": 0.8}]}
   * NULL for non-S/R signals. Shape is open-ended — the S/R engine's level
   * taxonomy will evolve in Phase 2. Typed as unknown; callers narrow as needed.
   */
  level_source: unknown | null;
}

/**
 * @deprecated M1 shape — not present on fresh installs; use PersonalityConfigM2 (which uses managementStyle: 'hold' | 'roll' | 'cut_reenter').
 * Valid values for PersonalityConfig.management_style (M1 schema only).
 */
export type ManagementStyle = 'HOLD' | 'ADJUST' | 'REDUCE';

// M2 columns (display_name, group_type, params, last_evolved_at, evolution_consecutive_applications) are on PersonalityConfigM2, not here.
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
  /**
   * The bare underlying index name, e.g. 'NIFTY', 'BANKNIFTY', 'SENSEX'.
   * Added by migration 015. NULL for rows inserted before the migration or
   * before trade-executor.ts is updated to populate this field on new inserts.
   *
   * The `symbol` column holds the full Fyers option symbol such as
   * 'NSE:NIFTY25O0924500CE'; `underlying` holds just the index name so
   * per-index queries (daily stop, open-leg cap) can filter efficiently
   * without substring matching on every row.
   */
  underlying: string | null;
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
  /** Risk-adjusted return for the day. NULL when fewer than 2 trades (std dev undefined). Added by migration 010. */
  sharpe: number | null;
  /** Peak-to-trough intraday drawdown as a percentage of notional. NULL when no trades. Added by migration 010. */
  max_drawdown_pct: number | null;
  /** Wall-clock time when the evolution rule engine queued proposed_adjustments. NULL until the rule engine has run. Added by migration 010. */
  proposed_adjustments_at: Date | null;
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
// Regime tagging interfaces (migration 008, T-33)
// ---------------------------------------------------------------------------

/**
 * Valid values for DailyRegimeTag.regime.
 *
 * The four core regimes (RANGING, TRENDING_STRONG, VOLATILE_REVERTING,
 * EVENT_DAY) are the same values used in paper_trades.market_regime and
 * retrospection_results.market_regime. UNCLASSIFIED is an additional value
 * emitted when the day's data is too sparse or gapped to classify reliably.
 *
 * Precedence (highest first): EVENT_DAY > VOLATILE_REVERTING > TRENDING_STRONG > RANGING.
 * UNCLASSIFIED is not a regime — it is a sentinel meaning "insufficient data".
 */
export type RegimeTagValue =
  | 'RANGING'
  | 'TRENDING_STRONG'
  | 'VOLATILE_REVERTING'
  | 'EVENT_DAY'
  | 'UNCLASSIFIED';

/**
 * One row in the daily_regime_tags table (migration 008).
 *
 * Written by the regime tagging engine (src/trading/regime-tagging.ts) after
 * classifying each reconstructed trading day. One row per (trade_date, symbol).
 *
 * regime_confidence [0.0, 1.0]:
 *   - EVENT_DAY: always 1.0 (calendar lookup is deterministic).
 *   - UNCLASSIFIED: data-present fraction (lower = more data missing).
 *   - Other regimes: fraction of intraday windows that agreed with the label.
 *
 * classified_at: wall-clock time the row was written. Use this to detect
 * stale classifications after a data reingestion.
 */
export interface DailyRegimeTag {
  id: number;
  trade_date: Date; // DATE column — pg returns a Date at midnight UTC
  symbol: string;
  regime: RegimeTagValue;
  /**
   * Classification confidence [0.0, 1.0].
   * The pg NUMERIC(5,4) column is returned as a string by the pg client
   * (when the numeric parser is set to raw-string mode). Callers must
   * parseFloat() if they need arithmetic.
   */
  regime_confidence: number;
  classified_at: Date;
}

/**
 * Valid event types for the event_calendar table (migration 008).
 *
 * This is not an exhaustive CHECK constraint in the DB (TEXT column is open-
 * ended so operators can add custom types). These are the seed values.
 */
export type EventCalendarType =
  | 'RBI_POLICY'
  | 'UNION_BUDGET'
  | 'FNO_EXPIRY'
  | 'STATE_ELECTION'
  | 'HOLIDAY'
  | string; // open-ended for operator extensions

/**
 * One row in the event_calendar table (migration 008).
 *
 * A checked-in, dated table of known Indian market event days. Used by the
 * regime tagging engine to assign EVENT_DAY without relying on the live
 * BLOCKED_DATES env var (which is not reproducible in historical backtests).
 *
 * Multiple rows per event_date are allowed (e.g. F&O expiry + RBI policy on
 * the same day). The regime engine treats any matching row as EVENT_DAY.
 *
 * UNIQUE constraint: (event_date, event_type) — prevents duplicate seeding.
 */
export interface EventCalendarEntry {
  id: number;
  event_date: Date; // DATE column — pg returns midnight UTC Date
  event_type: EventCalendarType;
  description: string | null;
}

// ---------------------------------------------------------------------------
// Payment / access-control interfaces (UPI/Razorpay integration)
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
  groupType: 'reference' | 'learning';
  entryType: 'fixed_time' | 'momentum_exhaustion' | 'any_signal' | 'sr_anchored';
  managementStyle: 'hold' | 'roll' | 'cut_reenter';
  isFrozen: boolean;
  isActive: boolean;
  phase: number;
  params: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  /** Wall-clock time of the most recent automated parameter change. NULL if this personality has never been evolved. Added by migration 010. Optional so pre-010 test fixtures compile. */
  lastEvolvedAt?: Date | null;
  /** Number of consecutive evolution rule applications accepted without an intervening losing day. Added by migration 010. Optional so pre-010 test fixtures compile. */
  evolutionConsecutiveApplications?: number;
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
  signalType: 'MOMENTUM_EXHAUSTION' | 'SCHEDULED' | 'PULLBACK';
  atmStrike: string;
  spot: string;
  straddleValue: string;
  vix: string | null;
  rawExhaustionScore: string | null;
  adjustedProbability: string;
  confidenceTier: 'HIGH' | 'MEDIUM' | 'LOW';
  expansionPct: string | null;
  rocDeclineCandles: number | null;
  accelerationValue: string | null;
  adjustmentBreakdown: string | null;
  /**
   * S/R signal subtype added by migration 012.
   * NULL for all non-S/R signals (MOMENTUM_EXHAUSTION, SCHEDULED).
   * 'SR_REVERSAL' = price rejected at a support/resistance level.
   * Optional so pre-012 code and test fixtures that construct StraddleSignalM2
   * objects without this field continue to compile.
   */
  srSubtype?: 'SR_REVERSAL' | null;
  /**
   * Continuous confidence score [0.0, 1.0] for S/R level strength.
   * Returned as a raw string from the pg NUMERIC column.
   * NULL for non-S/R signals.
   */
  srStrength?: string | null;
  /**
   * TRUE when the Point of Control of the session volume profile contributed
   * to the S/R level. NULL (not FALSE) for non-S/R signals.
   */
  pocUsed?: boolean | null;
  /**
   * JSONB blob of S/R levels consulted and their weights.
   * NULL for non-S/R signals. Shape is open-ended; callers narrow as needed.
   */
  levelSource?: unknown | null;
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

// ---------------------------------------------------------------------------
// Index expiry calendar (migration 013)
// ---------------------------------------------------------------------------

/**
 * One row in the index_expiry_calendar table.
 *
 * Stores weekly options expiry dates per underlying index so the S/R signal
 * engine and regime tagger can determine proximity-to-expiry without relying
 * on the non-reproducible BLOCKED_DATES env var.
 *
 * PRIMARY KEY is (underlying, expiry_date) — no surrogate key because the
 * natural composite key is sufficient and always used in queries.
 *
 * expiry_date: the DATE column is returned by pg as a Date object at midnight
 * UTC. Callers that need just the ISO date string should use
 * expiry_date.toISOString().slice(0, 10).
 *
 * is_holiday_shifted: TRUE means the exchange moved this expiry off its
 * normal weekday (e.g. Thursday for Nifty) to an adjacent trading day due to
 * a public holiday. Lets downstream code distinguish a shifted expiry from a
 * normal one without checking the day-of-week explicitly.
 *
 * Weekly expiry weekdays per index (as of exchange circulars known up to
 * August 2025 — VERIFY against live NSE/BSE instrument master before use):
 *   NIFTY    → Thursday  (NSE circular, effective Nov 2024)
 *   BANKNIFTY → Wednesday (NSE circular NSCCL/CMPT/56550, effective Sep 2023)
 *   SENSEX   → Friday    (BSE notice 20230801-50, effective Aug 2023)
 */
export interface IndexExpiryCalendar {
  underlying: string;
  expiry_date: Date;
  is_holiday_shifted: boolean;
}
