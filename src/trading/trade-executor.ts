import { query } from '../db/client';
import { getAtmStrike } from '../ingestion/straddle-calc';
import { buildFyersSymbol } from '../ingestion/brokers/instrument-registry';
import { checkPersonalityFilters } from './personality-engine';
import { loadActivePersonalities, invalidatePersonalityCache } from './personality-cache';
import type { Underlying, PersonalityConfig, StraddleSignal, MarketRegime } from '../db/schema';
import type { TradeContext } from './personality-engine';

export { loadActivePersonalities, invalidatePersonalityCache } from './personality-cache';

// ── Shared context for a single execution pass ─────────────────────────────────

export interface ExecutionContext {
  underlying:     Underlying;
  expiry:         Date;
  currentPrices:  Map<string, number>;  // Fyers symbol → LTP
  vix:            number | null;
  currentRegime:  MarketRegime | null;
  currentTime:    Date;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Routes a momentum exhaustion signal to all active personalities that pass
 * the 5-stage filter. Opens a paper_trade row for each match.
 * Clockwork and FIXED_TIME personalities are excluded (they use scheduled entries).
 */
export async function executeSignalEntry(
  signal: StraddleSignal,
  ctx: ExecutionContext,
): Promise<void> {
  const personalities = await loadActivePersonalities(ctx.underlying);
  const signalPersonalities = personalities.filter(
    (p) => p.entry_type !== 'FIXED_TIME',
  );

  for (const personality of signalPersonalities) {
    const dailyState = await getDailyState(personality.id, ctx.currentTime);
    const tradeCtx: TradeContext = {
      signal,
      currentTime:       ctx.currentTime,
      dailyTradeCount:   dailyState.tradeCount,
      dailyPnl:          dailyState.pnl,
      consecutiveLosses: dailyState.consecutiveLosses,
      currentVix:        ctx.vix,
      currentRegime:     ctx.currentRegime,
      recentPnl5Days:    await getRecentPnl(personality.id, ctx.currentTime, 5),
    };

    const result = checkPersonalityFilters(personality, tradeCtx);
    if (!result.pass) {
      console.log(`[executor] ${personality.name} blocked stage ${result.stage}: ${result.reason}`);
      continue;
    }

    await openTrade(personality, signal, ctx, signal.atm_strike);
  }
}

/**
 * Fixed-time entries for FIXED_TIME personalities (Clockwork + Learning personalities).
 * Called at 9:17 AM IST. Clockwork enters regardless of signals.
 */
export async function executeScheduledEntries(ctx: ExecutionContext): Promise<void> {
  const personalities = await loadActivePersonalities(ctx.underlying);
  const fixedPersonalities = personalities.filter(
    (p) => p.entry_type === 'FIXED_TIME',
  );

  const spot = getSpotPrice(ctx);
  if (spot == null) {
    console.warn('[executor] No spot price available for scheduled entries');
    return;
  }

  const atmStrike = getAtmStrike(spot, ctx.underlying);

  for (const personality of fixedPersonalities) {
    const dailyState = await getDailyState(personality.id, ctx.currentTime);
    const tradeCtx: TradeContext = {
      signal: null,                        // scheduled entry — no signal
      currentTime:       ctx.currentTime,
      dailyTradeCount:   dailyState.tradeCount,
      dailyPnl:          dailyState.pnl,
      consecutiveLosses: dailyState.consecutiveLosses,
      currentVix:        ctx.vix,
      currentRegime:     ctx.currentRegime,
      recentPnl5Days:    0,                // profit gate not applicable for FIXED_TIME
    };

    const result = checkPersonalityFilters(personality, tradeCtx);
    if (!result.pass) {
      console.log(`[executor] ${personality.name} scheduled blocked: ${result.reason}`);
      continue;
    }

    await openTrade(personality, null, ctx, atmStrike);
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────────

async function openTrade(
  personality: PersonalityConfig,
  signal: StraddleSignal | null,
  ctx: ExecutionContext,
  atmStrike: number,
): Promise<void> {
  const { underlying, expiry, currentPrices, vix, currentRegime, currentTime } = ctx;

  const ceSymbol = buildFyersSymbol({ underlying, expiry, strike: atmStrike, optionType: 'CE' });
  const peSymbol = buildFyersSymbol({ underlying, expiry, strike: atmStrike, optionType: 'PE' });

  const cePrice = currentPrices.get(ceSymbol);
  const pePrice = currentPrices.get(peSymbol);

  if (cePrice == null || pePrice == null) {
    console.warn(`[executor] Missing prices for ${underlying} ATM ${atmStrike} — skipping ${personality.name}`);
    return;
  }

  const spot = getSpotPrice(ctx);

  await query(
    `INSERT INTO paper_trades
       (personality_id, signal_id, strategy_id, underlying, expiry, entry_time, status,
        entry_ce_strike, entry_ce_price, entry_pe_strike, entry_pe_price,
        lots, position_multiplier,
        vix_at_entry, spot_at_entry, straddle_at_entry, market_regime, has_event_flag)
     VALUES ($1,$2,$3,$4,$5,$6,'open',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [
      personality.id,
      signal?.id ?? null,
      signal ? 2 : 1,           // strategy_id: 2=momentum, 1=fixed-time/scheduled
      underlying,
      expiry,
      currentTime,
      atmStrike,
      cePrice,
      atmStrike,
      pePrice,
      1,                         // lots — single lot per trade
      personality.position_multiplier,
      vix,
      spot,
      cePrice + pePrice,
      currentRegime,
      false,
    ],
  );

  console.log(`[executor] ${personality.name} entered ${underlying} ${atmStrike} straddle @ ${(cePrice + pePrice).toFixed(1)}`);
}

function getSpotPrice(ctx: ExecutionContext): number | null {
  const { underlying, currentPrices } = ctx;
  // Index symbol pattern: NSE:NIFTY-INDEX, NSE:NIFTYBANK-INDEX, BSE:SENSEX-INDEX
  const INDEX_SYMBOLS: Record<string, string> = {
    NIFTY: 'NSE:NIFTY-INDEX', BANKNIFTY: 'NSE:NIFTYBANK-INDEX', SENSEX: 'BSE:SENSEX-INDEX',
  };
  const sym = INDEX_SYMBOLS[underlying];
  return sym ? (currentPrices.get(sym) ?? null) : null;
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

interface DailyState {
  tradeCount:        number;
  pnl:               number;
  consecutiveLosses: number;
}

async function getDailyState(personalityId: string, now: Date): Promise<DailyState> {
  const today = now.toISOString().slice(0, 10);
  const rows = await query<{
    trade_count: string;
    total_pnl:   string;
  }>(
    `SELECT COUNT(*) AS trade_count, COALESCE(SUM(net_pnl), 0) AS total_pnl
       FROM paper_trades
      WHERE personality_id = $1
        AND entry_time::date = $2`,
    [personalityId, today],
  );
  const tradeCount = parseInt(rows[0]?.trade_count ?? '0', 10);
  const pnl        = parseFloat(rows[0]?.total_pnl ?? '0');

  // Consecutive losses: look at last N closed trades in order
  const lossRows = await query<{ net_pnl: string }>(
    `SELECT net_pnl FROM paper_trades
      WHERE personality_id = $1 AND status = 'closed'
      ORDER BY exit_time DESC LIMIT 5`,
    [personalityId],
  );

  let consecutiveLosses = 0;
  for (const row of lossRows) {
    if (parseFloat(row.net_pnl) < 0) consecutiveLosses++;
    else break;
  }

  return { tradeCount, pnl, consecutiveLosses };
}

async function getRecentPnl(
  personalityId: string,
  now: Date,
  days: number,
): Promise<number> {
  const rows = await query<{ total: string }>(
    `SELECT COALESCE(SUM(net_pnl), 0) AS total
       FROM paper_trades
      WHERE personality_id = $1
        AND status = 'closed'
        AND exit_time >= NOW() - INTERVAL '${days} days'`,
    [personalityId],
  );
  return parseFloat(rows[0]?.total ?? '0');
}
