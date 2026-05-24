/**
 * Paper trade executor — opens and closes simulated short-straddle positions.
 *
 * SIGN CONVENTION (short straddle):
 *   We SELL the straddle upfront and collect premium (straddleValue at entry).
 *   - Profit  = straddle value FALLS after entry  (we buy it back cheaper)
 *   - Loss    = straddle value RISES after entry  (we buy it back more expensively)
 *
 * Formula: gross_pnl = (straddle_at_entry − exit_straddle_value) × lots × lot_size
 *
 * All monetary arithmetic uses decimal.js — never JS native number arithmetic.
 * This matches the pattern in src/utils/pnl.ts and the reason NUMERIC columns
 * are typed as strings in src/db/schema.ts (see that file's header comment).
 *
 * Design choices:
 * - PaperTradeExecutor takes a Pool directly (not using the module-level
 *   singleton from src/db/client.ts) so the caller can inject a test pool
 *   without patching module globals. Same pattern as the entry engine.
 * - closeTrade reads straddle_at_entry / lots / lot_size from the DB rather
 *   than requiring the caller to pass them in, which eliminates the risk of
 *   the caller supplying stale or mis-matched values.
 * - Quantiply errors are caught and logged but never re-thrown: a failed
 *   Quantiply call must not crash the trading loop or leave the DB row
 *   in a half-written state.
 * - getOpenTrades always filters by trading date in IST ('Asia/Kolkata') so
 *   a query at 00:05 UTC (05:35 IST) on the next calendar day cannot
 *   accidentally return yesterday's trades as "today's open positions".
 */

import Decimal from 'decimal.js';
import type { Pool } from 'pg';
import type { OpenPosition } from '../db/schema.js';
import type { Clock } from '../utils/clock.js';
import { calculatePnl } from '../utils/pnl.js';
import type { EntryIntent } from './entry-engine.js';
import type { QuantiplyClient } from './quantiply-stub.js';

// Re-export the interface so callers can import it from here if they prefer
// without a separate import from quantiply-stub.ts.
export type { QuantiplyClient };

// ---------------------------------------------------------------------------
// PaperTradeExecutor
// ---------------------------------------------------------------------------

export class PaperTradeExecutor {
  private readonly _db: Pool;
  private readonly _quantiply: QuantiplyClient;

  constructor(deps: { db: Pool; quantiply: QuantiplyClient }) {
    this._db = deps.db;
    this._quantiply = deps.quantiply;
  }

  // ---------------------------------------------------------------------------
  // openTrade
  // ---------------------------------------------------------------------------

  /**
   * Inserts a new open paper trade into the database and notifies Quantiply.
   *
   * @param intent   EntryIntent produced by the entry engine (all fields validated upstream)
   * @param lotSize  Lot size override; defaults to 50 (NIFTY standard lot size as of Phase 1).
   *                 Passed as an explicit parameter so BankNifty/Sensex (Phase 2) can use
   *                 different lot sizes without changing this method's signature.
   * @returns        The new paper_trades.id (UUID string) for use by the position monitor.
   */
  async openTrade(intent: EntryIntent, lotSize?: number): Promise<string> {
    const resolvedLotSize = lotSize ?? 50;

    // Split the straddle value 50/50 across CE and PE legs.
    // This is a placeholder: in reality CE and PE have different prices based on
    // moneyness/skew. A real option chain query is deferred to Phase 2.
    const halfStraddle = new Decimal(intent.straddleValue).div(2).toFixed(2);

    const result = await this._db.query<{ id: string }>(
      `INSERT INTO paper_trades (
        entry_ce_strike,
        entry_pe_strike,
        entry_ce_price,
        entry_pe_price,
        lots,
        lot_size,
        straddle_at_entry,
        lowest_straddle_value_seen,
        vix_at_entry,
        spot_at_entry,
        status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'open')
      RETURNING id`,
      [
        intent.atmStrike, // $1  entry_ce_strike — ATM strike for both legs
        intent.atmStrike, // $2  entry_pe_strike — same strike (ATM straddle)
        halfStraddle, // $3  entry_ce_price
        halfStraddle, // $4  entry_pe_price
        1, // $5  lots — always 1 in MVP (multi-lot is Phase 2)
        resolvedLotSize, // $6  lot_size
        intent.straddleValue, // $7  straddle_at_entry
        intent.straddleValue, // $8  lowest_straddle_value_seen — initialised to entry
        intent.vixAtEntry, // $9  vix_at_entry (nullable)
        intent.spot, // $10 spot_at_entry
      ],
    );

    // pg always returns at least one row when RETURNING is used and the INSERT
    // succeeds; a missing row here would indicate a driver bug, not normal flow.
    const id = result.rows[0]?.id;
    if (!id) {
      throw new Error('[paper-trade-executor] INSERT into paper_trades returned no id');
    }

    // Notify Quantiply asynchronously. Errors are caught here so a Quantiply
    // outage cannot crash the trading loop or roll back the DB insert.
    const tradeRecord = {
      id,
      entryIntent: intent,
      lotSize: resolvedLotSize,
      lots: 1,
    };
    try {
      await this._quantiply.recordTrade(tradeRecord);
    } catch (err: unknown) {
      // Log but do not rethrow — Quantiply failure is non-fatal for the trading loop.
      console.error('[paper-trade-executor] Quantiply recordTrade failed (non-fatal):', err);
    }

    return id;
  }

  // ---------------------------------------------------------------------------
  // closeTrade
  // ---------------------------------------------------------------------------

  /**
   * Updates an open paper_trades row to 'closed', computing P&L from the DB values.
   *
   * Reads straddle_at_entry, lots, and lot_size from the database rather than
   * accepting them as parameters. This is intentional: it prevents the caller
   * from accidentally passing stale values if the position was updated mid-trade
   * (e.g. by a future rolling/adjustment logic). The single source of truth is
   * the DB row opened by openTrade().
   *
   * @param tradeId            UUID of the paper_trades row to close
   * @param exitStraddleValue  Current combined straddle value (CE + PE) as a decimal string
   * @param exitReason         One of: "SL" | "TSL" | "TARGET" | "EOD" | "DAILY_LOSS" | "EXIT_WINDOW"
   * @param clock              Clock instance — used for exit_time (injected for testability)
   */
  async closeTrade(
    tradeId: string,
    exitStraddleValue: string,
    exitReason: string,
    clock: Clock,
  ): Promise<void> {
    // Fetch the row we need for P&L calculation.
    // We SELECT only the three fields we need rather than SELECT * to avoid
    // loading potentially large notes/log columns and to make the intent explicit.
    const rows = await this._db.query<{
      straddle_at_entry: string;
      lots: number;
      lot_size: number;
    }>(
      `SELECT straddle_at_entry, lots, lot_size
       FROM paper_trades
       WHERE id = $1`,
      [tradeId],
    );

    const trade = rows.rows[0];
    if (!trade) {
      throw new Error(`[paper-trade-executor] closeTrade: trade not found for id=${tradeId}`);
    }

    // P&L calculation uses the shared helper from src/utils/pnl.ts which
    // applies the correct short-straddle sign convention and uses Decimal
    // arithmetic throughout. We do NOT inline the formula here to avoid
    // duplicating the sign convention logic.
    const { grossPnl } = calculatePnl(
      trade.straddle_at_entry,
      exitStraddleValue,
      trade.lots,
      trade.lot_size,
    );

    // Split exit straddle value 50/50 across CE and PE legs.
    // Consistent with openTrade's entry pricing — same placeholder approach.
    const exitHalf = new Decimal(exitStraddleValue).div(2).toFixed(2);

    // net_pnl == gross_pnl in MVP because there is no fee model yet.
    // This is explicit rather than just copying the column in SQL so that when
    // a fee model is added in a later sprint, the change is localised here.
    await this._db.query(
      `UPDATE paper_trades
       SET
         exit_time    = $1,
         exit_ce_price = $2,
         exit_pe_price = $3,
         exit_reason  = $4,
         status       = 'closed',
         gross_pnl    = $5,
         net_pnl      = $6
       WHERE id = $7`,
      [
        new Date(clock.now()), // $1  exit_time
        exitHalf, // $2  exit_ce_price
        exitHalf, // $3  exit_pe_price
        exitReason, // $4  exit_reason
        grossPnl, // $5  gross_pnl
        grossPnl, // $6  net_pnl (= gross_pnl, no fees in MVP)
        tradeId, // $7  WHERE id
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// getOpenTrades
// ---------------------------------------------------------------------------

/**
 * Returns all open paper trades for the given trading date (YYYY-MM-DD in IST).
 *
 * The time-zone cast in the WHERE clause ensures that "today" means IST calendar
 * day, not UTC — this matters because Indian market sessions run 09:15–15:30 IST
 * (03:45–10:00 UTC), so a UTC-based filter would misattribute early-session trades
 * to the previous calendar day.
 *
 * Acceptance criterion 9 requires this function to ALWAYS include the time filter.
 * Omitting it would scan the entire paper_trades table, which could be expensive
 * once months of data accumulate.
 *
 * todayNetPnl is initialised to '0' here because we do not have the current
 * straddle value at query time — the caller (position monitor / trigger engine)
 * computes running P&L from the live tick before passing the position to
 * evaluateTriggers(). This matches the OpenPosition interface contract where
 * todayNetPnl is a "running P&L string computed by the trigger engine" (schema.ts).
 */
export async function getOpenTrades(db: Pool, tradingDate: string): Promise<OpenPosition[]> {
  // NOTE: tradingDate is caller-provided as 'YYYY-MM-DD'. We use a parameterised
  // query to prevent SQL injection even though this value comes from the
  // Clock helper rather than user input — defence in depth.
  const result = await db.query<{
    id: string;
    straddle_at_entry: string;
    lowest_straddle_value_seen: string;
    entry_time: Date;
  }>(
    `SELECT
       id,
       straddle_at_entry,
       lowest_straddle_value_seen,
       entry_time
     FROM paper_trades
     WHERE status = 'open'
       AND DATE(entry_time AT TIME ZONE 'Asia/Kolkata') = $1`,
    [tradingDate],
  );

  return result.rows.map((row) => ({
    id: row.id,
    entryStraddleValue: row.straddle_at_entry,
    lowestStraddleValueSeen: row.lowest_straddle_value_seen,
    // entryTimeMs is epoch-ms (number) as required by OpenPosition in schema.ts.
    // pg returns TIMESTAMPTZ columns as JS Date objects, so .getTime() is safe.
    entryTimeMs: row.entry_time.getTime(),
    // todayNetPnl is a placeholder: the trigger engine overwrites this with the
    // live calculated value before calling evaluateTriggers(). '0' is correct
    // here because at query time we do not know the current straddle value.
    todayNetPnl: '0',
  }));
}
