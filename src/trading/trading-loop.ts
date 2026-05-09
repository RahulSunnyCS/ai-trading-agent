import { streamRead, STREAMS } from '../redis/client';
import { FYERS_INDEX_SYMBOLS } from '../ingestion/brokers/instrument-registry';
import { isMarketHours } from '../utils/market-hours';
import { currentExpiry } from '../ingestion/brokers/instrument-registry';
import { detectSignals } from './signal-detector';
import { executeSignalEntry, executeScheduledEntries, loadActivePersonalities } from './trade-executor';
import { manageTrades, closeAllAtEod } from './trade-manager';
import { runDailyRetrospection } from './retrospection';
import { applyEvolutionRules } from './evolution-rules';
import { query } from '../db/client';
import type { Underlying, PersonalityConfig, StraddleSignal, RetrospectionResult } from '../db/schema';
import type { ExecutionContext } from './trade-executor';

// ── State ──────────────────────────────────────────────────────────────────────

let running = false;
const intervals: ReturnType<typeof setInterval>[] = [];
const timeouts:  ReturnType<typeof setTimeout>[]  = [];
let signalStreamId = '0-0';

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Starts all trading loop intervals and scheduled tasks for a given underlying.
 * Should be called after the data ingestion pipeline is up.
 */
export function startTradingLoop(
  underlying: Underlying,
  currentPrices: Map<string, number>,
  getVix: () => number | null,
): void {
  if (running) return;
  running = true;

  // Signal detection: consume STRADDLE_VALUES stream every 15s
  intervals.push(setInterval(() => {
    if (!isMarketHours()) return;
    void detectSignals();
  }, 15_000));

  // Signal consumption: route SIGNALS_GENERATED stream to personality executor
  intervals.push(setInterval(() => {
    if (!isMarketHours()) return;
    void consumeAndExecuteSignals(underlying, currentPrices, getVix);
  }, 5_000));

  // Trade management: evaluate open trades every 30s
  intervals.push(setInterval(async () => {
    if (!isMarketHours()) return;
    const personalities = await buildPersonalityMap(underlying);
    void manageTrades(underlying, currentPrices, personalities);
  }, 30_000));

  // Scheduled daily tasks (9:17 IST, 15:30 IST, 15:45 IST, 15:50 IST)
  scheduleDaily(underlying, currentPrices, getVix);

  console.log(`[trading-loop] Started for ${underlying}`);
}

export function stopTradingLoop(): void {
  intervals.forEach(clearInterval);
  timeouts.forEach(clearTimeout);
  intervals.length = 0;
  timeouts.length  = 0;
  running = false;
  console.log('[trading-loop] Stopped');
}

// ── Private ────────────────────────────────────────────────────────────────────

async function consumeAndExecuteSignals(
  underlying: Underlying,
  currentPrices: Map<string, number>,
  getVix: () => number | null,
): Promise<void> {
  const entries = await streamRead(STREAMS.SIGNALS_GENERATED, signalStreamId, 10);
  if (entries.length === 0) return;

  for (const { id, fields } of entries) {
    signalStreamId = id;
    if (fields.underlying !== underlying) continue;

    const signal: StraddleSignal = {
      id:              fields.signal_id,
      created_at:      new Date(),
      underlying,
      expiry:          new Date(fields.expiry),
      signal_time:     new Date(fields.signal_time),
      signal_type:     fields.signal_type as StraddleSignal['signal_type'],
      atm_strike:      parseInt(fields.atm_strike),
      probability:     parseFloat(fields.probability),
      confidence_tier: fields.confidence_tier as StraddleSignal['confidence_tier'],
      status:          'active',
    };

    const ctx: ExecutionContext = {
      underlying,
      expiry:        signal.expiry,
      currentPrices,
      vix:           getVix(),
      currentRegime: null, // regime is tagged EOD; use null during intraday
      currentTime:   new Date(),
    };

    await executeSignalEntry(signal, ctx);
  }
}

function scheduleDaily(
  underlying: Underlying,
  currentPrices: Map<string, number>,
  getVix: () => number | null,
): void {
  // Helper: milliseconds until next occurrence of a given IST hour:minute today or tomorrow
  function msUntil(istHour: number, istMin: number): number {
    const istOffset = 5.5 * 60 * 60 * 1000;
    const now       = new Date(Date.now() + istOffset);
    const target    = new Date(now);
    target.setUTCHours(istHour - 5, istMin - 30, 0, 0); // convert IST → UTC
    if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
    return target.getTime() - Date.now();
  }

  // 9:17 IST — scheduled entries for Clockwork + Learning personalities
  function scheduleEntry(): void {
    const ms = msUntil(9, 17);
    timeouts.push(setTimeout(async () => {
      const expiry = currentExpiry(underlying);
      const ctx: ExecutionContext = {
        underlying,
        expiry,
        currentPrices,
        vix:           getVix(),
        currentRegime: null,
        currentTime:   new Date(),
      };
      console.log(`[trading-loop] 9:17 — scheduled entries for ${underlying}`);
      await executeScheduledEntries(ctx);
      scheduleEntry(); // reschedule for next day
    }, ms));
  }

  // 15:30 IST — EOD close all open trades
  function scheduleEodClose(): void {
    const ms = msUntil(15, 30);
    timeouts.push(setTimeout(async () => {
      console.log(`[trading-loop] 15:30 — EOD close for ${underlying}`);
      await closeAllAtEod(underlying, currentPrices);
      scheduleEodClose();
    }, ms));
  }

  // 15:45 IST — retrospection
  function scheduleRetrospection(): void {
    const ms = msUntil(15, 45);
    timeouts.push(setTimeout(async () => {
      console.log(`[trading-loop] 15:45 — retrospection for ${underlying}`);
      await runDailyRetrospection(new Date(), underlying);
      scheduleRetrospection();
    }, ms));
  }

  // 15:50 IST — evolution rules
  function scheduleEvolution(): void {
    const ms = msUntil(15, 50);
    timeouts.push(setTimeout(async () => {
      console.log(`[trading-loop] 15:50 — evolution rules for ${underlying}`);
      await applyEvolutionRulesForAllPersonalities(underlying);
      scheduleEvolution();
    }, ms));
  }

  scheduleEntry();
  scheduleEodClose();
  scheduleRetrospection();
  scheduleEvolution();
}

async function applyEvolutionRulesForAllPersonalities(underlying: Underlying): Promise<void> {
  const personalities = await loadActivePersonalities(underlying);
  const today = new Date().toISOString().slice(0, 10);

  for (const personality of personalities) {
    if (personality.is_frozen) continue; // Clockwork — never evolve

    const [result] = await query<RetrospectionResult>(
      `SELECT * FROM retrospection_results
        WHERE personality_id = $1 AND analysis_date = $2 AND applied = FALSE`,
      [personality.id, today],
    );
    if (!result) continue;

    try {
      await applyEvolutionRules(personality.id, result);
    } catch (err) {
      console.error(`[evolution] Error for ${personality.name}:`, (err as Error).message);
    }
  }
}

async function buildPersonalityMap(underlying: Underlying): Promise<Map<string, PersonalityConfig>> {
  const personalities = await loadActivePersonalities(underlying);
  return new Map(personalities.map((p) => [p.id, p]));
}

// Export index symbols for index.ts convenience
export { FYERS_INDEX_SYMBOLS };
