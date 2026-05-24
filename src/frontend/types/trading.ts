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
 * Discriminated union covering all known /ws/ticks message shapes.
 * Switch on `msg.type` to narrow to the concrete variant.
 */
export type TickMessage = WsConnectedMessage | WsTickMessage;
