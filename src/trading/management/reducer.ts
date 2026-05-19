/**
 * ReducerManager — the "cut and re-enter" management style.
 *
 * Strategy: if the spot price moves adversely from the entry spot by
 * cut_trigger_points or more, close the position immediately (CUT). After a
 * CUT the personality is marked as "re-entry eligible" for the rest of that
 * trading day: the next signal that arrives for this personality passes through
 * a lower probability threshold (reentry_min_probability, default 0.65 vs the
 * standard 0.70). This lets the strategy get back into a corrected position
 * after a sharp move without waiting for a fresh high-conviction setup.
 *
 * All other exits (SL, TSL, TARGET, EOD, DAILY_LOSS, EXIT_WINDOW) are
 * delegated to evaluateTriggers() — identical to HolderManager. ReducerManager
 * only adds the cut-trigger check on top.
 *
 * Re-entry eligibility state is stored in a module-level Map (keyed by
 * personality UUID). Module-level state is appropriate here because:
 *   - There is exactly one process running the personality engine.
 *   - The state resets naturally via the date-check in isReentryEligible: a
 *     state entry from a previous day carries a different YYYY-MM-DD string and
 *     therefore always returns false — no explicit nightly cleanup is required.
 *   - PersonalityRouter / PositionMonitor can call resetReentryState() at EOD
 *     for an explicit reset (belt-and-suspenders).
 *
 * Why not store state in Redis?
 *   The volume of state is tiny (at most 10 keys — one per Reducer personality),
 *   it is ephemeral (useful for one trading day only), and it is safe to lose
 *   across a process restart (a restarted process will simply not know about a
 *   prior CUT, treating the next signal with standard min_probability — a
 *   conservative and safe fallback). Redis would add infrastructure coupling with
 *   no meaningful benefit at this scale.
 *
 * Cut trigger is checked BEFORE evaluateTriggers to preserve the priority:
 *   CUT > SL > DAILY_LOSS > EOD > EXIT_WINDOW > TSL > TARGET
 *
 * Design note on spot_at_entry:
 *   The ManagementHandler interface's OpenPosition does not include spot_at_entry
 *   (it is not needed by HolderManager or AdjusterManager). ReducerManager is
 *   the only handler that needs it. Rather than widening the shared OpenPosition
 *   interface (which would break HolderManager's "minimal required fields" design
 *   principle), we query spot_at_entry from the DB inside evaluatePosition.
 *   At a 15-second snapshot cadence this is one extra parameterised SELECT per
 *   active position — acceptable for a paper-trading research tool.
 */

import type { Pool } from "pg";
import type { OpenPosition, PersonalityConfig } from "../../db/schema.js";
import type { Clock } from "../../utils/clock.js";
import type { PaperTradeExecutor } from "../paper-trade-executor.js";
import { evaluateTriggers } from "../trigger-engine.js";
import type { TriggerConfig } from "../trigger-engine.js";
import type { ManagementHandler, TradeIntent } from "./holder.js";

// ---------------------------------------------------------------------------
// Re-entry eligibility state
// ---------------------------------------------------------------------------

/**
 * Per-personality re-entry eligible state.
 *
 * date is 'YYYY-MM-DD' in IST. isReentryEligible() compares against today's
 * IST date — if they differ the state is stale (from a prior day) and returns
 * false automatically. No explicit cleanup timer is required.
 */
interface ReentryState {
  date: string; // YYYY-MM-DD IST
}

/**
 * Module-level in-memory store for re-entry eligibility.
 * Key: personality UUID string.
 *
 * Intentionally module-level (not instance-level) so PositionMonitor can use
 * a singleton ReducerManager instance without each instance having its own
 * isolated state copy. The static helper methods access this map directly.
 */
const reentryEligible = new Map<string, ReentryState>();

// ---------------------------------------------------------------------------
// IST date helper
// ---------------------------------------------------------------------------

/**
 * Converts an epoch-ms timestamp to a 'YYYY-MM-DD' date string in IST (UTC+5:30).
 *
 * India does not observe DST, so the offset is always +330 minutes. We add
 * the offset to the UTC epoch and then use UTC accessors on the shifted date
 * rather than relying on the host system's locale, which may be set to a
 * different time zone in non-IST environments (e.g. CI servers in UTC).
 *
 * This mirrors the approach suggested in the task contract and is consistent
 * with how the pg driver and TimescaleDB queries use 'Asia/Kolkata'.
 */
function getISTDateStr(epochMs: number): string {
  // Add 5h 30m = 330 minutes = 19800 seconds = 19800000 ms to shift to IST.
  const shifted = new Date(epochMs + 330 * 60 * 1000);
  const yyyy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(shifted.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// ReducerManager
// ---------------------------------------------------------------------------

export class ReducerManager implements ManagementHandler {
  // ReducerManager is stateless at the instance level — all mutable state lives
  // in the module-level `reentryEligible` Map. A single instance can safely
  // be reused across all Reducer personalities without interference.

  // ---------------------------------------------------------------------------
  // openPosition
  // ---------------------------------------------------------------------------

  /**
   * Opens a new paper trade for the given personality.
   *
   * Identical to HolderManager.openPosition: convert numeric TradeIntent fields
   * to the string NUMERIC format expected by EntryIntent and delegate to
   * executor.openTrade().
   *
   * lotSize defaults to 50 (NIFTY Phase 1 standard). Phase 2 will pass this
   * explicitly via a per-personality config field once BankNifty/Sensex are
   * supported.
   */
  async openPosition(
    intent: TradeIntent,
    executor: PaperTradeExecutor,
    _clock: Clock,
  ): Promise<string> {
    const entryIntent = {
      straddleValue: String(intent.straddleValue),
      atmStrike: intent.atmStrike,
      // Phase 1 only supports NIFTY — validated upstream by PersonalityRouter.
      underlying: "NIFTY" as const,
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
   * Evaluates whether the Reducer position should be closed.
   *
   * Cut trigger is checked first:
   *   |currentSpot - spot_at_entry| >= cut_trigger_points → CUT
   *
   * If the cut trigger does not fire, we delegate entirely to evaluateTriggers()
   * for the standard SL/TSL/TARGET/EOD/DAILY_LOSS/EXIT_WINDOW checks — identical
   * to HolderManager's behaviour.
   *
   * Why we query spot_at_entry from DB:
   *   OpenPosition does not carry spot_at_entry (it is not needed by the
   *   trigger engine). Rather than widen the shared interface, we do a targeted
   *   single-row SELECT here. See the module-level design note for rationale.
   *
   * Why currentSpot is passed in as a number:
   *   It comes from the straddle snapshot Redis message (already parsed by
   *   PositionMonitor as a float) — no additional conversion needed.
   */
  async evaluatePosition(
    position: OpenPosition,
    currentStraddleValue: number,
    currentSpot: number,
    clock: Clock,
    triggerConfig: TriggerConfig,
    db: Pool,
    personality: PersonalityConfig,
  ): Promise<{ shouldExit: boolean; exitReason?: string }> {
    // --- Cut trigger ---
    // Fetch spot_at_entry from the DB for this trade.
    // We SELECT only the one field we need to keep the query tight.
    const spotRow = await db.query<{ spot_at_entry: string | null }>(
      "SELECT spot_at_entry FROM paper_trades WHERE id = $1",
      [position.id],
    );

    const spotAtEntryRaw = spotRow.rows[0]?.spot_at_entry;

    // Only apply the cut trigger when we have a valid entry spot. If the row is
    // missing (should not happen for open trades) or spot_at_entry is NULL
    // (pre-M2 trades that were opened before the column existed), we skip the
    // cut trigger and fall through to evaluateTriggers — a safe, conservative
    // fallback that avoids a spurious CUT on bad data.
    if (spotAtEntryRaw !== undefined && spotAtEntryRaw !== null) {
      const spotAtEntry = Number(spotAtEntryRaw);

      // Default cut_trigger_points = 70 (NIFTY index points). Pulled from
      // personality.params so it can be tuned per personality via the evolution
      // engine without a code change.
      const cutTriggerPoints =
        typeof personality.params.cut_trigger_points === "number"
          ? personality.params.cut_trigger_points
          : 70;

      const spotsFromEntry = Math.abs(currentSpot - spotAtEntry);

      if (spotsFromEntry >= cutTriggerPoints) {
        return { shouldExit: true, exitReason: "CUT" };
      }
    }

    // --- Standard trigger evaluation ---
    // Delegate to the shared trigger engine for SL/TSL/TARGET/EOD/DAILY_LOSS/EXIT_WINDOW.
    // We pass currentStraddleValue as a string to match the trigger engine's
    // NUMERIC wire-format convention (see trigger-engine.ts).
    const decision = evaluateTriggers(
      position,
      String(currentStraddleValue),
      clock,
      triggerConfig,
    );

    if (decision.shouldExit) {
      return { shouldExit: true, exitReason: decision.reason };
    }

    return { shouldExit: false };
  }

  // ---------------------------------------------------------------------------
  // closePosition
  // ---------------------------------------------------------------------------

  /**
   * Closes the position via the executor, then records re-entry eligibility
   * state when the exit reason is 'CUT'.
   *
   * Only CUT exits set re-entry eligible — SL/TSL/TARGET/EOD exits indicate the
   * position ran its natural course and no special re-entry logic applies.
   *
   * db is received but not used directly: executor.closeTrade() reads the trade
   * data it needs internally (see paper-trade-executor.ts design note). It is in
   * the signature to satisfy the ManagementHandler interface (T-29 / AdjusterManager
   * may need direct DB access for rolling logic).
   */
  async closePosition(
    position: OpenPosition,
    currentStraddleValue: number,
    exitReason: string,
    _db: Pool,
    clock: Clock,
    executor: PaperTradeExecutor,
  ): Promise<void> {
    // Close the trade. exitReason is forwarded verbatim to paper_trades.exit_reason.
    await executor.closeTrade(position.id, String(currentStraddleValue), exitReason, clock);

    // Set re-entry eligibility only when the exit was a CUT.
    // Other exits (SL, TARGET, EOD, etc.) are terminal — the personality should
    // wait for the next trading day rather than immediately looking for a re-entry.
    if (exitReason === "CUT") {
      // personalityId is not on OpenPosition — it is on the extended
      // OpenPositionWithPersonality type used by PositionMonitor. ReducerManager
      // accesses it via a type cast because the interface only guarantees OpenPosition.
      // In production, PositionMonitor always passes an OpenPositionWithPersonality
      // (it adds personalityId to every row). A missing personalityId means we cannot
      // track re-entry state for this trade — log a warning and skip.
      const extendedPosition = position as OpenPosition & { personalityId?: string | null };
      const personalityId = extendedPosition.personalityId;

      if (personalityId) {
        const todayIST = getISTDateStr(clock.now());
        reentryEligible.set(personalityId, { date: todayIST });
        console.log(
          `[ReducerManager] Personality ${personalityId} is now re-entry eligible for ${todayIST}`,
        );
      } else {
        // CUT trade with no personality association — cannot track re-entry state.
        // This should not happen in normal operation (all Reducer trades have a
        // personality_id) but we log rather than throw to avoid crashing the loop.
        console.warn(
          `[ReducerManager] CUT trade ${position.id} has no personalityId — re-entry state not set`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Static re-entry state helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns true if the given personality has had a CUT exit today (IST date).
   *
   * Date-change detection is automatic: a state entry from a previous day has a
   * different YYYY-MM-DD string and therefore returns false without explicit
   * cleanup. PersonalityRouter calls this before deciding whether to use the
   * lower reentry_min_probability threshold.
   *
   * @param personalityId   UUID of the personality to check.
   * @param todayIST        'YYYY-MM-DD' in IST for the current trading day.
   *                        Passed in rather than computed here so that callers
   *                        can reuse the same Clock.today() value they already
   *                        have — avoids a redundant call per signal.
   */
  static isReentryEligible(personalityId: string, todayIST: string): boolean {
    const state = reentryEligible.get(personalityId);
    // State is absent → not eligible.
    // State date differs from today → stale (prior trading day) → not eligible.
    return state?.date === todayIST;
  }

  /**
   * Clears the re-entry eligibility state for a personality after the re-entry
   * trade has been successfully opened. PersonalityRouter calls this once the
   * new straddle is live.
   *
   * After calling this, isReentryEligible returns false until the next CUT.
   */
  static clearReentry(personalityId: string): void {
    reentryEligible.delete(personalityId);
  }

  /**
   * Explicitly resets the re-entry state for a personality at EOD.
   *
   * Called by PositionMonitor or PersonalityRouter during the end-of-day reset
   * cycle. In practice, the date-check in isReentryEligible makes stale state
   * inert across a day boundary, but this method allows a proactive cleanup to
   * keep the Map size bounded. Especially important if the same process runs
   * across multiple trading days without a restart.
   */
  static resetReentryState(personalityId: string): void {
    reentryEligible.delete(personalityId);
  }
}
