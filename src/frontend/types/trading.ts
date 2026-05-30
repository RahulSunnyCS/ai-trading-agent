/**
 * Shared types for the trading dashboard frontend.
 *
 * All server-side NUMERIC columns arrive over the wire as strings — PostgreSQL
 * sends numeric/decimal types as string-encoded values when fetched via the
 * `pg` driver without explicit casting. We type them as `string | null` here so
 * consumers are forced to parse explicitly rather than assume a number.
 */

// ---------------------------------------------------------------------------
// API envelope
// ---------------------------------------------------------------------------

/**
 * Every JSON response from the Fastify backend wraps its payload in an object
 * with a `data` key.  When the collection is empty the server may also include
 * a human-readable `message` field (e.g. "no trades yet").
 *
 * Generic over T so callers can write ApiEnvelope<PaperTrade[]> rather than
 * repeating the outer shape.
 */
export type ApiEnvelope<T> = {
  data: T;
  message?: string;
};

// ---------------------------------------------------------------------------
// PaperTrade
// ---------------------------------------------------------------------------

/**
 * A single paper-trade row returned by GET /api/trades.
 *
 * Field naming is snake_case, matching the PostgreSQL column names sent
 * directly by the server (no camelCase transform on the backend).
 *
 * NUMERIC DB columns (prices, P&L values) are typed as `string | null`
 * because the `pg` driver serialises PostgreSQL numeric/decimal types as
 * strings.  Use `toNumberOrNull()` from format.ts to coerce before arithmetic.
 */
export interface PaperTrade {
  id: string;
  entry_time: string; // ISO-8601 UTC timestamp
  exit_time: string | null; // null while trade is still open
  status: 'open' | 'closed';

  /** Combined straddle premium at entry (CE + PE), as a numeric string. */
  straddle_at_entry: string | null;

  /** Call option premium at entry. */
  entry_ce_price: string | null;
  /** Put option premium at entry. */
  entry_pe_price: string | null;

  /** P&L before brokerage deductions, as a numeric string. */
  gross_pnl: string | null;
  /** P&L after brokerage deductions, as a numeric string. */
  net_pnl: string | null;

  /** Human-readable reason the trade was closed (e.g. "stop_loss", "target"). */
  exit_reason: string | null;

  /**
   * Number of lots traded.  Stored as an integer in the DB; arrives as a JS
   * number (not a string) because `pg` maps SQL INTEGER columns to JS numbers.
   */
  lots: number;

  /**
   * Contracts per lot (e.g. 50 for NIFTY, 15 for BankNifty).
   * Also an integer column; arrives as a JS number.
   */
  lot_size: number;

  // Allow extra fields the server might include in future without breaking
  // existing consumers.  Using an index signature with `unknown` keeps strict
  // type safety — callers must assert or narrow before using any extra field.
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Personalities (GET /api/personalities)
// ---------------------------------------------------------------------------

/**
 * A single personality row returned by GET /api/personalities.
 *
 * Field naming is snake_case, matching the raw PostgreSQL column names sent
 * directly by the server (the personalities endpoint does NOT camelCase-map
 * like the M2 plugin does — the live server returns the DB row as-is inside
 * the { data } envelope).
 *
 * `params` is a JSONB column — pg returns it as an already-parsed object.
 * `created_at` and `updated_at` are ISO-8601 strings after JSON serialisation.
 */
export interface Personality {
  id: string;
  name: string;
  display_name: string;
  group_type: string; // 'reference' | 'learning'
  entry_type: string; // 'fixed_time' | 'momentum_exhaustion' | 'any_signal' | 'sr_anchored'
  management_style: string; // 'hold' | 'roll' | 'cut_reenter'
  is_frozen: boolean;
  is_active: boolean;
  phase: number;
  params: Record<string, unknown>;
  created_at: string; // ISO-8601 timestamp
  updated_at: string; // ISO-8601 timestamp
}

/**
 * One pending evolution-engine suggestion — a row from retrospection_results
 * where the engine proposed a parameter change that's awaiting human approval.
 */
export interface PendingSuggestion {
  id: string;
  personality_id: string;
  trade_date: string; // 'YYYY-MM-DD'
  market_regime: string | null;
  total_trades: number | string;
  winning_trades: number | string;
  total_pnl_pct: number | string | null;
  beat_clockwork_delta: number | string | null;
  proposed_adjustments: Record<string, unknown> | null; // e.g. { min_probability: 0.55 }
  adjustments_applied: boolean;
  created_at: string; // ISO-8601 timestamp
}

// ---------------------------------------------------------------------------
// WebSocket tick messages
// ---------------------------------------------------------------------------

/**
 * The first message emitted by /ws/ticks after a connection is established.
 * Used by the client to confirm the socket is ready before subscribing.
 */
export interface WsConnectedMessage {
  type: 'connected';
  timestamp: number; // epoch ms
}

/**
 * A live NIFTY tick broadcast by /ws/ticks every ~5 seconds.
 * `ltp` is the last-traded price of the index.
 */
export interface WsTickMessage {
  type: 'tick';
  symbol: string; // e.g. "NSE:NIFTY50-INDEX"
  ltp: number;
  timestamp: number; // epoch ms
}

/**
 * A straddle snapshot broadcast by /ws/ticks whenever straddle.values stream
 * has a new entry (approximately every 15 seconds from the straddle calculator).
 *
 * Field names match the server's message exactly (src/server/index.ts straddleLoop):
 *   { type:'straddle', straddleValue, atmStrike, cePrice, pePrice, timestamp, roc?, acceleration? }
 *
 * `roc` and `acceleration` are optional — the server only includes them when
 * the straddle snapshot itself carries those fields (i.e., after enough ticks
 * have accumulated for the ROC window).
 */
export interface WsStraddleMessage {
  type: 'straddle';
  straddleValue: number;
  atmStrike: number;
  cePrice: number;
  pePrice: number;
  timestamp: number; // epoch ms
  roc?: number; // rate of change — present only when the ROC window is satisfied
  acceleration?: number; // second derivative — present only with roc
}

/**
 * Discriminated union covering all known /ws/ticks message shapes.
 * Switch on `msg.type` to narrow to the concrete variant.
 */
export type TickMessage = WsConnectedMessage | WsTickMessage | WsStraddleMessage;

// ---------------------------------------------------------------------------
// Regime Tags (GET /api/regime-tags)
// ---------------------------------------------------------------------------

/**
 * A single row returned by GET /api/regime-tags.
 *
 * trade_date is an ISO-8601 string (the pg driver serialises DATE columns as
 * midnight UTC Date objects, which JSON.stringify converts to ISO strings).
 *
 * regime_confidence is the raw NUMERIC string from pg — typed as string|null so
 * callers must parseFloat() before arithmetic.  null should not appear in
 * practice (the column has a NOT NULL constraint) but is kept here defensively
 * to match the task contract.
 */
export interface RegimeTag {
  trade_date: string; // ISO-8601, e.g. "2026-05-01T00:00:00.000Z"
  symbol: string;
  regime: string; // 'RANGING' | 'TRENDING_STRONG' | 'VOLATILE_REVERTING' | 'EVENT_DAY' | 'UNCLASSIFIED'
  regime_confidence: string | null; // NUMERIC(5,4) as raw string
  classified_at: string; // ISO-8601 timestamp
}

// ---------------------------------------------------------------------------
// Backfill Status (GET /api/backfill)
// ---------------------------------------------------------------------------

/**
 * A single row returned by GET /api/backfill.
 *
 * Mirrors BackfillRange from src/db/schema.ts but with:
 *   - Date fields as ISO-8601 strings (JSON serialisation)
 *   - rows_written and gaps_detected as number (INTEGER columns — pg returns
 *     JS numbers for INTEGER, not strings)
 *   - gaps_json as string|null (JSON-encoded TEXT column; callers parse if needed)
 */
export interface BackfillRangeRow {
  id: number;
  symbol: string;
  from_ts: string; // ISO-8601 timestamp
  to_ts: string; // ISO-8601 timestamp
  resolution: string; // e.g. '1', '5', '15', 'D'
  status: string; // normalised by the API to 'failed'|'in_progress'|'completed'
  rows_written: number; // INTEGER — arrives as JS number
  checkpoint_ts: string | null; // ISO-8601 or null
  gaps_detected: number; // INTEGER — arrives as JS number
  gaps_json: string | null; // JSON-encoded gap array or null
  updated_at: string; // ISO-8601
  created_at: string; // ISO-8601
}
