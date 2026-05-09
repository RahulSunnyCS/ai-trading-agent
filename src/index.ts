import 'dotenv/config';
import { runMigrations } from './db/migrate';
import { closePool } from './db/client';
import { getRedis, closeRedis } from './redis/client';
import { FyersFeed } from './ingestion/brokers/fyers';
import { currentExpiry, FYERS_INDEX_SYMBOLS } from './ingestion/brokers/instrument-registry';
import { setVix } from './ingestion/vix-feed';
import { MarketDataSimulator } from './ingestion/market-data-sim';
import {
  computeAndSaveSnapshot,
  consumeTickStream,
  updatePrice,
  resetDayState,
  getAtmStrike,
} from './ingestion/straddle-calc';
import type { BrokerTick } from './ingestion/brokers/types';
import { isMarketHours } from './utils/market-hours';
import type { Underlying } from './db/schema';
import { startApiServer, stopApiServer } from './api/server';

const API_PORT = parseInt(process.env.API_PORT ?? '3001', 10);
const SIMULATE        = process.env.SIMULATE === 'true' || process.argv.includes('--simulate');
const UNDERLYING      = (process.env.SIM_UNDERLYING ?? 'NIFTY') as Underlying;
const SNAPSHOT_MS     = 15_000;  // straddle snapshot every 15 seconds
const TICK_CONSUME_MS = 500;     // drain tick stream into price cache twice per second

// ── Shutdown handler ───────────────────────────────────────────────────────────
let fyersFeed:  FyersFeed | null = null;
let simulator:  MarketDataSimulator | null = null;

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[main] Received ${signal}. Shutting down...`);
  fyersFeed?.disconnect();
  simulator?.stop();
  await stopApiServer();
  await closeRedis();
  await closePool();
  process.exit(0);
}

process.on('SIGINT',  () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// ── Main ───────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('[main] AI Trading Agent — Data Ingestion (Broker: Fyers)');
  console.log(`[main] Mode: ${SIMULATE ? 'SIMULATION' : 'LIVE'}`);

  await runMigrations();

  await getRedis().ping();
  console.log('[main] Redis ready');

  await startApiServer(API_PORT);

  if (SIMULATE) {
    await startSimulation();
  } else {
    await startLiveFeed();
  }

  console.log('[main] Ingestion pipeline running. Ctrl+C to stop.');
}

// ── Live feed — Fyers ──────────────────────────────────────────────────────────
async function startLiveFeed(): Promise<void> {
  const appId       = process.env.FYERS_APP_ID;
  const accessToken = process.env.FYERS_ACCESS_TOKEN;

  if (!appId || !accessToken) {
    throw new Error(
      'Missing FYERS_APP_ID or FYERS_ACCESS_TOKEN. ' +
      'Set SIMULATE=true to run without credentials.'
    );
  }

  const expiry = currentExpiry(UNDERLYING);

  fyersFeed = new FyersFeed({ appId, accessToken });

  // Route every tick into: price cache + VIX cache + straddle snapshots
  fyersFeed.onTick((tick: BrokerTick) => {
    routeTick(tick);
  });

  fyersFeed.onConnect(() => {
    // Subscribe to index spot + VIX first
    fyersFeed!.subscribeIndexes([UNDERLYING]);

    // Subscribe to ATM ±2 strikes for current weekly expiry
    const spot    = 24_000; // initial estimate; will self-correct after first spot tick
    const atm     = getAtmStrike(spot, UNDERLYING);
    const strikes = [atm - 200, atm - 100, atm, atm + 100, atm + 200];

    fyersFeed!.subscribe(
      strikes.flatMap((strike) => [
        { underlying: UNDERLYING, expiry, strike, optionType: 'CE' as const },
        { underlying: UNDERLYING, expiry, strike, optionType: 'PE' as const },
      ])
    );
  });

  fyersFeed.onError((err) => console.error('[fyers] Error:', err.message));

  await fyersFeed.connect();

  // Drain tick stream into price cache every 500ms
  setInterval(() => void consumeTickStream(), TICK_CONSUME_MS);

  // Compute and persist straddle snapshot every 15s during market hours
  let lastAtm = 0;
  setInterval(async () => {
    if (!isMarketHours()) return;

    const spotTick = getPrice(FYERS_INDEX_SYMBOLS[UNDERLYING]);
    if (!spotTick) return; // no spot price yet

    const spot   = spotTick.ltp;
    const vix    = getVixFromCache();
    const newAtm = getAtmStrike(spot, UNDERLYING);

    // Re-subscribe if ATM moved by one strike interval
    if (newAtm !== lastAtm && lastAtm !== 0) {
      resubscribeAtm(newAtm, lastAtm, expiry);
    }
    lastAtm = newAtm;

    try {
      await computeAndSaveSnapshot(UNDERLYING, expiry, spot, vix);
      console.log(`[live] Snapshot — ${UNDERLYING} spot:${spot.toFixed(0)} ATM:${newAtm} VIX:${vix?.toFixed(1) ?? 'n/a'}`);
    } catch (err) {
      console.error('[live] Snapshot error:', err instanceof Error ? err.message : err);
    }
  }, SNAPSHOT_MS);

  scheduleDailyReset();
}

// ── Simulation mode ────────────────────────────────────────────────────────────
async function startSimulation(): Promise<void> {
  const tickIntervalMs = parseInt(process.env.SIM_TICK_INTERVAL_MS ?? '1000', 10);

  simulator = new MarketDataSimulator({ underlying: UNDERLYING, startSpot: 24_000, startVix: 14.5, tickIntervalMs });
  simulator.start();

  setInterval(() => void consumeTickStream(), TICK_CONSUME_MS);

  setInterval(async () => {
    const spot   = simulator!.getSpot();
    const vix    = simulator!.getVix();
    const expiry = simulator!.getExpiry();
    try {
      await computeAndSaveSnapshot(UNDERLYING, expiry, spot, vix);
      console.log(`[sim] Snapshot — ${UNDERLYING} spot:${spot.toFixed(0)} ATM:${getAtmStrike(spot, UNDERLYING)} VIX:${vix.toFixed(1)}`);
    } catch (err) {
      console.error('[sim] Snapshot error:', err instanceof Error ? err.message : err);
    }
  }, SNAPSHOT_MS);

  scheduleDailyReset();
}

// ── Tick routing (live mode) ───────────────────────────────────────────────────
// Cache for spot prices from index ticks (keyed by Fyers index symbol)
const spotCache = new Map<string, { ltp: number; time: Date }>();
let cachedVix: number | null = null;

function routeTick(tick: BrokerTick): void {
  const symbol = tick.symbol;

  // VIX tick
  if (symbol === 'NSE:INDIAVIX-INDEX') {
    cachedVix = tick.ltp;
    setVix(tick.ltp);
    return;
  }

  // Index spot tick
  const indexSymbols = Object.values(FYERS_INDEX_SYMBOLS) as string[];
  if (indexSymbols.includes(symbol)) {
    spotCache.set(symbol, { ltp: tick.ltp, time: tick.timestamp });
    return;
  }

  // Option tick → update straddle-calc price cache
  updatePrice(symbol, tick.ltp, tick.timestamp);
}

function getPrice(fyersIndexSymbol: string): { ltp: number; time: Date } | undefined {
  return spotCache.get(fyersIndexSymbol);
}

function getVixFromCache(): number | null {
  return cachedVix;
}

// Re-subscribe to new ATM strikes when spot moves enough
function resubscribeAtm(newAtm: number, oldAtm: number, expiry: Date): void {
  if (!fyersFeed) return;

  const INTERVAL = newAtm > oldAtm ? 50 : -50; // direction of movement
  const toUnsub  = [oldAtm - 200, oldAtm - 100, oldAtm, oldAtm + 100, oldAtm + 200]
    .filter((s) => ![newAtm - 200, newAtm - 100, newAtm, newAtm + 100, newAtm + 200].includes(s));
  const toSub    = [newAtm - 200, newAtm - 100, newAtm, newAtm + 100, newAtm + 200]
    .filter((s) => ![oldAtm - 200, oldAtm - 100, oldAtm, oldAtm + 100, oldAtm + 200].includes(s));

  if (toUnsub.length > 0) {
    fyersFeed.unsubscribe(toUnsub.flatMap((s) => [
      { underlying: UNDERLYING, expiry, strike: s, optionType: 'CE' as const },
      { underlying: UNDERLYING, expiry, strike: s, optionType: 'PE' as const },
    ]));
  }
  if (toSub.length > 0) {
    fyersFeed.subscribe(toSub.flatMap((s) => [
      { underlying: UNDERLYING, expiry, strike: s, optionType: 'CE' as const },
      { underlying: UNDERLYING, expiry, strike: s, optionType: 'PE' as const },
    ]));
  }

  void INTERVAL; // suppress unused warning — kept for clarity
  console.log(`[live] ATM shifted ${oldAtm} → ${newAtm}: unsub ${toUnsub.join(',')}, sub ${toSub.join(',')}`);
}

// ── Daily reset at midnight IST ────────────────────────────────────────────────
function scheduleDailyReset(): void {
  const istOffset       = 5.5 * 60 * 60 * 1000;
  const istNow          = new Date(Date.now() + istOffset);
  const midnight        = new Date(istNow);
  midnight.setHours(0, 0, 0, 0);
  midnight.setDate(midnight.getDate() + 1);
  const msUntilMidnight = midnight.getTime() - istNow.getTime();

  setTimeout(() => {
    resetDayState();
    spotCache.clear();
    cachedVix = null;
    scheduleDailyReset();
  }, msUntilMidnight);
}

void main().catch((err) => {
  console.error('[main] Fatal error:', err);
  process.exit(1);
});
