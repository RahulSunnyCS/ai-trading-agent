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
 * because it is the process entry point; the broker auth-degraded flag lives in
 * src/state/broker-status.ts so the server can import it without pulling in the
 * full entry-point module.
 *
 * Payment routes (Razorpay/UPI): registered via startServer() from src/server/index.ts
 * which wires up the payment routes alongside the existing trading API routes.
 */

import { pool } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createBroker } from './ingestion/brokers/broker-factory.js';
import {
  buildOptionSymbol,
  getAtmStrike,
  getCurrentExpiry,
} from './ingestion/brokers/instrument-registry.js';
import type { BrokerTick } from './ingestion/brokers/types.js';
import { createStraddleCalculator } from './ingestion/straddle-calc.js';
import { createVixFeed } from './ingestion/vix-feed.js';
import { registerTokenValiditySchedule } from './jobs/token-validity-check.js';
import { redis } from './redis/client.js';
import { startServer } from './server/index.js';
import { loadStoredToken } from './server/services/fyers-auth.js';
import { setAuthDegraded } from './state/broker-status.js';
import { createPositionMonitor } from './trading/position-monitor.js';
import { RealClock, VirtualClock } from './utils/clock.js';

// ---------------------------------------------------------------------------
// Simulation tick interval
// ---------------------------------------------------------------------------

// How many ms of virtual time to advance per real tick in simulation mode.
// Read at startup so operators can tune simulation speed via env var without
// code changes. Default 1000 ms of virtual time per 1000 ms of real time (1:1).
const SIM_TICK_INTERVAL_MS = (() => {
  const parsed = Number.parseInt(process.env.SIM_TICK_INTERVAL_MS ?? '', 10);
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
  const simulate = process.env.SIMULATE?.toLowerCase().trim() === 'true';

  const clock = simulate ? new VirtualClock(new Date(Date.now())) : new RealClock();

  if (simulate) {
    console.log(`[index] Simulation mode active — advancing clock every ${SIM_TICK_INTERVAL_MS}ms`);
  } else {
    console.log('[index] Live mode active — using real clock');
  }

  // Step 3: instantiate all components.
  //
  // Credential resolution for the Fyers broker must happen BEFORE createBroker()
  // is called, because _createFyersBroker() (inside broker-factory) validates
  // FYERS_APP_ID and FYERS_ACCESS_TOKEN at construction time and throws if they
  // are missing. We centralise the resolution here so the factory stays pure
  // (env-var reads only; no DB access) and this file owns the DB→env fallback.
  //
  // Resolution order:
  //   1. Env var already set (e.g. .env or shell export) — use as-is.
  //   2. Not in env → try broker_tokens DB table (written by the dashboard
  //      OAuth "Login with Fyers" flow). If found and not expired, write to
  //      process.env so _createFyersBroker() sees them on the same path as
  //      operators who provide tokens via the environment.
  // The credential resolution block only runs when BROKER=fyers AND we are not
  // in simulation mode. When SIMULATE=true the broker-factory will use the
  // simulator path regardless of what BROKER is set to — so we must not
  // attempt Fyers credential resolution (it would throw for missing tokens).
  if (
    !simulate &&
    (process.env.BROKER ?? '').toLowerCase().trim() === 'fyers' &&
    !process.env.FYERS_ACCESS_TOKEN
  ) {
    try {
      const stored = await loadStoredToken(pool);
      if (stored && stored.expiresAt.getTime() > Date.now()) {
        process.env.FYERS_ACCESS_TOKEN = stored.accessToken;
        // APP_ID may already be set via env; only overwrite when absent to avoid
        // clobbering a deliberately different app ID in a multi-app deployment.
        if (!process.env.FYERS_APP_ID) process.env.FYERS_APP_ID = stored.appId;
        console.log(
          `[index] Loaded Fyers token from DB — expires ${stored.expiresAt.toISOString()}`,
        );
      } else if (stored) {
        console.warn(
          `[index] Stored Fyers token expired at ${stored.expiresAt.toISOString()} — open the dashboard and re-login.`,
        );
      } else {
        console.warn(
          "[index] BROKER=fyers but no token in env or DB — open the dashboard and click 'Login with Fyers'.",
        );
      }
    } catch (err) {
      console.warn('[index] Failed to load Fyers token from DB:', err);
    }
  }

  // When SIMULATE=true the operator intends to run the simulator regardless of
  // what BROKER is set to (e.g. BROKER=fyers may be present in .env for live
  // usage but SIMULATE=true overrides it for development). broker-factory.ts
  // checks BROKER before SIMULATE, so we must set BROKER=sim here to ensure
  // _createSimulator() is selected. This is the only place we mutate BROKER
  // at runtime and only when simulate===true, so live runs are unaffected.
  // broker-factory.ts is in files_forbidden so we handle the precedence here.
  if (simulate) {
    process.env.BROKER = 'sim';
  }

  // createBroker reads BROKER and SIMULATE env vars and picks the right adapter.
  // Credentials are already resolved into process.env above (Fyers path) or
  // are validated against their own env vars by the factory (AngelOne path).
  const feed = createBroker(clock);

  // Straddle calculator reads market.ticks from Redis → publishes straddle.values.
  const straddleCalc = createStraddleCalculator(redis, { underlying: 'NIFTY', clock });

  // VIX feed: reads market.ticks for NSE:INDIAVIX-INDEX; polls NSE API as fallback.
  const vixFeed = createVixFeed(redis, { clock });

  // Position monitor: reads straddle.values and evaluates open positions for exit conditions.
  const positionMonitor = createPositionMonitor(redis, pool, { clock });

  // Wire tick publisher: each tick from the broker feed is serialised and written to
  // the market.ticks Redis stream so the straddle calculator and VIX feed can consume it.
  //
  // Dynamic ATM option-leg subscription (live brokers only):
  // After the feed connects, the first index spot tick (NSE:NIFTY50-INDEX) lets us
  // compute the ATM strike. We then subscribe to the CE and PE legs so the Fyers
  // WebSocket delivers option prices directly — the straddle calculator needs them.
  //
  // This block intentionally does NOT run in SIMULATE mode because the simulator
  // (T-03) already generates synthetic CE and PE ticks internally. Calling
  // feed.subscribe() on the simulator would be a no-op (it ignores symbol lists)
  // but guarding here makes the intent explicit and avoids any future confusion.
  //
  // We track lastAtmStrike to avoid redundant subscribe() calls when the spot
  // price drifts within the same ATM bucket. A new subscribe is only issued when
  // the ATM strike actually changes (spot crosses a 50-point boundary for NIFTY).

  // Underlying is NIFTY for now (configurable via env in a future task).
  const LIVE_UNDERLYING = 'NIFTY' as const;
  // Fyers full symbol for the NIFTY spot index tick.
  const NIFTY_INDEX_SYMBOL = 'NSE:NIFTY50-INDEX';
  let lastAtmStrike: number | null = null;

  feed.onTick?.((tick: BrokerTick) => {
    // Fire-and-forget: we do not await here because onTick is a synchronous callback.
    // MAXLEN ~ 10000 caps the stream size to approximately 10 000 entries (the ~
    // tilde allows Redis to trim lazily at radix-tree node boundaries for O(1)
    // amortised cost). Without a cap, this stream grows unboundedly — the Fyers
    // integration added CE and PE option-leg ticks so volume tripled from M1.
    void redis.xadd('market.ticks', 'MAXLEN', '~', '10000', '*', 'data', JSON.stringify(tick));

    // Dynamic ATM subscription — live mode only. In simulate mode the simulator
    // already emits CE/PE legs, so we skip this block entirely.
    if (!simulate && tick.symbol === NIFTY_INDEX_SYMBOL && tick.ltp > 0) {
      const atm = getAtmStrike(LIVE_UNDERLYING, tick.ltp);
      if (atm !== lastAtmStrike) {
        lastAtmStrike = atm;
        const expiry = getCurrentExpiry(LIVE_UNDERLYING, clock);
        const ceSymbol = buildOptionSymbol(LIVE_UNDERLYING, expiry, atm, 'CE');
        const peSymbol = buildOptionSymbol(LIVE_UNDERLYING, expiry, atm, 'PE');
        console.log(
          `[index] ATM strike changed to ${atm} — subscribing to ${ceSymbol}, ${peSymbol}`,
        );
        // subscribe() may return void or Promise<void> depending on the adapter.
        // We always handle it as a promise and catch errors defensively so that
        // a transient subscription failure does not crash the ingestion pipeline.
        const subscribeResult = feed.subscribe([ceSymbol, peSymbol]);
        if (subscribeResult instanceof Promise) {
          subscribeResult.catch((err: unknown) => {
            console.error('[index] ATM option-leg subscribe() failed:', err);
          });
        }
      }
    }
  });

  feed.onDisconnect?.((reason: string) => {
    // DisconnectReason (from types.ts) is a string enum whose AUTH_FAILURE
    // member has the runtime value 'AUTH_FAILURE'. We compare the string
    // literal directly here to avoid importing the enum value at runtime.
    if (reason === 'AUTH_FAILURE') {
      // Fyers daily token expired mid-session. Set the shared degraded flag so
      // the dashboard can display an actionable "re-login required" banner.
      // We do NOT crash the process — ingestion is suspended but the HTTP API
      // and the dashboard remain available for the operator to initiate re-login.
      setAuthDegraded(true);
      console.error(
        '[feed] AUTH_FAILURE — Fyers token has expired. ' +
          'Open the dashboard and click "Login with Fyers" to generate a new token, ' +
          'then restart the application. Market data feed is suspended until re-login.',
      );
    } else {
      console.warn(`[feed] disconnected — reason: ${reason}`);
    }
  });

  // Step 4: start components in dependency order.
  await Promise.all([
    straddleCalc.start(),
    vixFeed.start(),
    positionMonitor.start(),
    // startServer registers its own SIGINT/SIGTERM handlers for server.close().
    // Our outer handlers (below) also call feed.disconnect(), pool.end(), and
    // redis.quit() which the server's handlers do not cover.
    //
    // Pass the shared redis singleton so the server's WS /ws/ticks handler can
    // stream live ticks and straddle values to connected dashboard clients.
    // The param name `externalRedis` matches the startServer signature in
    // src/server/index.ts (confirmed by reading that file).
    startServer(pool, redis),
  ]);

  // Pre-market Fyers token-validity check (opt-in via TOKEN_VALIDITY_SCHEDULER_ENABLED).
  // Self-guards and returns null when disabled / Redis unavailable, so this is safe
  // in every environment. Surfaces a "re-login required" degraded state, no refresh-grant.
  const tokenSchedule = registerTokenValiditySchedule(pool);

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
      if (tokenSchedule) {
        await tokenSchedule.worker.close();
        await tokenSchedule.queue.close();
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

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('unhandledRejection', (reason: unknown) => {
    console.error('[index] Unhandled rejection:', reason);
    void shutdown('unhandledRejection');
  });

  process.on('uncaughtException', (err: Error) => {
    console.error('[index] Uncaught exception:', err);
    void shutdown('uncaughtException');
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('[index] Fatal startup error:', err);
  process.exit(1);
});
