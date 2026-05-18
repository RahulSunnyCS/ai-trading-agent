/**
 * Trigger / exit engine for open short-straddle positions.
 *
 * SIGN CONVENTION (short straddle):
 *   We SOLD the straddle and collected premium upfront.
 *   - Profit  = straddle value FALLS below entry  (we buy it back cheaper)
 *   - Loss    = straddle value RISES above entry   (we buy it back more expensively)
 *
 * This module is intentionally PURE (except loadTriggerConfig which reads env vars).
 * No DB access, no async, no side effects inside evaluateTriggers or updateTrailingStop.
 * All state is passed in as parameters so the functions are trivially testable.
 */

import Decimal from "decimal.js";
import type { OpenPosition } from "../db/schema.js";
import type { Clock } from "../utils/clock.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for all exit triggers. All percentages are decimal fractions
 * (e.g. 0.30 = 30%). Loaded once at startup via loadTriggerConfig().
 */
export interface TriggerConfig {
  /** Stop-loss: exit if straddle rises this far above entry. Default 0.30 (30%). */
  hardSlPct: number;
  /** Trailing stop: exit if straddle rises this far above lowestStraddleValueSeen. Default 0.15 (15%). */
  trailingSlPct: number;
  /** Profit target: exit if straddle falls this far below entry. Default 0.30 (30%). */
  profitTargetPct: number;
  /** EOD square-off time in IST as 'HH:MM'. Positions are closed at or after this time. Default '15:25'. */
  eodExitTime: string;
  /** Hard cutoff in IST as 'HH:MM'. No new exits beyond this time (used downstream by entry engine). Default '15:30'. */
  exitCutoffTime: string;
  /** Maximum total daily loss in absolute currency units (e.g. '10000' = ₹10 000). Default '10000'. */
  maxDailyLoss: string;
}

/**
 * Exit decision returned by evaluateTriggers.
 * A discriminated union so callers must handle both cases explicitly.
 */
export type ExitDecision =
  | { shouldExit: true; reason: "SL" | "TSL" | "TARGET" | "EOD" | "DAILY_LOSS" | "EXIT_WINDOW" }
  | { shouldExit: false };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extracts 'HH:MM' from a full IST time string that may be 'HH:MM:SS'.
 * clock.toISTTime() returns 'HH:mm:ss' (with seconds). The config times are
 * stored as 'HH:MM' (without seconds). To compare "current time >= threshold"
 * correctly, we need both sides in the same format. Truncating to HH:MM
 * means we trigger at the start of the configured minute, which is the
 * desired behaviour (e.g. '15:25' fires the moment 15:25:00 begins).
 */
function toHHMM(istTimeStr: string): string {
  // Take only the first 5 characters: "15:25" from "15:25:00"
  return istTimeStr.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Core: evaluateTriggers
// ---------------------------------------------------------------------------

/**
 * Pure function: given the current state of an open position and the current
 * straddle value, returns an ExitDecision.
 *
 * Priority (when multiple triggers fire simultaneously):
 *   SL > DAILY_LOSS > EOD > EXIT_WINDOW > TSL > TARGET
 *
 * Rationale for priority order:
 * - SL first: hard stop-loss is a loss-limiting emergency — always overrides.
 * - DAILY_LOSS second: account-level risk cap is more important than trade-level
 *   profit/time considerations.
 * - EOD before EXIT_WINDOW: EOD square-off is the intended graceful close; EXIT_WINDOW
 *   is the hard boundary that prevents re-entry, but EOD fires earlier.
 * - TSL before TARGET: trailing stop captures partial profit when price reverses; if
 *   both fire, TSL implies we are still profitable but reversing — take the partial win.
 * - TARGET last: cleanest exit scenario, lowest urgency relative to the above.
 */
export function evaluateTriggers(
  position: OpenPosition,
  currentStraddleValue: string,
  clock: Clock,
  config: TriggerConfig,
): ExitDecision {
  const current = new Decimal(currentStraddleValue);
  const entry = new Decimal(position.entryStraddleValue);
  const lowest = new Decimal(position.lowestStraddleValueSeen);
  const todayPnl = new Decimal(position.todayNetPnl);
  const maxLoss = new Decimal(config.maxDailyLoss);

  // Current IST time as 'HH:MM' for string comparison against config thresholds.
  // Lexicographic comparison works correctly for same-day times in HH:MM format
  // because the hour and minute fields are zero-padded to fixed width.
  const nowHHMM = toHHMM(clock.toISTTime(clock.now()));

  // --- 1. Hard SL ---
  // Straddle has risen X% above entry — we are losing money and must exit.
  // threshold = entry * (1 + hardSlPct)
  const hardSlThreshold = entry.mul(new Decimal(1).add(config.hardSlPct));
  if (current.gte(hardSlThreshold)) {
    return { shouldExit: true, reason: "SL" };
  }

  // --- 2. Daily loss cap ---
  // todayNetPnl is negative when we are losing. Exit if loss exceeds maxDailyLoss.
  // Condition: todayNetPnl <= -maxDailyLoss
  if (todayPnl.lte(new Decimal("-1").mul(maxLoss))) {
    return { shouldExit: true, reason: "DAILY_LOSS" };
  }

  // --- 3. EOD square-off ---
  // Force-close all positions at or after the configured EOD time to avoid
  // overnight/post-market exposure. Indian weekly options can lose value
  // dramatically after market hours so this is a hard risk rule.
  if (nowHHMM >= config.eodExitTime) {
    return { shouldExit: true, reason: "EOD" };
  }

  // --- 4. Exit cutoff window ---
  // Hard boundary: no positions should remain open beyond this time.
  // This fires after EOD in priority, but in practice exitCutoffTime > eodExitTime
  // so EOD will have already fired. This is a safety net if config is unusual.
  if (nowHHMM >= config.exitCutoffTime) {
    return { shouldExit: true, reason: "EXIT_WINDOW" };
  }

  // --- 5. Trailing stop-loss ---
  // Only applies when we are in profit territory (current < entry).
  // If the straddle has recovered to within trailingSlPct% of its lowest point,
  // we lock in the partial profit to prevent a full reversal back to a loss.
  //
  // trailingThreshold = lowestStraddleValueSeen * (1 + trailingSlPct)
  // Guard: current < entry ensures we only trail when profitable (short straddle).
  // TSL only applies when current < entry (we are in profit territory on a short straddle).
  // Without this guard, TSL would fire incorrectly when the position is at a loss —
  // which would cause premature exits that the hard SL should handle instead.
  const trailingThreshold = lowest.mul(new Decimal(1).add(config.trailingSlPct));
  if (current.gte(trailingThreshold) && current.lt(entry)) {
    return { shouldExit: true, reason: "TSL" };
  }

  // --- 6. Profit target ---
  // Straddle has fallen X% below entry — we have hit the desired profit level.
  // threshold = entry * (1 - profitTargetPct)
  const profitTargetThreshold = entry.mul(new Decimal(1).sub(config.profitTargetPct));
  if (current.lte(profitTargetThreshold)) {
    return { shouldExit: true, reason: "TARGET" };
  }

  // No trigger fired — hold the position.
  return { shouldExit: false };
}

// ---------------------------------------------------------------------------
// Trailing stop updater
// ---------------------------------------------------------------------------

/**
 * Pure function: returns the new lowestStraddleValueSeen after observing
 * the current straddle value. The trailing stop tracks the lowest value ever
 * seen so that the TSL trigger can detect reversals from the best point.
 *
 * Since this is a SHORT straddle, lower straddle value = better position for us.
 * We want the minimum (best) value we have ever seen.
 */
export function updateTrailingStop(position: OpenPosition, currentStraddleValue: string): string {
  const current = new Decimal(currentStraddleValue);
  const previousLowest = new Decimal(position.lowestStraddleValueSeen);

  // Return whichever is smaller, preserving the string representation.
  // Decimal.min() returns a Decimal; .toString() preserves full precision
  // without floating-point rounding.
  return Decimal.min(current, previousLowest).toString();
}

// ---------------------------------------------------------------------------
// Config loader (non-pure — reads env vars)
// ---------------------------------------------------------------------------

/**
 * Reads trigger configuration from environment variables with documented defaults.
 * Called once at application startup; the returned object is then passed to
 * evaluateTriggers on every tick.
 *
 * Percentages are stored as decimal fractions in the env vars (e.g. "0.30" for 30%).
 * Parsing them with parseFloat is safe here because we convert to Decimal inside
 * evaluateTriggers before any arithmetic; the float is only used as a config holder.
 */
export function loadTriggerConfig(): TriggerConfig {
  return {
    hardSlPct: Number.parseFloat(process.env.HARD_SL_PCT ?? "0.3"),
    trailingSlPct: Number.parseFloat(process.env.TRAILING_SL_PCT ?? "0.15"),
    profitTargetPct: Number.parseFloat(process.env.PROFIT_TARGET_PCT ?? "0.3"),
    eodExitTime: process.env.EOD_EXIT_TIME ?? "15:25",
    exitCutoffTime: process.env.EXIT_CUTOFF_TIME ?? "15:30",
    maxDailyLoss: process.env.MAX_DAILY_LOSS ?? "10000",
  };
}
