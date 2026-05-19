import Decimal from "decimal.js";

/**
 * Calculate gross P&L for a SHORT straddle position.
 *
 * Sign convention (SHORT straddle):
 *   - We SOLD the straddle and collected premium at entry.
 *   - Profit = straddle value FALLS  (we buy it back cheaper → keep difference).
 *   - Loss   = straddle value RISES  (we buy it back more expensive → we owe the difference).
 *
 * Formula: grossPnl = (entryValue − exitValue) × lots × lotSize
 *
 * All arithmetic uses decimal.js to avoid IEEE-754 floating-point accumulation
 * errors — ₹0.05-tick option prices can drift meaningfully with plain JS math.
 *
 * @param entryStraddleValue  Combined straddle value (CE+PE) at entry, as a decimal string
 * @param exitStraddleValue   Combined straddle value at exit, as a decimal string
 * @param lots                Number of lots traded
 * @param lotSize             Lot size (e.g., 50 for NIFTY, 15 for BANKNIFTY post-2024 revision)
 * @returns grossPnl          Monetary P&L rounded to 2 decimal places, as a string
 * @returns isProfit          true when grossPnl > 0
 */
export function calculatePnl(
  entryStraddleValue: string,
  exitStraddleValue: string,
  lots: number,
  lotSize: number,
): { grossPnl: string; isProfit: boolean } {
  const entry = new Decimal(entryStraddleValue);
  const exit_ = new Decimal(exitStraddleValue);

  // (entry − exit) × lots × lotSize
  // Positive when exit < entry (straddle value fell → profit for short position).
  const grossPnl = entry.minus(exit_).mul(lots).mul(lotSize);

  return {
    grossPnl: grossPnl.toFixed(2),
    isProfit: grossPnl.gt(0),
  };
}
