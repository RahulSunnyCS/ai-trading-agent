/**
 * TypeScript interfaces for every database table in migration 001.
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
 */

// ---------------------------------------------------------------------------
// paper_trades
// ---------------------------------------------------------------------------

/**
 * One simulated straddle paper trade opened by a personality.
 *
 * Nullable columns (entry/exit legs, context data) use `string | null` rather
 * than optional `?` to make it explicit that these fields always come back from
 * the database — they are simply NULL-valued, not absent from the row object.
 *
 * status is narrowed to the literal union to match the CHECK constraint in the
 * migration rather than being typed as plain `string`.
 */
export interface PaperTrade {
  id: string;
  entryTime: Date;
  exitTime: Date | null;
  entryCeStrike: string | null;
  entryPeStrike: string | null;
  entryCePrice: string | null;
  entryPePrice: string | null;
  exitCePrice: string | null;
  exitPePrice: string | null;
  lots: number;
  lotSize: number;
  straddleAtEntry: string;
  lowestStraddleValueSeen: string;
  vixAtEntry: string | null;
  spotAtEntry: string | null;
  exitReason: string | null;
  grossPnl: string | null;
  netPnl: string | null;
  maxDrawdown: string | null;
  status: "open" | "closed";
  notes: string | null;
}

// ---------------------------------------------------------------------------
// market_ticks
// ---------------------------------------------------------------------------

/**
 * One raw tick from the broker WebSocket or simulator.
 *
 * volume and oi are nullable because the Fyers WebSocket does not always
 * include them in every tick message.
 *
 * time is typed as Date because pg automatically parses TIMESTAMPTZ columns
 * to JS Date objects (unlike NUMERIC, there is no custom type parser needed).
 */
export interface MarketTick {
  time: Date;
  symbol: string;
  lastPrice: string;
  volume: bigint | null;
  oi: bigint | null;
}

// ---------------------------------------------------------------------------
// straddle_snapshots
// ---------------------------------------------------------------------------

/**
 * One 15-second ATM straddle snapshot produced by straddle-calc.ts.
 *
 * vix is nullable: the VIX poller may not have a value at startup before the
 * NSE API responds.
 */
export interface StraddleSnapshot {
  time: Date;
  underlying: string;
  spot: string;
  atmStrike: string;
  cePrice: string;
  pePrice: string;
  straddleValue: string;
  vix: string | null;
}

// ---------------------------------------------------------------------------
// OpenPosition (runtime shape — not a DB table)
// ---------------------------------------------------------------------------

/**
 * The in-memory shape consumed by the trigger engine (T-16) to evaluate
 * whether an open position should be closed, rolled, or held.
 *
 * This is derived from `paper_trades` rows where status = 'open'. It carries
 * only the fields the trigger engine needs — the full `PaperTrade` row is not
 * required at decision time.
 *
 * entryTimeMs is epoch milliseconds (Date.getTime()) rather than a Date object
 * because the trigger engine compares it to Date.now() for time-in-trade
 * calculations, and arithmetic on numbers is simpler than Date subtraction.
 *
 * todayNetPnl is a running P&L string computed by the trigger engine from the
 * current straddle value versus straddleAtEntry, not stored directly in the DB.
 */
export interface OpenPosition {
  id: string;
  entryStraddleValue: string;
  lowestStraddleValueSeen: string;
  entryTimeMs: number;
  todayNetPnl: string;
}
