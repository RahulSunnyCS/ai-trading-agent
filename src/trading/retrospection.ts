import { query } from '../db/client';
import { calcBrierScore } from './pnl-calc';
import type {
  Underlying, PaperTrade, StraddleSignal, PersonalityConfig,
  RetrospectionResult, MarketRegime, MgmtVerdict,
} from '../db/schema';

export { calcBrierScore } from './pnl-calc';

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Runs EOD analysis for all personalities for a given date and underlying.
 * Called at 15:45 IST after all trades are closed.
 */
export async function runDailyRetrospection(
  date: Date,
  underlying: Underlying,
): Promise<void> {
  const today = date.toISOString().slice(0, 10);

  const [personalities, trades, signals] = await Promise.all([
    query<PersonalityConfig>(`SELECT * FROM personality_configs WHERE is_active = TRUE`, []),
    query<PaperTrade>(
      `SELECT * FROM paper_trades
        WHERE underlying = $1
          AND entry_time::date = $2
          AND status = 'closed'`,
      [underlying, today],
    ),
    query<StraddleSignal>(
      `SELECT * FROM straddle_signals
        WHERE underlying = $1
          AND signal_time::date = $2`,
      [underlying, today],
    ),
  ]);

  // Clockwork P&L for this day (reference baseline)
  const clockwork      = personalities.find((p) => p.name === 'clockwork');
  const clockworkTrades = clockwork ? tradesForPersonality(trades, clockwork.id) : [];
  const clockworkPnl   = sumNetPnl(clockworkTrades);

  // Derive regime from today's signals/trades context (simplified: use trade market_regime)
  const regime = deriveRegime(trades) ?? 'RANGING';

  for (const personality of personalities) {
    const pTrades  = tradesForPersonality(trades, personality.id);
    const pSignals = signalsForPersonality(signals, pTrades);
    const result   = buildRetrospectionResult(personality, pTrades, pSignals, clockworkPnl, regime);

    // Evaluate evolution rule conditions
    const suggestedChanges = personality.is_frozen
      ? {}
      : await evaluateEvolutionRules(personality, pTrades, regime);

    await query(
      `INSERT INTO retrospection_results
         (analysis_date, personality_id, run_at, market_regime,
          total_trades, winning_trades, losing_trades, win_rate,
          total_pnl, avg_pnl_per_trade, max_drawdown,
          clockwork_pnl_today, beat_clockwork_by,
          signals_received, signals_acted_on, signal_brier_score,
          adjustments_made, mgmt_pnl_delta, mgmt_verdict,
          threshold_drift_flag, evolution_paused,
          insights, suggested_changes, applied)
       VALUES
         ($1,$2,NOW(),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
       ON CONFLICT (analysis_date, personality_id) DO UPDATE
         SET total_pnl = EXCLUDED.total_pnl,
             win_rate  = EXCLUDED.win_rate,
             suggested_changes = EXCLUDED.suggested_changes,
             run_at    = NOW()`,
      [
        today,
        personality.id,
        result.market_regime,
        result.total_trades,
        result.winning_trades,
        result.losing_trades,
        result.win_rate,
        result.total_pnl,
        result.avg_pnl_per_trade,
        result.max_drawdown,
        clockworkPnl,
        result.beat_clockwork_by,
        result.signals_received,
        result.signals_acted_on,
        result.signal_brier_score,
        result.adjustments_made,
        result.mgmt_pnl_delta,
        result.mgmt_verdict,
        result.threshold_drift_flag,
        result.evolution_paused,
        JSON.stringify(result.insights ?? {}),
        JSON.stringify(suggestedChanges),
        false,
      ],
    );

    console.log(`[retro] ${personality.name}: ${result.total_trades ?? 0} trades pnl=${result.total_pnl?.toFixed(0)} beat_clockwork=${result.beat_clockwork_by?.toFixed(0)}`);
  }
}

// ── Pure builders (exported for testing) ──────────────────────────────────────

export function buildRetrospectionResult(
  personality: PersonalityConfig,
  trades:  PaperTrade[],
  signals: StraddleSignal[],
  clockworkPnl: number,
  regime: MarketRegime,
): Omit<RetrospectionResult, 'id' | 'run_at'> {
  const totalTrades   = trades.length;
  const winningTrades = trades.filter((t) => (t.net_pnl ?? 0) > 0).length;
  const losingTrades  = trades.filter((t) => (t.net_pnl ?? 0) < 0).length;
  const winRate       = totalTrades > 0 ? winningTrades / totalTrades : undefined;
  const totalPnl      = sumNetPnl(trades);
  const avgPnl        = totalTrades > 0 ? totalPnl / totalTrades : undefined;
  const maxDrawdown   = Math.min(0, ...trades.map((t) => t.max_drawdown ?? 0));

  const beatClockworkBy = personality.name === 'clockwork'
    ? undefined
    : totalPnl - clockworkPnl;

  // Signal calibration
  const signalsReceived = signals.length;
  const signalsActedOn  = trades.filter((t) => t.signal_id != null).length;
  const brierInput = trades
    .filter((t) => t.signal_id != null)
    .map((t) => {
      const sig = signals.find((s) => s.id === t.signal_id);
      return sig ? { probability: sig.probability ?? 0.5, won: (t.net_pnl ?? 0) > 0 } : null;
    })
    .filter((x): x is { probability: number; won: boolean } => x != null);
  const brierScore = brierInput.length > 0 ? calcBrierScore(brierInput) : undefined;

  // Management P&L delta
  const { mgmtPnlDelta, adjustmentsMade } = calcMgmtDelta(trades);
  const mgmtVerdict = mgmtPnlDelta != null ? calcMgmtVerdict(mgmtPnlDelta) : undefined;

  return {
    analysis_date:     new Date(),
    personality_id:    personality.id,
    market_regime:     regime,
    total_trades:      totalTrades,
    winning_trades:    winningTrades,
    losing_trades:     losingTrades,
    win_rate:          winRate,
    total_pnl:         totalPnl,
    avg_pnl_per_trade: avgPnl,
    max_drawdown:      maxDrawdown === 0 ? undefined : maxDrawdown,
    clockwork_pnl_today: clockworkPnl,
    beat_clockwork_by: beatClockworkBy,
    signals_received:  signalsReceived,
    signals_acted_on:  signalsActedOn,
    signal_brier_score: brierScore,
    adjustments_made:  adjustmentsMade,
    mgmt_pnl_delta:    mgmtPnlDelta,
    mgmt_verdict:      mgmtVerdict,
    threshold_drift_flag: false,
    evolution_paused:  false,
    insights:          buildInsightsJson(trades, signals),
    applied:           false,
  };
}

export function calcMgmtVerdict(mgmtPnlDelta: number): MgmtVerdict {
  if (mgmtPnlDelta >= 200)  return 'HELPED';
  if (mgmtPnlDelta <= -200) return 'HURT';
  return 'NEUTRAL';
}

export function buildInsightsJson(
  trades:  PaperTrade[],
  signals: StraddleSignal[],
): Record<string, unknown> {
  const byHour: Record<string, { wins: number; total: number }> = {};
  for (const t of trades) {
    if (!t.entry_time) continue;
    const hr = String(t.entry_time.getUTCHours() + 5).padStart(2, '0'); // rough IST hour
    const bucket = byHour[hr] ?? { wins: 0, total: 0 };
    bucket.total++;
    if ((t.net_pnl ?? 0) > 0) bucket.wins++;
    byHour[hr] = bucket;
  }

  return {
    total_trades:  trades.length,
    win_rate_by_hour: Object.fromEntries(
      Object.entries(byHour).map(([hr, { wins, total }]) => [hr, total > 0 ? wins / total : 0]),
    ),
    signals_calibration: {
      total_signals:    signals.length,
      brier_score:      calcBrierScore(
        trades
          .filter((t) => t.signal_id != null)
          .map((t) => {
            const s = signals.find((sig) => sig.id === t.signal_id);
            return s ? { probability: s.probability ?? 0.5, won: (t.net_pnl ?? 0) > 0 } : null;
          })
          .filter((x): x is { probability: number; won: boolean } => x != null),
      ),
    },
  };
}

export interface EvolutionProposal {
  rule_id:             string;
  regime?:             MarketRegime;
  min_samples_met:     boolean;
  condition_met:       boolean;
  proposal?:           { parameter: string; old_value: number; new_value: number; reasoning: string };
  requires_approval:   boolean;
  cooldown_expires_at: string;
}

export async function evaluateEvolutionRules(
  personality: PersonalityConfig,
  todayTrades: PaperTrade[],
  regime: MarketRegime,
): Promise<{ rules_triggered: EvolutionProposal[] }> {
  // Gather recent trade history for this personality (last 30 days)
  const recentTrades = await query<PaperTrade>(
    `SELECT * FROM paper_trades
      WHERE personality_id = $1
        AND status = 'closed'
        AND exit_time >= NOW() - INTERVAL '30 days'`,
    [personality.id],
  );

  const proposals: EvolutionProposal[] = [];
  const today = new Date().toISOString().slice(0, 10);

  // Rule: low_win_rate
  if (recentTrades.length >= 30) {
    const winRate = recentTrades.filter((t) => (t.net_pnl ?? 0) > 0).length / recentTrades.length;
    if (winRate < 0.40 && personality.min_probability != null) {
      proposals.push({
        rule_id: 'low_win_rate',
        min_samples_met: true,
        condition_met: true,
        proposal: {
          parameter: 'min_probability',
          old_value: personality.min_probability,
          new_value: Math.min(0.90, personality.min_probability + 0.05),
          reasoning: `win_rate=${winRate.toFixed(2)} < 0.40 over ${recentTrades.length} trades`,
        },
        requires_approval: false,
        cooldown_expires_at: addDays(today, 14),
      });
    }
  }

  // Rule: high_win_rate
  if (recentTrades.length >= 30) {
    const winRate = recentTrades.filter((t) => (t.net_pnl ?? 0) > 0).length / recentTrades.length;
    if (winRate > 0.65 && personality.min_probability != null) {
      proposals.push({
        rule_id: 'high_win_rate',
        min_samples_met: true,
        condition_met: true,
        proposal: {
          parameter: 'min_probability',
          old_value: personality.min_probability,
          new_value: Math.max(0.45, personality.min_probability - 0.03),
          reasoning: `win_rate=${winRate.toFixed(2)} > 0.65 — can relax threshold`,
        },
        requires_approval: false,
        cooldown_expires_at: addDays(today, 14),
      });
    }
  }

  // Rule: excessive_drawdown
  if (recentTrades.length >= 20) {
    const maxDrawdown = Math.min(...recentTrades.map((t) => t.max_drawdown ?? 0));
    if (maxDrawdown < -20000) {
      proposals.push({
        rule_id: 'excessive_drawdown',
        min_samples_met: true,
        condition_met: true,
        proposal: {
          parameter: 'max_daily_trades',
          old_value: personality.max_daily_trades,
          new_value: Math.max(1, personality.max_daily_trades - 1),
          reasoning: `max_drawdown=${maxDrawdown.toFixed(0)} < -20000`,
        },
        requires_approval: maxDrawdown < -25000, // severe needs approval
        cooldown_expires_at: addDays(today, 7),
      });
    }
  }

  return { rules_triggered: proposals };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function tradesForPersonality(trades: PaperTrade[], personalityId: string): PaperTrade[] {
  return trades.filter((t) => t.personality_id === personalityId);
}

function signalsForPersonality(signals: StraddleSignal[], trades: PaperTrade[]): StraddleSignal[] {
  const signalIds = new Set(trades.map((t) => t.signal_id).filter(Boolean));
  return signals.filter((s) => signalIds.has(s.id));
}

function sumNetPnl(trades: PaperTrade[]): number {
  return trades.reduce((acc, t) => acc + (t.net_pnl ?? 0), 0);
}

function deriveRegime(trades: PaperTrade[]): MarketRegime | null {
  if (trades.length === 0) return null;
  return trades[0].market_regime ?? null;
}

function calcMgmtDelta(trades: PaperTrade[]): { mgmtPnlDelta: number | undefined; adjustmentsMade: number } {
  // Simplified: count trades with exit_reason MANUAL (roll/cut) as adjustments
  const adjustments = trades.filter((t) => t.exit_reason === 'MANUAL').length;
  if (adjustments === 0) return { mgmtPnlDelta: undefined, adjustmentsMade: 0 };
  // In a real impl, compare vs hold baseline. Here we return 0 as placeholder.
  return { mgmtPnlDelta: 0, adjustmentsMade: adjustments };
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
