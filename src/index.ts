import 'dotenv/config';
import { runMigrations } from './db/migrate';
import { closePool } from './db/client';
import { getRedis, closeRedis } from './redis/client';
import { NseWebSocketFeed, type InstrumentInfo } from './ingestion/nse-websocket';
import { VixFeed, fetchVixFromNse } from './ingestion/vix-feed';
import { MarketDataSimulator } from './ingestion/market-data-sim';
import {
  computeAndSaveSnapshot,
  consumeTickStream,
  resetDayState,
  getAtmStrike,
} from './ingestion/straddle-calc';
import type { Underlying } from './db/schema';

const SIMULATE        = process.env.SIMULATE === 'true' || process.argv.includes('--simulate');
const UNDERLYING      = (process.env.SIM_UNDERLYING ?? 'NIFTY') as Underlying;
const SNAPSHOT_MS     = 15_000;  // straddle snapshot every 15 seconds
const TICK_CONSUME_MS = 500;     // drain tick stream twice per second

// ── Market hours (IST = UTC+5:30) ─────────────────────────────────────────────
// NSE market: 09:15 – 15:30 IST
function isMarketHours(): boolean {
  const now = new Date();
  // Convert UTC to IST offset
  const istOffset = 5.5 * 60; // minutes
  const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + istOffset) % (24 * 60);
  return istMinutes >= 9 * 60 + 15 && istMinutes <= 15 * 60 + 30;
}

// ── Shutdown handler ───────────────────────────────────────────────────────────
let wssFeed:    NseWebSocketFeed | null = null;
let vixFeed:    VixFeed | null = null;
let simulator:  MarketDataSimulator | null = null;

async function shutdown(signal: string): Promise<void> {
  console.log(`\n[main] Received ${signal}. Shutting down...`);
  wssFeed?.stop();
  vixFeed?.stop();
  simulator?.stop();
  await closeRedis();
  await closePool();
  process.exit(0);
}

process.on('SIGINT',  () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// ── Main ───────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log(`[main] AI Trading Agent — Sprint 1: Data Ingestion`);
  console.log(`[main] Mode: ${SIMULATE ? 'SIMULATION' : 'LIVE'}`);

  // 1. Run DB migrations
  await runMigrations();

  // 2. Verify Redis
  await getRedis().ping();
  console.log('[main] Redis ready');

  // 3. Start market data source
  if (SIMULATE) {
    await startSimulation();
  } else {
    await startLiveFeed();
  }

  console.log('[main] Ingestion pipeline running. Press Ctrl+C to stop.');
}

// ── Simulation mode ────────────────────────────────────────────────────────────
async function startSimulation(): Promise<void> {
  const tickIntervalMs = parseInt(process.env.SIM_TICK_INTERVAL_MS ?? '1000', 10);

  simulator = new MarketDataSimulator({
    underlying:     UNDERLYING,
    startSpot:      24_000,
    startVix:       14.5,
    tickIntervalMs,
  });
  simulator.start();

  // Drain tick stream into price cache
  setInterval(() => void consumeTickStream(), TICK_CONSUME_MS);

  // Every 15s: compute straddle snapshot using simulated prices
  setInterval(async () => {
    const spot   = simulator!.getSpot();
    const vix    = simulator!.getVix();
    const expiry = simulator!.getExpiry();

    try {
      await computeAndSaveSnapshot(UNDERLYING, expiry, spot, vix);
      const atm = getAtmStrike(spot, UNDERLYING);
      console.log(
        `[sim] Snapshot — ${UNDERLYING} spot:${spot.toFixed(0)} ATM:${atm} ` +
        `VIX:${vix.toFixed(1)}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[sim] Snapshot error:', msg);
    }
  }, SNAPSHOT_MS);

  // Reset day state at midnight IST
  scheduleDailyReset();
}

// ── Live feed mode ─────────────────────────────────────────────────────────────
async function startLiveFeed(): Promise<void> {
  const wsUrl      = process.env.NSE_WEBSOCKET_URL;
  const apiKey     = process.env.NSE_API_KEY;
  const accessToken = process.env.NSE_ACCESS_TOKEN;

  if (!wsUrl || !apiKey || !accessToken) {
    throw new Error(
      'Missing required env vars: NSE_WEBSOCKET_URL, NSE_API_KEY, NSE_ACCESS_TOKEN. ' +
      'Set SIMULATE=true to run without broker credentials.'
    );
  }

  // Instrument map — populate this with your broker's instrument tokens.
  // Example shows Nifty spot + weekly ATM ±2 strikes.
  // In production, this is loaded from the broker's instrument CSV.
  const instruments = new Map<number, InstrumentInfo>([
    // Nifty spot (instrument token varies by broker)
    // [256265, { symbol: 'NIFTY', underlying: 'NIFTY' }],
    // Add weekly option tokens here after loading instrument CSV
  ]);

  if (instruments.size === 0) {
    console.warn(
      '[main] WARNING: No instruments configured in instrument map. ' +
      'Populate src/index.ts instruments with your broker\'s instrument tokens.'
    );
  }

  wssFeed = new NseWebSocketFeed({ url: wsUrl, apiKey, accessToken, instruments });
  wssFeed.start();

  // Drain tick stream
  setInterval(() => void consumeTickStream(), TICK_CONSUME_MS);

  // VIX feed (poll NSE every 60s as fallback)
  vixFeed = new VixFeed(fetchVixFromNse, 60_000);
  vixFeed.start();

  // Straddle snapshots every 15s during market hours
  // Requires: spot price from index tick, expiry from current week's contracts
  // TODO: wire spot from index tick → computeAndSaveSnapshot
  setInterval(async () => {
    if (!isMarketHours()) return;
    // Spot price needs to come from the index instrument tick
    // Add snapshot logic here once instrument tokens are configured
  }, SNAPSHOT_MS);

  scheduleDailyReset();
}

// ── Daily reset at midnight IST ────────────────────────────────────────────────
function scheduleDailyReset(): void {
  const now       = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow    = new Date(now.getTime() + istOffset);
  const midnight  = new Date(istNow);
  midnight.setHours(0, 0, 0, 0);
  midnight.setDate(midnight.getDate() + 1);
  const msUntilMidnight = midnight.getTime() - istNow.getTime();

  setTimeout(() => {
    resetDayState();
    // Reschedule for the next day
    scheduleDailyReset();
  }, msUntilMidnight);
}

void main().catch((err) => {
  console.error('[main] Fatal error:', err);
  process.exit(1);
});
