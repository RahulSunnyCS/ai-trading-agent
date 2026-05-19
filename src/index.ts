/**
 * Application entry point — end-to-end wire-up.
 *
 * Start order:
 *  1. Create broker feed (SIMULATE env var selects simulator or live broker)
 *  2. Start straddle calculator (reads market.ticks from Redis → publishes straddle.values)
 *  3. Start VIX feed (reads market.ticks for VIX symbol + polls NSE API as fallback)
 *  4. Start position monitor (reads straddle.values → evaluates open position exits)
 *  5. Start Fastify server (binds to PORT, registers all routes including paymentRoutes)
 *  6. Wire broker feed: register onTick handler to publish each tick to Redis, then connect
 *
 * Shutdown order (SIGINT / SIGTERM):
 *  - Stop straddle calculator and VIX feed (clear intervals and poll loops)
 *  - Stop position monitor (exits its poll loop)
 *  - Close Fastify server (drains in-flight requests)
 *  - Disconnect broker feed
 *  - Redis and pg Pool are closed by their respective onClose hooks / process exit
 *
 * Design decisions:
 * - The singleton `redis` from src/redis/client.ts is shared across straddle-calc,
 *   vix-feed, and position-monitor.  A single ioredis connection is sufficient for
 *   these read-heavy subscribers — ioredis multiplexes commands over one TCP connection.
 * - The singleton `pool` from src/db/client.ts is passed to both startServer() (as
 *   externalPool, so the Fastify server reuses the same pool) and createPositionMonitor().
 *   This avoids opening two separate pg connection pools competing for the same PostgreSQL
 *   connection limit.
 * - process.env keys are accessed via dot notation throughout (Biome useLiteralKeys rule).
 * - `void` prefix is used on fire-and-forget async calls to satisfy Biome's
 *   no-floating-promises rule.
 */

import { pool } from './db/client';
import { createBrokerFeed } from './ingestion/brokers/index';
import { createStraddleCalculator } from './ingestion/straddle-calc';
import { createVixFeed } from './ingestion/vix-feed';
import { redis } from './redis/client';
import { startServer } from './server/index';
import { createPositionMonitor } from './trading/position-monitor';

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

const simulate = process.env.SIMULATE === 'true';
console.log(`[startup] AI Trading Agent — mode: ${simulate ? 'simulation' : 'live'}`);

// ── 1. Create broker feed ────────────────────────────────────────────────────
// createBrokerFeed() reads SIMULATE and BROKER env vars to select the adapter.
// It does NOT connect yet — connect() is called after all other components start.
const feed = createBrokerFeed();

// ── 2. Straddle calculator ───────────────────────────────────────────────────
// Reads market.ticks from Redis and publishes straddle.values every 15 s.
// NIFTY is the primary underlying for Phase 1.
const straddleCalc = createStraddleCalculator(redis, { underlying: 'NIFTY' });

// ── 3. VIX feed ─────────────────────────────────────────────────────────────
// Reads market.ticks for NSE:INDIAVIX-INDEX; polls NSE API as fallback.
const vixFeed = createVixFeed(redis);

// ── 4. Position monitor ──────────────────────────────────────────────────────
// Reads straddle.values and evaluates open positions for exit conditions.
// Shares the pg pool with the Fastify server to avoid competing connection pools.
const positionMonitor = createPositionMonitor(redis, pool);

// ── Tick publisher ───────────────────────────────────────────────────────────
// Each tick from the broker feed is serialised and written to the market.ticks
// Redis stream so the straddle calculator and VIX feed can consume it.
// We register this callback before connect() so no ticks are missed.
feed.onTick((tick) => {
  // Fire-and-forget: we do not await here because onTick is a synchronous
  // callback.  Redis errors are logged inside the `redis.on('error')` handler
  // in src/redis/client.ts.
  void redis.xadd('market.ticks', '*', 'data', JSON.stringify(tick));
});

// ── Log disconnects ──────────────────────────────────────────────────────────
feed.onDisconnect((reason) => {
  console.warn(`[feed] disconnected — reason: ${reason}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

/**
 * Stop all long-running components in reverse start order, then exit.
 *
 * We call process.exit(0) in a `finally` block so the process exits even if
 * one of the shutdown steps throws.  The exit code 0 signals a clean shutdown
 * to process supervisors (Railway, Docker, etc.).
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`[shutdown] received ${signal} — shutting down gracefully`);
  try {
    // Stop components in reverse order: position monitor → VIX feed → straddle calc.
    // These are all non-blocking stop() calls that flip internal `running` flags;
    // they do not need to be awaited concurrently.
    await positionMonitor.stop();
    await vixFeed.stop();
    await straddleCalc.stop();

    // Disconnect broker feed — this closes the underlying WebSocket / timer.
    await feed.disconnect();

    // Close pg pool — the Fastify server's onClose hook would do this if we
    // called server.close(), but we call server.close() inside startServer's
    // own shutdown handler.  The pool is shared, so closing it here after the
    // server is already closed is safe and avoids a dangling pool.
    await pool.end();

    // Close Redis — ioredis.quit() sends QUIT and waits for the ACK before
    // closing the TCP connection, which is cleaner than redis.disconnect().
    await redis.quit();
  } finally {
    process.exit(0);
  }
}

// Register signal handlers before starting anything so early startup errors
// also get a clean shutdown path.
process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

// ---------------------------------------------------------------------------
// Start all components concurrently
// ---------------------------------------------------------------------------

// Start the straddle calculator, VIX feed, position monitor, and Fastify
// server in parallel — none of them depend on each other during startup.
// startServer() receives the shared pool so Fastify reuses it instead of
// opening its own set of pg connections.
await Promise.all([
  straddleCalc.start(),
  vixFeed.start(),
  positionMonitor.start(),
  // startServer registers its own SIGINT/SIGTERM handlers for server.close().
  // Our outer handlers (above) also call feed.disconnect(), pool.end(), and
  // redis.quit() which the server's handlers do not cover.
  startServer(pool),
]);

// ── 6. Connect broker feed ───────────────────────────────────────────────────
// Connect after all consumers are ready so no ticks are dropped between
// "feed connected" and "straddle calc started".
await feed.connect();
console.log('[startup] broker feed connected — receiving ticks');
