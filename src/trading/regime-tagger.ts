import type { MarketRegime } from '../db/schema';

export interface RegimeInputs {
  indexMovePct: number;   // (close − open) / open × 100, signed
  vix: number;
  intraSwingPct: number;  // (high − low) / open × 100, always positive
  meanReverted: boolean;  // large intraday move reversed before close
  isEventDay: boolean;    // RBI policy / budget / F&O expiry morning / macro
}

/**
 * Tag the market regime for a trading day.
 *
 * Priority order (first match wins):
 *   EVENT_DAY          — calendar flag overrides everything
 *   TRENDING_STRONG    — index moved ≥ 1% directionally
 *   VOLATILE_REVERTING — large intraday swing (≥ 1.5%) that mean-reverted
 *   RANGING            — default: small move, VIX stable
 */
export function tagRegime(inputs: RegimeInputs): MarketRegime {
  if (inputs.isEventDay) return 'EVENT_DAY';
  if (Math.abs(inputs.indexMovePct) >= 1.0) return 'TRENDING_STRONG';
  if (inputs.intraSwingPct >= 1.5 && inputs.meanReverted) return 'VOLATILE_REVERTING';
  return 'RANGING';
}
