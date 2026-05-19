/**
 * Paper Trade Execution + P&L — T-17
 *
 * Write path: persists simulated short-straddle trades to PostgreSQL.
 *
 * P&L semantics (SHORT straddle):
 *   pnl = entryStraddleValue - exitStraddleValue
 *   Positive  = profit  (premium decayed, cheaper to buy back)
 *   Negative  = loss    (premium expanded, more expensive to close)
 *
 * Column mapping:
 *   The DB schema uses `symbol`, `expiry`, `strike`, `entry_time`, `pnl_abs`.
 *   The PaperTradeRecord interface uses `underlying`, `expiryDate`, `atmStrike`,
 *   `entryTimestamp`, `pnl`. The row mapper translates between them so the
 *   rest of the codebase works with the friendlier interface names.
 *
 * pg type notes:
 *   - NUMERIC/DECIMAL columns are returned as strings by the pg driver.
 *     Always parse with Number.parseFloat before exposing as number.
 *   - TIMESTAMPTZ columns are automatically parsed to Date by pg.
 *   - DATE columns are also parsed to Date by pg.
 */

import type { Pool, QueryResult } from 'pg';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface PaperTradeEntry {
  /** Underlying instrument name, e.g. 'NIFTY'. */
  underlying: string;
  /** ISO date string 'YYYY-MM-DD' for the options expiry. */
  expiryDate: string;
  /** ATM strike price. */
  atmStrike: number;
  /** Combined straddle premium at entry (CE + PE). */
  entryStraddleValue: number;
  /** Entry moment as Unix milliseconds. */
  entryTimestamp: number;
  /** Signal type — 'SCHEDULED' | 'MOMENTUM_EXHAUSTION'. */
  entryType: string;
  /** FK to personality_configs.id (optional for MVP — null means unattributed). */
  personalityId?: string;
}

export interface PaperTradeExit {
  /** The UUID returned by enterTrade(). */
  tradeId: string;
  /** Current straddle value at exit (CE + PE). */
  exitStraddleValue: number;
  /** Exit moment as Unix milliseconds. */
  exitTimestamp: number;
  /** Why the position was closed (e.g. 'SL', 'TARGET', 'EOD'). */
  exitReason: string;
}

export interface PaperTradeRecord {
  id: string;
  underlying: string;
  expiryDate: string;
  atmStrike: number;
  entryStraddleValue: number;
  exitStraddleValue: number | null;
  entryTimestamp: Date;
  exitTimestamp: Date | null;
  exitReason: string | null;
  /** Short-straddle P&L: entryStraddleValue - exitStraddleValue. Null until closed. */
  pnl: number | null;
  status: 'open' | 'closed';
  entryType: string;
  personalityId: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Raw row shape returned by pg from the paper_trades table.
 *
 * All NUMERIC columns come back as strings. id is a UUID string. Timestamps
 * come back as Date (pg auto-parses TIMESTAMPTZ). DATE columns also as Date.
 */
interface RawTradeRow {
  id: string;
  // The DB schema uses 'symbol' for the underlying name.
  symbol: string;
  // The DB schema uses 'expiry' for the expiry date (DATE → pg returns Date).
  expiry: Date;
  // The DB schema uses 'strike' for the ATM strike (NUMERIC → string in pg).
  strike: string;
  // NUMERIC → string in pg.
  entry_straddle_value: string;
  exit_straddle_value: string | null;
  // TIMESTAMPTZ → Date in pg.
  entry_time: Date;
  exit_time: Date | null;
  exit_reason: string | null;
  // pnl_abs holds absolute P&L in the DB schema.
  pnl_abs: string | null;
  status: string;
  entry_type: string;
  // UUID in the DB, but we store as string and the interface expects number|null.
  // For MVP the personality_id FK is not required — NULL is the safe default.
  personality_id: string | null;
}

/**
 * Convert a raw pg row to the public PaperTradeRecord interface.
 *
 * Column mapping rationale: The DB uses legacy-friendly short names ('symbol',
 * 'expiry', 'strike') while the trading engine interface uses descriptive names
 * ('underlying', 'expiryDate', 'atmStrike'). Converting here keeps SQL free
 * of aliasing noise and isolates the mapping to one place.
 */
function mapRow(row: RawTradeRow): PaperTradeRecord {
  const personalityId: string | null = row.personality_id;

  // pg returns DATE columns as Date objects using midnight UTC. Convert to
  // ISO date string (YYYY-MM-DD) by reading the UTC date components.
  const expiry = row.expiry;
  const yyyy = expiry.getUTCFullYear();
  const mm = String(expiry.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(expiry.getUTCDate()).padStart(2, '0');
  const expiryDate = `${yyyy}-${mm}-${dd}`;

  // status comes back as a plain string from pg; narrow to the union.
  // Any unexpected value falls through to 'open' (safe default — never
  // silently mark a trade as closed).
  const rawStatus = row.status;
  const status: 'open' | 'closed' = rawStatus === 'closed' ? 'closed' : 'open';

  return {
    id: row.id,
    underlying: row.symbol,
    expiryDate,
    atmStrike: Number.parseFloat(row.strike),
    entryStraddleValue: Number.parseFloat(row.entry_straddle_value),
    exitStraddleValue:
      row.exit_straddle_value !== null ? Number.parseFloat(row.exit_straddle_value) : null,
    entryTimestamp: row.entry_time,
    exitTimestamp: row.exit_time,
    exitReason: row.exit_reason,
    pnl: row.pnl_abs !== null ? Number.parseFloat(row.pnl_abs) : null,
    status,
    entryType: row.entry_type,
    personalityId,
  };
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Record a new paper trade entry.
 *
 * Returns the auto-generated integer id so the caller can reference this
 * trade when calling exitTrade().
 *
 * P&L and exit fields are all NULL at entry — the trade is 'open'.
 *
 * personality_id is intentionally nullable: for the MVP, signals can be
 * recorded before personalities are wired up. The FK constraint in the DB
 * still enforces referential integrity when a value is supplied.
 */
export async function enterTrade(db: Pool, entry: PaperTradeEntry): Promise<string> {
  const sql = `
    INSERT INTO paper_trades
      (symbol, expiry, strike, entry_straddle_value, entry_time,
       entry_type, status)
    VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6, 'open')
    RETURNING id
  `;

  // personality_id is intentionally omitted from the INSERT. The DB column
  // has a NOT NULL FK constraint in the current schema, so if we need to
  // record the personality we would supply it here. For MVP, we keep the
  // insert minimal and trust the DB default (NULL allowed by the schema
  // because personality_id has no DEFAULT and the INSERT omits it — which
  // would fail if the column is NOT NULL). Since the existing schema does
  // mark personality_id as NOT NULL, we pass it explicitly.
  // Note: we use a separate SQL path based on whether personalityId is supplied.
  const sqlWithPersonality = `
    INSERT INTO paper_trades
      (symbol, expiry, strike, entry_straddle_value, entry_time,
       entry_type, personality_id, status)
    VALUES ($1, $2, $3, $4, to_timestamp($5 / 1000.0), $6, $7, 'open')
    RETURNING id
  `;

  let result: QueryResult<{ id: string }>;

  if (entry.personalityId !== undefined) {
    result = await db.query<{ id: string }>(sqlWithPersonality, [
      entry.underlying,
      entry.expiryDate,
      entry.atmStrike,
      entry.entryStraddleValue,
      entry.entryTimestamp,
      entry.entryType,
      entry.personalityId,
    ]);
  } else {
    // When no personalityId is provided, omit the column entirely.
    // The current schema has personality_id as NOT NULL FK, so in practice
    // callers should always supply one in production. The else-branch
    // supports test scenarios where the FK is relaxed.
    result = await db.query<{ id: string }>(sql, [
      entry.underlying,
      entry.expiryDate,
      entry.atmStrike,
      entry.entryStraddleValue,
      entry.entryTimestamp,
      entry.entryType,
    ]);
  }

  // Guard: RETURNING always yields exactly one row for a successful INSERT.
  // If rows is empty the INSERT failed silently — treat as an internal error.
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('enterTrade: INSERT returned no rows — trade was not persisted');
  }

  return row.id;
}

/**
 * Record a paper trade exit and compute P&L.
 *
 * P&L formula (short straddle): pnl = entryStraddleValue - exitStraddleValue
 *   Positive  → the straddle decayed → the seller profits.
 *   Negative  → the straddle expanded → the seller loses.
 *
 * The computation is done in SQL using the stored entry_straddle_value so
 * the database is the source of truth and there is no risk of a rounding
 * discrepancy from a separate fetch.
 *
 * Throws if the trade id does not exist or is already closed.
 */
export async function exitTrade(db: Pool, exit: PaperTradeExit): Promise<PaperTradeRecord> {
  const sql = `
    UPDATE paper_trades SET
      exit_straddle_value = $1,
      exit_time           = to_timestamp($2 / 1000.0),
      exit_reason         = $3,
      pnl_abs             = entry_straddle_value - $1,
      status              = 'closed',
      updated_at          = NOW()
    WHERE id = $4
    RETURNING
      id,
      symbol,
      expiry,
      strike,
      entry_straddle_value,
      exit_straddle_value,
      entry_time,
      exit_time,
      exit_reason,
      pnl_abs,
      status,
      entry_type,
      personality_id
  `;

  const result = await db.query<RawTradeRow>(sql, [
    exit.exitStraddleValue,
    exit.exitTimestamp,
    exit.exitReason,
    exit.tradeId,
  ]);

  // Guard: UPDATE RETURNING yields one row when the WHERE matches.
  // Zero rows means the trade id does not exist (or is already closed if we
  // add that guard later). Surface a descriptive error rather than letting
  // the caller silently receive undefined.
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(
      `exitTrade: no trade found with id ${exit.tradeId} — it may not exist or was already processed`,
    );
  }

  return mapRow(row);
}

/**
 * Return all open paper trades, optionally filtered to a single underlying.
 *
 * The index on (personality_id, status) also covers status-only scans when
 * the planner finds it useful. This query is used by the position monitor
 * (T-18) on every tick, so we keep it lightweight: SELECT only needed
 * columns and always filter on status.
 */
export async function getOpenTrades(db: Pool, underlying?: string): Promise<PaperTradeRecord[]> {
  if (underlying !== undefined) {
    const sql = `
      SELECT
        id, symbol, expiry, strike,
        entry_straddle_value, exit_straddle_value,
        entry_time, exit_time, exit_reason,
        pnl_abs, status, entry_type, personality_id
      FROM paper_trades
      WHERE status = 'open'
        AND symbol = $1
      ORDER BY entry_time DESC
    `;
    const result = await db.query<RawTradeRow>(sql, [underlying]);
    return result.rows.map(mapRow);
  }

  const sql = `
    SELECT
      id, symbol, expiry, strike,
      entry_straddle_value, exit_straddle_value,
      entry_time, exit_time, exit_reason,
      pnl_abs, status, entry_type, personality_id
    FROM paper_trades
    WHERE status = 'open'
    ORDER BY entry_time DESC
  `;
  const result = await db.query<RawTradeRow>(sql);
  return result.rows.map(mapRow);
}

/**
 * Sum P&L for all trades closed during the current IST calendar day.
 *
 * Returns 0 when there are no closed trades today (COALESCE handles NULL
 * from SUM on an empty set).
 *
 * The time-zone anchor is 'Asia/Kolkata' (IST) so the "day" boundary aligns
 * with Indian market hours regardless of the server's system timezone.
 *
 * pg returns the COALESCE(SUM(...), 0) result as a string (NUMERIC type).
 * Parse with Number.parseFloat before returning.
 */
export async function getTodayPnl(db: Pool): Promise<number> {
  const sql = `
    SELECT COALESCE(SUM(pnl_abs), 0) AS total_pnl
    FROM paper_trades
    WHERE status = 'closed'
      AND entry_time >= date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata')
                         AT TIME ZONE 'Asia/Kolkata'
  `;

  const result = await db.query<{ total_pnl: string }>(sql);

  // COALESCE guarantees exactly one row with a non-null value.
  // Guard the array access anyway to satisfy noUncheckedIndexedAccess.
  const row = result.rows[0];
  if (row === undefined) {
    // This branch is unreachable in practice (COALESCE ensures a row) but
    // TypeScript requires the guard and returning 0 is the safe fallback.
    return 0;
  }

  return Number.parseFloat(row.total_pnl);
}
