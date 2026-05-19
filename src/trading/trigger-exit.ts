/**
 * Trigger/Exit Engine — T-16
 *
 * Pure logic module: evaluates whether an open short-straddle position should
 * be exited and returns the first matching exit reason.  No DB access, no
 * Redis, no side effects.  The position monitor (T-18) calls `evaluateExit`
 * on every tick.
 *
 * Short-straddle P&L semantics (important for understanding the conditions):
 *   - The seller COLLECTS premium when the straddle is entered.
 *   - Profit  : straddle value FALLS  (options decay / IV contracts).
 *   - Loss    : straddle value RISES  (large directional move / IV spike).
 *   - Target  : straddle has decayed by `targetPct` from entry → profit goal reached.
 *   - SL      : straddle has RISEN above entry by `stopLossPct`        → loss limit.
 *   - TSL     : straddle has RISEN from its running minimum by `trailingStopPct`
 *               → lock in partial profit when the market turns.
 *
 * IST = UTC + 5:30.  All time arithmetic uses UTC offsets — never the host TZ.
 */

import { type Clock, IST_OFFSET_MS } from '../utils/clock';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** All possible reasons for exiting a position. */
export type ExitReason =
  | 'daily_loss_cap'
  | 'eod_exit'
  | 'none'
  | 'stop_loss'
  | 'target_reached'
  | 'trailing_stop_loss';

/** Snapshot of an open short-straddle position at the time of evaluation. */
export interface Position {
  /** Straddle value recorded at entry (CE premium + PE premium). */
  entryStraddleValue: number;
  /** Latest mark-to-market straddle value (CE premium + PE premium). */
  currentStraddleValue: number;
  /** Unix milliseconds — moment of entry. */
  entryTimestamp: number;
  /**
   * Stop-loss threshold expressed as a fraction of entry value.
   * E.g. 0.20 means: exit when straddle rises ≥20% above entry.
   */
  stopLossPct: number;
  /**
   * Trailing-stop threshold expressed as a fraction of the running minimum.
   * E.g. 0.15 means: exit when straddle rises ≥15% above its lowest point
   * since entry (best P&L watermark).
   */
  trailingStopPct: number;
  /**
   * Profit-target threshold expressed as a fraction of entry value.
   * E.g. 0.30 means: exit when straddle has fallen ≥30% from entry.
   */
  targetPct: number;
  /**
   * Running minimum straddle value seen since entry.
   * Represents the best P&L point for the short straddle (lowest cost to
   * buy back).  Callers must update this via `updateHighWatermark` on each tick.
   *
   * The field is named `highWatermark` in the interface to match the
   * original spec; semantically it is the LOW watermark (minimum straddle).
   */
  highWatermark: number;
  /**
   * "HH:MM" in IST — forced end-of-day exit time.
   * E.g. "15:15".  Any current IST time >= this triggers an EOD exit.
   */
  eodExitIST: string;
}

/** Result returned by `evaluateExit`. */
export interface ExitDecision {
  shouldExit: boolean;
  reason: ExitReason;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a "HH:MM" string to minutes-since-midnight (an integer 0..1439).
 * Used for cheap numeric comparison without date objects.
 *
 * Throws on malformed input to surface misconfiguration early rather than
 * silently producing wrong exit decisions.
 */
function hhmmToMinutes(hhmm: string): number {
  // Split once and guard array access — noUncheckedIndexedAccess requires this.
  const parts = hhmm.split(':');
  const hourStr = parts[0];
  const minuteStr = parts[1];

  if (hourStr === undefined || minuteStr === undefined) {
    throw new Error(`Invalid HH:MM string: "${hhmm}"`);
  }

  const hours = Number(hourStr);
  const minutes = Number(minuteStr);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    throw new Error(`Non-numeric HH:MM string: "${hhmm}"`);
  }

  return hours * 60 + minutes;
}

/**
 * Return the current IST time as minutes-since-midnight.
 *
 * IST_OFFSET_MS is imported from clock.ts (= 5.5 * 60 * 60 * 1000).
 * We do UTC arithmetic on the adjusted timestamp — no host-TZ dependency.
 */
function currentISTMinutes(clock: Clock): number {
  const istMs = clock.timestamp() + IST_OFFSET_MS;
  const d = new Date(istMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Evaluate all exit conditions in priority order; return the first match.
 *
 * Priority (highest to lowest):
 *   1. EOD exit    — clock-based; must exit before market close regardless of P&L.
 *   2. Stop loss   — hard loss cap; straddle rose above entry by stopLossPct.
 *   3. Trailing SL — profit-lock; straddle rose from best P&L point by trailingStopPct.
 *   4. Target      — profit goal; straddle decayed below entry by targetPct.
 *   5. None        — hold the position.
 *
 * The function is intentionally pure: the same inputs always produce the same
 * output.  No mutable state is modified inside this function.
 */
export function evaluateExit(position: Position, clock: Clock): ExitDecision {
  // 1. EOD exit — time-based; always takes priority so we do not overstay.
  const nowIST = currentISTMinutes(clock);
  const eodMinutes = hhmmToMinutes(position.eodExitIST);

  if (nowIST >= eodMinutes) {
    return { shouldExit: true, reason: 'eod_exit' };
  }

  // 2. Stop loss — straddle has risen ABOVE entry by stopLossPct.
  //    For a short straddle, a rising straddle means a rising loss.
  //    Threshold: entry * (1 + stopLossPct).
  const slThreshold = position.entryStraddleValue * (1 + position.stopLossPct);

  if (position.currentStraddleValue >= slThreshold) {
    return { shouldExit: true, reason: 'stop_loss' };
  }

  // 3. Trailing stop loss — straddle has risen from its running minimum
  //    (highWatermark = lowest straddle seen = best P&L) by trailingStopPct.
  //    Threshold: highWatermark * (1 + trailingStopPct).
  //    Callers must keep highWatermark updated via updateHighWatermark().
  const tslThreshold = position.highWatermark * (1 + position.trailingStopPct);

  if (position.currentStraddleValue >= tslThreshold) {
    return { shouldExit: true, reason: 'trailing_stop_loss' };
  }

  // 4. Target reached — straddle has decayed by targetPct from entry.
  //    For the seller, a falling straddle = collected premium decaying = profit.
  //    Threshold: entry * (1 - targetPct).
  const targetThreshold = position.entryStraddleValue * (1 - position.targetPct);

  if (position.currentStraddleValue <= targetThreshold) {
    return { shouldExit: true, reason: 'target_reached' };
  }

  // 5. No exit condition met — hold the position.
  return { shouldExit: false, reason: 'none' };
}

/**
 * Update the running minimum straddle value (best P&L watermark for a short
 * straddle).
 *
 * Returns the lower of `current` and `existingWatermark`.  The caller stores
 * the returned value back into `position.highWatermark` before the next tick.
 *
 * Named "high watermark" in the spec to align with Position's field name; the
 * underlying concept is a minimum because a LOWER straddle = better P&L for
 * the seller.
 */
export function updateHighWatermark(current: number, existingWatermark: number): number {
  return Math.min(current, existingWatermark);
}
