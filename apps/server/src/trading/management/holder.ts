/**
 * HolderManager — the simplest management style: hold the straddle position
 * until an exit trigger fires (SL, TSL, TARGET, EOD, DAILY_LOSS, EXIT_WINDOW)
 * or the EOD square-off time is reached.
 *
 * This module also defines the shared ManagementHandler interface that
 * AdjusterManager (T-29) and ReducerManager (T-30) will implement. All three
 * handlers have the same callable contract so PositionMonitor can dispatch
 * without knowing the concrete type.
 *
 * Design decisions:
 * - The ManagementHandler interface lives here (in the simplest handler) rather
 *   than in a separate types file because it is co-authored with HolderManager
 *   and is imported by T-29 / T-30 via a single import path. A separate
 *   types.ts would add a file with no behaviour; grouping it here keeps the
 *   hierarchy flat.
 * - TradeIntent is exported here alongside the interface so callers that need
 *   to construct an intent (PersonalityRouter, T-27) have a single import path.
 * - evaluatePosition delegates entirely to evaluateTriggers from trigger-engine.ts.
 *   There is no duplicate exit logic here — Holder adds zero additional behaviour
 *   beyond what the shared trigger engine provides.
 * - closePosition accepts currentStraddleValue as a plain number for ergonomics
 *   (callers already have it as a number from the stream snapshot) and converts
 *   it to string for closeTrade, which expects a string (NUMERIC wire format).
 */

import type { Pool } from 'pg';
import type { OpenPosition, PersonalityConfigM2 as PersonalityConfig } from '../../db/schema.js';
import type { Clock } from '../../utils/clock.js';
import type { PaperTradeExecutor } from '../paper-trade-executor.js';
import { evaluateTriggers } from '../trigger-engine.js';
import type { TriggerConfig } from '../trigger-engine.js';

// ---------------------------------------------------------------------------
// TradeIntent — the data needed to open a new straddle trade
// ---------------------------------------------------------------------------

/**
 * Payload passed from PersonalityRouter (T-27) to a ManagementHandler's
 * openPosition() to open a new paper trade for a specific personality.
 *
 * All numeric fields are plain numbers at this layer (not strings) because
 * they come from the straddle snapshot which deserialises them before handing
 * them to the personality router. The executor's openTrade() accepts the
 * EntryIntent shape which has string NUMERIC fields — we convert in openPosition.
 *
 * personalityId is the UUID from personality_configs.id. It will be written
 * to paper_trades.personality_id in the DB row.
 *
 * signalId is the UUID from straddle_signals.id if the entry was triggered by
 * a momentum exhaustion signal, or null for scheduled (fixed-time) entries.
 *
 * entryTime is epoch-ms so callers don't have to construct a Date.
 */
export interface TradeIntent {
  personalityId: string;
  signalId: string | null;
  underlying: string;
  atmStrike: number;
  spot: number;
  straddleValue: number;
  vix: number | null;
  entryTime: number; // epoch ms
}

// ---------------------------------------------------------------------------
// ManagementHandler — shared interface for all three management styles
// ---------------------------------------------------------------------------

/**
 * Contract implemented by HolderManager, AdjusterManager (T-29), and
 * ReducerManager (T-30). PositionMonitor dispatches to whichever handler
 * matches personality.management_style without knowing the concrete type.
 *
 * openPosition: opens a new paper trade for a personality given a TradeIntent.
 *   Returns the new paper_trades.id (UUID string) so PositionMonitor can track it.
 *
 * evaluatePosition: checks whether an open position should be closed right now.
 *   Returns { shouldExit: false } if the position should be held, or
 *   { shouldExit: true, exitReason: '...' } when a trigger fires.
 *   The caller is responsible for calling closePosition when shouldExit is true.
 *
 * closePosition: closes an open position at the current straddle value.
 *   exitReason is the trigger name ('SL', 'TSL', 'TARGET', 'EOD', 'DAILY_LOSS',
 *   'EXIT_WINDOW') forwarded to paper_trades.exit_reason in the DB.
 *
 * db is passed into evaluatePosition / closePosition rather than stored on
 * the handler instance because these handlers are stateless — the same
 * HolderManager singleton is used for all personalities, so instance-level
 * state would leak across personalities.
 */
export interface ManagementHandler {
  openPosition(intent: TradeIntent, executor: PaperTradeExecutor, clock: Clock): Promise<string>;

  evaluatePosition(
    position: OpenPosition,
    currentStraddleValue: number,
    currentSpot: number,
    clock: Clock,
    triggerConfig: TriggerConfig,
    db: Pool,
    personality: PersonalityConfig,
  ): Promise<{ shouldExit: boolean; exitReason?: string }>;

  closePosition(
    position: OpenPosition,
    currentStraddleValue: number,
    exitReason: string,
    db: Pool,
    clock: Clock,
    executor: PaperTradeExecutor,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// HolderManager
// ---------------------------------------------------------------------------

/**
 * Implements the "hold" management style: open the trade, hold until a trigger
 * fires, then close. No rolling, no cut-and-reenter logic.
 *
 * This is the simplest possible implementation of ManagementHandler and serves
 * as the reference implementation for T-29 (Adjuster) and T-30 (Reducer).
 *
 * Stateless: all data is passed in per call. A single instance can safely be
 * reused across all "hold" personality positions without any interference.
 */
export class HolderManager implements ManagementHandler {
  // ---------------------------------------------------------------------------
  // openPosition
  // ---------------------------------------------------------------------------

  /**
   * Opens a new paper trade for the given personality.
   *
   * Delegates to executor.openTrade() with an EntryIntent constructed from
   * the TradeIntent. The personality_id is written to paper_trades via the
   * executor — see paper-trade-executor.ts for the INSERT statement.
   *
   * lotSize defaults to 50 (NIFTY Phase 1 standard). BankNifty/Sensex lot
   * sizes will be passed explicitly in Phase 2 via a per-personality config
   * field, but that field does not exist yet in Phase 1.
   */
  async openPosition(
    intent: TradeIntent,
    executor: PaperTradeExecutor,
    _clock: Clock,
  ): Promise<string> {
    // We convert numeric fields to the string format that EntryIntent expects
    // (NUMERIC columns are always strings in this codebase — see schema.ts header).
    const entryIntent = {
      straddleValue: String(intent.straddleValue),
      atmStrike: intent.atmStrike,
      // Phase 1 only supports NIFTY — underlying is validated by PersonalityRouter
      // before calling openPosition, so we cast safely here.
      underlying: 'NIFTY' as const,
      spot: String(intent.spot),
      vixAtEntry: intent.vix !== null ? String(intent.vix) : null,
      entryTimeMs: intent.entryTime,
    };

    return executor.openTrade(entryIntent);
  }

  // ---------------------------------------------------------------------------
  // evaluatePosition
  // ---------------------------------------------------------------------------

  /**
   * Evaluates whether the position should be closed by delegating entirely to
   * evaluateTriggers() from trigger-engine.ts.
   *
   * No exit logic is duplicated here — the shared trigger engine owns all exit
   * conditions (SL, TSL, TARGET, EOD, DAILY_LOSS, EXIT_WINDOW). Holder adds
   * no additional logic on top.
   *
   * currentStraddleValue and currentSpot are passed in as numbers from the
   * stream snapshot. We convert currentStraddleValue to string for the trigger
   * engine, which expects the NUMERIC wire format throughout.
   *
   * currentSpot is received but not used by the trigger engine today (it only
   * uses straddle values for exit decisions). It is in the signature to satisfy
   * the ManagementHandler interface, which defines it as required so that T-29
   * (Adjuster) can use spot for strike distance checks without needing to change
   * the interface.
   *
   * The personality parameter is unused by HolderManager but is part of the
   * ManagementHandler interface so AdjusterManager can read personality-specific
   * params (e.g. roll_trigger_points) without needing a different dispatch path.
   */
  async evaluatePosition(
    position: OpenPosition,
    currentStraddleValue: number,
    _currentSpot: number,
    clock: Clock,
    triggerConfig: TriggerConfig,
    _db: Pool,
    _personality: PersonalityConfig,
  ): Promise<{ shouldExit: boolean; exitReason?: string }> {
    // evaluateTriggers is a pure synchronous function (no DB, no async).
    // We wrap it in an async method to satisfy the ManagementHandler interface
    // (T-29 / T-30 may need async operations for their more complex logic).
    const decision = evaluateTriggers(position, String(currentStraddleValue), clock, triggerConfig);

    if (decision.shouldExit) {
      return { shouldExit: true, exitReason: decision.reason };
    }

    return { shouldExit: false };
  }

  // ---------------------------------------------------------------------------
  // closePosition
  // ---------------------------------------------------------------------------

  /**
   * Closes the position by delegating to executor.closeTrade().
   *
   * The exit price for a straddle close is currentStraddleValue (the current
   * combined CE+PE straddle value). This is converted to a string here because
   * closeTrade expects a string (NUMERIC wire format, per schema.ts convention).
   *
   * The db parameter is received but not used directly — closeTrade reads the
   * entry data it needs from the DB internally (see paper-trade-executor.ts
   * design note: "reads straddle_at_entry from the DB rather than the caller").
   * It is in the signature to satisfy ManagementHandler, since T-29/T-30 may
   * need direct DB access for rolling logic.
   */
  async closePosition(
    position: OpenPosition,
    currentStraddleValue: number,
    exitReason: string,
    _db: Pool,
    clock: Clock,
    executor: PaperTradeExecutor,
  ): Promise<void> {
    await executor.closeTrade(position.id, String(currentStraddleValue), exitReason, clock);
  }
}
