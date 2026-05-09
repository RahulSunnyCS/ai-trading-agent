import { query } from '../db/client';
import { calcGrossPnl, calcNetPnl, LOT_SIZE } from './pnl-calc';
import type { Underlying, PaperTrade, PersonalityConfig, ExitReason } from '../db/schema';

// ── Exit decision ──────────────────────────────────────────────────────────────

export type ExitDecision =
  | { action: 'hold' }
  | { action: 'close'; reason: ExitReason }
  | { action: 'roll' }
  | { action: 'cut' };

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Evaluates all open trades for a given underlying and applies exit/management
 * actions. Called every 30 seconds during market hours.
 */
export async function manageTrades(
  underlying: Underlying,
  currentPrices: Map<string, number>,
  personalities: Map<string, PersonalityConfig>,
): Promise<void> {
  const openTrades = await loadOpenTrades(underlying);
  for (const trade of openTrades) {
    const personality = personalities.get(trade.personality_id ?? '');
    if (!personality) continue;
    await processTrade(trade, personality, currentPrices);
  }
}

/**
 * Closes all open trades at EOD with exit_reason = 'EOD'.
 */
export async function closeAllAtEod(
  underlying: Underlying,
  currentPrices: Map<string, number>,
): Promise<void> {
  const openTrades = await loadOpenTrades(underlying);
  for (const trade of openTrades) {
    await closeTrade(trade, currentPrices, 'EOD', new Date());
  }
  if (openTrades.length > 0) {
    console.log(`[manager] EOD close: ${openTrades.length} trades closed for ${underlying}`);
  }
}

// ── Pure exit evaluation (exported for testing) ────────────────────────────────

export interface ExitEvalInput {
  trade:                PaperTrade;
  personality:          PersonalityConfig;
  currentStraddleValue: number;
  markToMarket:         number;  // current gross P&L (negative = loss)
}

/**
 * Pure function: given current state, returns the exit decision.
 * No side effects — safe to unit test without DB.
 */
export function evaluateExitConditions(input: ExitEvalInput): ExitDecision {
  const { trade, personality, currentStraddleValue, markToMarket } = input;
  const entryStraddle = trade.straddle_at_entry ?? 0;

  // ── Stop Loss ─────────────────────────────────────────────────────────────
  // SL fires when mark-to-market loss exceeds 60% of max_daily_loss
  const slThreshold = -(personality.max_daily_loss * 0.6);
  if (markToMarket <= slThreshold) {
    return { action: 'close', reason: 'SL' };
  }

  // ── Target ────────────────────────────────────────────────────────────────
  // Target: straddle decays to 30% of entry value (70% decay)
  if (entryStraddle > 0 && currentStraddleValue <= entryStraddle * 0.30) {
    return { action: 'close', reason: 'TARGET' };
  }

  // ── Trailing Stop Loss ────────────────────────────────────────────────────
  // TSL activates after ≥ 200pt straddle decay (profit secured).
  // Then closes if straddle recovers to > 70% of entry value.
  const straddleDecay = entryStraddle - currentStraddleValue;
  const tslActivationDecay = 200;
  if (
    straddleDecay >= tslActivationDecay &&
    currentStraddleValue >= entryStraddle * 0.70
  ) {
    return { action: 'close', reason: 'TSL' };
  }

  // ── Management actions (Adjuster/Blitz = ROLL, Reducer/Levelhead = CUT) ──
  const triggerPoints = personality.adjustment_trigger_points;
  if (triggerPoints != null && entryStraddle > 0) {
    const straddleMove = Math.abs(currentStraddleValue - entryStraddle);
    if (straddleMove >= triggerPoints) {
      if (personality.management_style === 'ROLL') return { action: 'roll' };
      if (personality.management_style === 'CUT_REENTER') return { action: 'cut' };
    }
  }

  return { action: 'hold' };
}

// ── Private helpers ────────────────────────────────────────────────────────────

async function processTrade(
  trade: PaperTrade,
  personality: PersonalityConfig,
  currentPrices: Map<string, number>,
): Promise<void> {
  const { cePrice, pePrice } = getCurrentLegPrices(trade, currentPrices);
  if (cePrice == null || pePrice == null) return; // prices not yet available

  const currentStraddleValue = cePrice + pePrice;
  const entryStraddle = trade.straddle_at_entry ?? currentStraddleValue;
  const markToMarket  = calcGrossPnl(
    trade.underlying,
    entryStraddle,
    currentStraddleValue,
    trade.lots,
    trade.position_multiplier,
  );

  const decision = evaluateExitConditions({
    trade, personality, currentStraddleValue, markToMarket,
  });

  switch (decision.action) {
    case 'close':
      await closeTrade(trade, currentPrices, decision.reason, new Date());
      break;
    case 'roll':
      console.log(`[manager] ${personality.name} ROLL triggered for trade ${trade.id} — straddle moved from ${entryStraddle} to ${currentStraddleValue}`);
      // Roll logic: update position to new ATM strikes (simplified — update entry straddle reference)
      await query(
        `UPDATE paper_trades SET straddle_at_entry = $1 WHERE id = $2`,
        [currentStraddleValue, trade.id],
      );
      break;
    case 'cut':
      await closeTrade(trade, currentPrices, 'MANUAL', new Date());
      console.log(`[manager] ${personality.name} CUT triggered for trade ${trade.id}`);
      break;
    default:
      break;
  }
}

async function closeTrade(
  trade: PaperTrade,
  currentPrices: Map<string, number>,
  reason: ExitReason,
  exitTime: Date,
): Promise<void> {
  const { cePrice, pePrice } = getCurrentLegPrices(trade, currentPrices);
  const exitCe = cePrice ?? 0;
  const exitPe = pePrice ?? 0;

  const entryStraddle = trade.straddle_at_entry ?? ((trade.entry_ce_price ?? 0) + (trade.entry_pe_price ?? 0));
  const exitStraddle  = exitCe + exitPe;
  const grossPnl = calcGrossPnl(trade.underlying, entryStraddle, exitStraddle, trade.lots, trade.position_multiplier);
  const netPnl   = calcNetPnl(trade.underlying, grossPnl, trade.lots);

  await query(
    `UPDATE paper_trades
        SET status = 'closed', exit_time = $1, exit_reason = $2,
            exit_ce_price = $3, exit_pe_price = $4,
            gross_pnl = $5, net_pnl = $6
      WHERE id = $7`,
    [exitTime, reason, exitCe, exitPe, grossPnl, netPnl, trade.id],
  );

  console.log(`[manager] Trade ${trade.id} closed — reason: ${reason} gross: ${grossPnl.toFixed(0)} net: ${netPnl.toFixed(0)}`);
}

function getCurrentLegPrices(
  trade: PaperTrade,
  currentPrices: Map<string, number>,
): { cePrice: number | null; pePrice: number | null } {
  // The CE/PE symbols are reconstructed from trade context.
  // For simplicity in the price lookup we search for keys matching the underlying + strike.
  // A production version would store the exact symbol on the trade.
  let cePrice: number | null = null;
  let pePrice: number | null = null;

  for (const [sym, price] of currentPrices) {
    if (sym.endsWith('CE') && sym.includes(String(trade.entry_ce_strike ?? ''))) cePrice = price;
    if (sym.endsWith('PE') && sym.includes(String(trade.entry_pe_strike ?? ''))) pePrice = price;
  }
  return { cePrice, pePrice };
}

async function loadOpenTrades(underlying: Underlying): Promise<PaperTrade[]> {
  return query<PaperTrade>(
    `SELECT * FROM paper_trades WHERE status = 'open' AND underlying = $1`,
    [underlying],
  );
}
