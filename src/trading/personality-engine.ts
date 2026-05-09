import type { PersonalityConfig, StraddleSignal, MarketRegime } from '../db/schema';

// ── Context ────────────────────────────────────────────────────────────────────

export interface TradeContext {
  signal:              StraddleSignal | null; // null = scheduled/fixed-time entry
  currentTime:         Date;
  dailyTradeCount:     number;
  dailyPnl:            number;               // negative = cumulative loss today
  consecutiveLosses:   number;
  currentVix:          number | null;
  currentRegime:       MarketRegime | null;
  recentPnl5Days:      number;               // sum of net_pnl last 5 trading days
}

// ── Result ─────────────────────────────────────────────────────────────────────

export type FilterResult =
  | { pass: true }
  | { pass: false; stage: 1 | 2 | 3 | 4 | 5; reason: string };

// ── Market cutoff ──────────────────────────────────────────────────────────────
// No new entries after 15:00 IST (orders too close to 15:30 close)
const CUTOFF_IST_MINUTES = 15 * 60; // 15:00

function istMinutes(utcDate: Date): number {
  return (utcDate.getUTCHours() * 60 + utcDate.getUTCMinutes() + 330) % (24 * 60);
}

// ── Core filter ────────────────────────────────────────────────────────────────

/**
 * Runs the 5-stage decision filter for a given personality and trade context.
 *
 * Stage 1 — Hard filters:    signal type allowed, time before cutoff
 * Stage 2 — Daily state:     trade count, daily P&L, consecutive losses
 * Stage 3 — Context:         VIX range, market regime
 * Stage 4 — Signal quality:  probability >= min_probability (skipped for scheduled entries)
 * Stage 5 — Profit gate:     recent 5-day P&L must meet threshold (if enabled)
 */
export function checkPersonalityFilters(
  personality: PersonalityConfig,
  context: TradeContext,
): FilterResult {
  const { signal, currentTime, dailyTradeCount, dailyPnl, consecutiveLosses,
          currentVix, currentRegime, recentPnl5Days } = context;

  // ── Stage 1: Hard filters ──────────────────────────────────────────────────

  const ist = istMinutes(currentTime);
  if (ist >= CUTOFF_IST_MINUTES) {
    return { pass: false, stage: 1, reason: 'after_trading_cutoff' };
  }

  if (signal && personality.allowed_strategies && personality.allowed_strategies.length > 0) {
    // Map signal type to strategy_id: 1=non-directional, 2=momentum, 3=pullback
    const strategyId = signalTypeToStrategyId(signal.signal_type);
    if (!personality.allowed_strategies.includes(strategyId)) {
      return { pass: false, stage: 1, reason: `signal_type_not_allowed:${signal.signal_type}` };
    }
  }

  // ── Stage 2: Daily state ───────────────────────────────────────────────────

  if (dailyTradeCount >= personality.max_daily_trades) {
    return { pass: false, stage: 2, reason: 'daily_trade_limit_reached' };
  }

  if (dailyPnl <= -personality.max_daily_loss) {
    return { pass: false, stage: 2, reason: 'daily_loss_limit_reached' };
  }

  if (consecutiveLosses >= 3) {
    return { pass: false, stage: 2, reason: 'consecutive_loss_limit_reached' };
  }

  // ── Stage 3: Context checks ────────────────────────────────────────────────

  if (currentVix != null) {
    if (currentVix < personality.min_vix) {
      return { pass: false, stage: 3, reason: `vix_below_min:${currentVix}<${personality.min_vix}` };
    }
    if (currentVix > personality.max_vix) {
      return { pass: false, stage: 3, reason: `vix_above_max:${currentVix}>${personality.max_vix}` };
    }
  }

  if (currentRegime != null && personality.allowed_regimes && personality.allowed_regimes.length > 0) {
    if (!personality.allowed_regimes.includes(currentRegime)) {
      return { pass: false, stage: 3, reason: `regime_not_allowed:${currentRegime}` };
    }
  }

  // ── Stage 4: Signal quality ────────────────────────────────────────────────
  // Scheduled (null signal) entries skip this stage

  if (signal != null && personality.min_probability != null) {
    const prob = signal.probability ?? 0;
    if (prob < personality.min_probability) {
      return {
        pass: false, stage: 4,
        reason: `probability_too_low:${prob.toFixed(2)}<${personality.min_probability}`,
      };
    }
  }

  // ── Stage 5: Profit gate ───────────────────────────────────────────────────

  if (personality.require_profit_gate && personality.profit_gate_amount != null) {
    if (recentPnl5Days < personality.profit_gate_amount) {
      return {
        pass: false, stage: 5,
        reason: `profit_gate_not_met:${recentPnl5Days}<${personality.profit_gate_amount}`,
      };
    }
  }

  return { pass: true };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function signalTypeToStrategyId(signalType: string): number {
  switch (signalType) {
    case 'SCHEDULED':            return 1;
    case 'MOMENTUM_EXHAUSTION':  return 2;
    case 'PULLBACK':             return 3;
    default:                     return 1;
  }
}
