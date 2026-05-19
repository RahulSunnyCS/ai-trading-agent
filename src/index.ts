/**
 * Main entry point — full pipeline wiring.
 *
 * Startup sequence:
 *   1. Run DB migrations (fail fast if DB is unreachable)
 *   2. Determine clock (VirtualClock in SIMULATE mode, RealClock otherwise)
 *   3. Instantiate all components with the shared clock
 *   4. Start components in dependency order
 *   5. Register SIGTERM / SIGINT handlers for graceful shutdown
 *
 * In simulation mode the clock is advanced programmatically by a setInterval
 * so that VirtualClock.tick() callbacks (straddle calc, VIX feed, watchdog) fire
 * deterministically without real wall-clock time passing at 1:1 speed.
 *
 * All exports are named exports per project convention. This file has no exports
 * because it is the process entry point.
 *
 * Payment routes (Razorpay/UPI): registered via startServer() from src/server/index.ts
 * which wires up the payment routes alongside the existing trading API routes.
 */

import { pool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createBrokerFeed } from "./ingestion/brokers/index.js";
import { createStraddleCalculator } from "./ingestion/straddle-calc.js";
import { createVixFeed } from "./ingestion/vix-feed.js";
import { redis } from "./redis/client.js";
import { startServer } from "./server/index.js";
import { createPositionMonitor } from "./trading/position-monitor.js";
import { RealClock, VirtualClock } from "./utils/clock.js";

// ---------------------------------------------------------------------------
// Simulation tick interval
// ---------------------------------------------------------------------------

// How many ms of virtual time to advance per real tick in simulation mode.
// Read at startup so operators can tune simulation speed via env var without
// code changes. Default 1000 ms of virtual time per 1000 ms of real time (1:1).
const SIM_TICK_INTERVAL_MS = (() => {
  const parsed = Number.parseInt(process.env.SIM_TICK_INTERVAL_MS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1_000;
})();

// ---------------------------------------------------------------------------
// Main startup function — separated so async/await works at module level.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Step 1: run migrations before anything else. If PostgreSQL is unreachable
  // or the schema is inconsistent this throws immediately, preventing the app
  // from starting in a broken state (fail fast principle).
  await runMigrations();

  // Step 2: choose clock based on SIMULATE env var.
  const simulate = process.env.SIMULATE?.toLowerCase().trim() === "true";

  const clock = simulate
    ? new VirtualClock(new Date(Date.now()))
    : new RealClock();

  if (simulate) {
    console.log(`[index] Simulation mode active — advancing clock every ${SIM_TICK_INTERVAL_MS}ms`);
  } else {
    console.log("[index] Live mode active — using real clock");
  }

  // Step 3: instantiate all components.
  // createBrokerFeed reads BROKER and SIMULATE env vars and picks the right adapter.
  const feed = createBrokerFeed();

  // Straddle calculator reads market.ticks from Redis → publishes straddle.values.
  const straddleCalc = createStraddleCalculator(redis, { underlying: 'NIFTY', clock });

  // VIX feed: reads market.ticks for NSE:INDIAVIX-INDEX; polls NSE API as fallback.
  const vixFeed = createVixFeed(redis, { clock });

  // Position monitor: reads straddle.values and evaluates open positions for exit conditions.
  const positionMonitor = createPositionMonitor(redis, pool, { clock });

  // Wire tick publisher: each tick from the broker feed is serialised and written to
  // the market.ticks Redis stream so the straddle calculator and VIX feed can consume it.
  // Use optional chaining because BrokerFeed.onTick / onDisconnect are optional methods —
  // some broker adapters use the EventEmitter .on() pattern instead; those are wired via
  // the .on('tick') and .on('disconnect') overloads, which createBrokerFeed sets up before
  // returning.  The onTick/onDisconnect style is used by the simulator and the Fyers adapter.
  feed.onTick?.((tick) => {
    // Fire-and-forget: we do not await here because onTick is a synchronous callback.
    void redis.xadd('market.ticks', '*', 'data', JSON.stringify(tick));
  });

  feed.onDisconnect?.((reason) => {
    console.warn(`[feed] disconnected — reason: ${reason}`);
  });

  // Step 4: start components in dependency order.
  await Promise.all([
    straddleCalc.start(),
    vixFeed.start(),
    positionMonitor.start(),
    // startServer registers its own SIGINT/SIGTERM handlers for server.close().
    // Our outer handlers (below) also call feed.disconnect(), pool.end(), and
    // redis.quit() which the server's handlers do not cover.
    startServer(pool),
  ]);

  // Connect broker feed after all consumers are ready so no ticks are dropped.
  await feed.connect();
  console.log('[index] broker feed connected — receiving ticks');

  // Step 5: in simulation mode, advance the virtual clock on a real setInterval.
  let simInterval: ReturnType<typeof setInterval> | null = null;
  if (simulate && clock instanceof VirtualClock) {
    simInterval = setInterval(() => {
      (clock as VirtualClock).advance(SIM_TICK_INTERVAL_MS);
    }, SIM_TICK_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  async function shutdown(signal: string): Promise<void> {
    console.log(`[index] ${signal} received — shutting down gracefully`);
    try {
      if (simInterval !== null) {
        clearInterval(simInterval);
      }
      await positionMonitor.stop();
      await vixFeed.stop();
      await straddleCalc.stop();
      await feed.disconnect();
      await pool.end();
      await redis.quit();
    } finally {
      process.exit(0);
    }
  }

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.on("unhandledRejection", (reason: unknown) => {
    console.error("[index] Unhandled rejection:", reason);
    void shutdown("unhandledRejection");
  });

  process.on("uncaughtException", (err: Error) => {
    console.error("[index] Uncaught exception:", err);
    void shutdown("uncaughtException");
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("[index] Fatal startup error:", err);
  process.exit(1);
});
