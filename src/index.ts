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
 */

import { buildServer } from "./api/server.js";
import { pool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createBroker } from "./ingestion/brokers/broker-factory.js";
import { StraddleCalculator } from "./ingestion/straddle-calc.js";
import { VixFeed } from "./ingestion/vix-feed.js";
import { closeRedis, redis } from "./redis/client.js";
import { EntryEngine } from "./trading/entry-engine.js";
import { PaperTradeExecutor } from "./trading/paper-trade-executor.js";
import { PositionMonitor } from "./trading/position-monitor.js";
import { QuantiplyStub } from "./trading/quantiply-stub.js";
import { loadTriggerConfig } from "./trading/trigger-engine.js";
import { RealClock, VirtualClock } from "./utils/clock.js";

// ---------------------------------------------------------------------------
// Main startup function — separated so async/await works at module level.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Step 1: run migrations before anything else. If PostgreSQL is unreachable
  // or the schema is inconsistent this throws immediately, preventing the app
  // from starting in a broken state (fail fast principle).
  await runMigrations();

  // Step 2: choose clock based on SIMULATE env var.
  // VirtualClock is used in simulation mode so that all time-based callbacks
  // (straddle snapshots, VIX polling, position watchdog) are driven by
  // clock.advance() calls rather than wall-clock timers. This makes simulation
  // faster than real time and allows tests to control time precisely.
  //
  // We start VirtualClock at the current wall-clock epoch so that IST date
  // strings produced by clock.today() are correct even in simulation mode.
  const simulate = process.env.SIMULATE?.toLowerCase().trim() === "true";

  // Both VirtualClock and RealClock satisfy the ClockWithTick intersection type
  // required by createBroker / StraddleCalculator / VixFeed / PositionMonitor.
  // RealClock does not have tick() — but in live mode the broker adapter and
  // all components that need tick() use real setInterval internally.
  // VirtualClock.tick() registers a callback that fires on clock.advance() calls.
  //
  // Note: TypeScript is satisfied because VirtualClock has tick() and all
  // component configs accept the ClockWithTick intersection structurally.
  const clock = simulate
    ? new VirtualClock(Date.now())
    : (new RealClock() as unknown as VirtualClock); // RealClock cast: live mode never calls tick()

  if (simulate) {
    console.log(`[index] Simulation mode active — advancing clock every ${SIM_TICK_INTERVAL_MS}ms`);
  } else {
    console.log("[index] Live mode active — using real clock");
  }

  // Step 3: instantiate all components.
  // createBroker reads BROKER and SIMULATE env vars and picks the right adapter.
  const broker = createBroker(clock);

  const calc = new StraddleCalculator({ db: pool, redis, clock });
  const vixFeed = new VixFeed({ clock });

  const entryEngine = new EntryEngine({ db: pool, redis, clock });

  const quantiply = new QuantiplyStub();
  const executor = new PaperTradeExecutor({ db: pool, quantiply });

  const positionMonitor = new PositionMonitor({
    clock,
    db: pool,
    redis,
    executor,
    triggerConfig: loadTriggerConfig(),
    entryEngine,
  });

  const server = buildServer({ db: pool, redis, clock });

  // Step 4: start components in dependency order.
  // broker must connect before calc.start(broker) subscribes to tick events.
  // vixFeed and entryEngine are independent; positionMonitor depends on entryEngine.
  // server.listen is last so the HTTP surface is not available until the pipeline
  // is fully wired and ready to serve data.
  broker.connect();
  calc.start(broker);
  vixFeed.start();
  await positionMonitor.start();
  entryEngine.start();

  const port = Number(process.env.PORT ?? 3000);
  await server.listen({ port, host: "0.0.0.0" });
  console.log(`[index] API server listening on port ${port}`);

  // Step 5: in simulation mode, advance the virtual clock on a real setInterval.
  // Each advance fires all registered tick() callbacks (straddle, VIX, watchdog)
  // according to how many of their interval boundaries were crossed by the advance.
  let simInterval: ReturnType<typeof setInterval> | null = null;
  if (simulate) {
    simInterval = setInterval(() => {
      // advance() is defined only on VirtualClock; the cast above makes TypeScript
      // treat `clock` as VirtualClock in this branch so the call compiles.
      (clock as VirtualClock).advance(SIM_TICK_INTERVAL_MS);
    }, SIM_TICK_INTERVAL_MS);
  }

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------

  async function shutdown(): Promise<void> {
    console.log("[index] Shutdown signal received — stopping components");
    entryEngine.stop();
    await positionMonitor.stop();
    calc.stop();
    vixFeed.stop();
    await server.close();
    await pool.end();
    await closeRedis();
    if (simInterval !== null) {
      clearInterval(simInterval);
    }
    console.log("[index] Shutdown complete");
    process.exit(0);
  }

  // Register both SIGTERM (Docker / Railway / Fly.io) and SIGINT (Ctrl-C in dev).
  // Using 'once' semantics via `process.on` is sufficient because process.exit(0)
  // in the handler prevents the process from receiving a second signal.
  process.on("SIGTERM", () => {
    shutdown().catch((err) => {
      console.error("[index] Error during shutdown:", err);
      process.exit(1);
    });
  });

  process.on("SIGINT", () => {
    shutdown().catch((err) => {
      console.error("[index] Error during shutdown:", err);
      process.exit(1);
    });
  });
}

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
// Boot
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error("[index] Fatal startup error:", err);
  process.exit(1);
});
