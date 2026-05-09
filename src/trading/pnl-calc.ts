import type { Underlying } from '../db/schema';

// ── Lot sizes (NSE/BSE standard as of 2024) ────────────────────────────────────
export const LOT_SIZE: Record<Underlying, number> = {
  NIFTY:     75,
  BANKNIFTY: 35,
  SENSEX:    20,
};

// Fixed transaction cost per lot (brokerage + STT + stamp + exchange charges)
const COST_PER_LOT = 40;

// Assumed slippage per leg per lot-unit (buy+sell = 2 fills per side)
const SLIPPAGE_POINTS_PER_LEG = 1;

// ── P&L functions ──────────────────────────────────────────────────────────────

/**
 * Gross P&L for a short straddle (premium collected minus premium paid back).
 * Positive = profit (straddle decayed), negative = loss (straddle expanded).
 *
 *   gross = (entry_straddle - exit_straddle) × lots × lot_size × position_multiplier
 */
export function calcGrossPnl(
  underlying: Underlying,
  entryStraddlePrice: number,
  exitStraddlePrice: number,
  lots: number,
  positionMultiplier: number = 1,
): number {
  return (entryStraddlePrice - exitStraddlePrice) * lots * LOT_SIZE[underlying] * positionMultiplier;
}

/**
 * Net P&L after deducting brokerage and slippage.
 * 4 legs total (entry CE+PE buy, exit CE+PE buy) → 4× slippage.
 */
export function calcNetPnl(
  underlying: Underlying,
  grossPnl: number,
  lots: number,
): number {
  const brokerage  = COST_PER_LOT * lots;
  const slippage   = SLIPPAGE_POINTS_PER_LEG * 4 * lots * LOT_SIZE[underlying];
  return grossPnl - brokerage - slippage;
}

/**
 * Maximum adverse excursion — the lowest mark-to-market P&L seen during the trade.
 * Returns a negative number (or 0 if always profitable).
 */
export function calcMaxDrawdown(markToMarketSeries: number[]): number {
  if (markToMarketSeries.length === 0) return 0;
  return Math.min(0, ...markToMarketSeries);
}

/**
 * Maximum favorable excursion — the highest mark-to-market P&L seen during the trade.
 * Returns a positive number (or 0 if always losing).
 */
export function calcMfe(markToMarketSeries: number[]): number {
  if (markToMarketSeries.length === 0) return 0;
  return Math.max(0, ...markToMarketSeries);
}

/**
 * Brier score: mean squared error between predicted probability and actual binary outcome.
 *   score = (1/N) × Σ (predicted_prob − actual_outcome)²
 *
 * Lower is better. 0.0 = perfect calibration. Returns 0 for empty input.
 */
export function calcBrierScore(
  signals: Array<{ probability: number; won: boolean }>,
): number {
  if (signals.length === 0) return 0;
  const sumSq = signals.reduce((acc, s) => {
    const outcome = s.won ? 1 : 0;
    return acc + (s.probability - outcome) ** 2;
  }, 0);
  return sumSq / signals.length;
}
