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
import { getSymbolMaster } from './ingestion/brokers/symbol-master.js';
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

  // Straddle calculator reads market.ticks from Redis → publishes straddle.values.
  const straddleCalc = createStraddleCalculator(redis, { underlying: 'NIFTY', clock });

  // VIX feed: reads market.ticks for NSE:INDIAVIX-INDEX; polls NSE API as fallback.
  const vixFeed = createVixFeed(redis, { clock });

  // Position monitor: reads straddle.values and evaluates open positions for exit conditions.
  const positionMonitor = createPositionMonitor(redis, pool, { clock });

  // ---------------------------------------------------------------------------
  // Live broker feed — mutable so reloadBroker() can swap it in-process.
  //
  // In-process hot-reconnect model:
  // When the operator completes the Fyers OAuth flow in the dashboard, the
  // /api/auth/fyers/callback handler calls server.onTokenStored(), which
  // triggers reloadBroker() here. reloadBroker() re-reads the token from the
  // DB, disconnects the stale feed (if any), creates a fresh adapter, attaches
  // the SAME tick/disconnect handlers defined below, connects, and clears the
  // authDegraded flag — all in-process, no restart required.
  // ---------------------------------------------------------------------------

  // Underlying is NIFTY for now (configurable via env in a future task).
  const LIVE_UNDERLYING = 'NIFTY' as const;
  // Fyers full symbol for the NIFTY spot index tick.
  const NIFTY_INDEX_SYMBOL = 'NSE:NIFTY50-INDEX';

  // lastAtmStrike is reset to null on every reload so the next index tick
  // re-subscribes the option legs against the current ATM strike. Declared
  // outside attachFeedHandlers so reloadBroker() can null it before re-wiring.
  let lastAtmStrike: number | null = null;

  // Current live feed instance. null means degraded (no token) or sim mode.
  let feed: ReturnType<typeof createBroker> | null = null;

  // Guard against overlapping reloadBroker() calls (e.g. if the callback fires
  // twice before the first reload completes). A simple boolean is sufficient
  // because this is single-threaded JS — no mutex required.
  let reloadInFlight = false;

  /**
   * Attach the canonical tick and disconnect handlers to a feed instance.
   *
   * Factored out so startup and reloadBroker() share identical wiring —
   * there is exactly ONE definition of the tick pipeline. Any future change
   * to the tick handler (e.g. adding a new stream topic) must be made here
   * only.
   */
  function attachFeedHandlers(target: ReturnType<typeof createBroker>): void {
    target.onTick?.((tick: BrokerTick) => {
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
          const subscribeResult = target.subscribe([ceSymbol, peSymbol]);
          if (subscribeResult instanceof Promise) {
            subscribeResult.catch((err: unknown) => {
              console.error('[index] ATM option-leg subscribe() failed:', err);
            });
          }
          // Validate against the Fyers symbol master in the background. The
          // registry's deterministic build is authoritative; this only catches
          // future rule drift (NSE/BSE expiry-day changes, holiday shifts)
          // before it causes silent "no option ticks" symptoms. Best-effort —
          // a failed master load never blocks live trading.
          void getSymbolMaster()
            .load()
            .then((): void => {
              const m = getSymbolMaster();
              for (const sym of [ceSymbol, peSymbol]) {
                if (!m.isSymbolListed(sym)) {
                  console.warn(
                    `[index] WARNING: built symbol ${sym} is NOT in the Fyers master — exchange may have shifted the expiry weekday or hit a holiday. Check WEEKLY_EXPIRY_DOW in instrument-registry.ts.`,
                  );
                }
              }
            })
            .catch((err: unknown) => {
              console.warn('[index] symbol-master validation skipped:', err);
            });
        }
      }
    });

    target.onDisconnect?.((reason: string) => {
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
            'Open the dashboard and click "Login with Fyers" to authenticate, ' +
            'then the feed will reconnect automatically without a restart.',
        );
      } else {
        console.warn(`[feed] disconnected — reason: ${reason}`);
      }
    });
  }

  /**
   * (Re)connect the Fyers broker feed in-process.
   *
   * Called at startup (initial connect) and by the OAuth callback hook after a
   * fresh token is stored. A successful call creates a fresh adapter, wires the
   * shared tick/disconnect handlers, connects the WebSocket, and clears
   * authDegraded — all without restarting the process.
   *
   * Safety contract:
   *  - No-op (with a log) in simulation mode — sim never needs a live broker.
   *  - No-op when BROKER !== 'fyers' — only Fyers uses OAuth token storage.
   *  - Concurrent calls are suppressed by the reloadInFlight guard.
   *  - A missing/expired token degrades gracefully (logs, leaves degraded=true)
   *    rather than throwing — the operator will trigger another login.
   *  - A stale feed is disconnected before the new one is created; errors from
   *    the stale disconnect are caught so they cannot abort the reload.
   */
  async function reloadBroker(): Promise<void> {
    if (simulate) {
      console.log('[index] reloadBroker: simulation mode — skipping live feed reload');
      return;
    }
    if ((process.env.BROKER ?? '').toLowerCase().trim() !== 'fyers') {
      console.log('[index] reloadBroker: BROKER is not fyers — skipping reload');
      return;
    }
    if (reloadInFlight) {
      console.warn('[index] reloadBroker: reload already in flight — skipping duplicate call');
      return;
    }
    reloadInFlight = true;
    try {
      // Re-resolve the token from the DB so a freshly stored OAuth token is picked up.
      // We write to process.env here (same as startup) so createBroker() can read
      // FYERS_ACCESS_TOKEN without a DB param — the factory stays pure.
      try {
        const stored = await loadStoredToken(pool);
        if (stored && stored.expiresAt.getTime() > Date.now()) {
          process.env.FYERS_ACCESS_TOKEN = stored.accessToken;
          if (!process.env.FYERS_APP_ID) process.env.FYERS_APP_ID = stored.appId;
          console.log(
            `[index] reloadBroker: loaded Fyers token from DB — expires ${stored.expiresAt.toISOString()}`,
          );
        } else if (stored) {
          console.warn(
            `[index] reloadBroker: stored token expired at ${stored.expiresAt.toISOString()} — open the dashboard and re-login.`,
          );
          return; // Cannot proceed without a valid token; leave feed/degraded state unchanged.
        } else {
          console.warn(
            '[index] reloadBroker: no token in DB — cannot reconnect. Open the dashboard and login.',
          );
          return; // Same: no usable token, leave degraded state as-is.
        }
      } catch (err) {
        console.warn('[index] reloadBroker: failed to load token from DB:', err);
        return; // DB error during token load — leave existing feed/state unchanged.
      }

      // Disconnect the stale feed if one exists. Guard errors so a socket that
      // is already half-closed cannot prevent the new feed from being created.
      if (feed !== null) {
        try {
          await feed.disconnect();
          console.log('[index] reloadBroker: previous feed disconnected');
        } catch (err) {
          console.warn('[index] reloadBroker: error disconnecting previous feed (ignored):', err);
        }
        feed = null;
      }

      // Reset the ATM strike tracker so the first index tick after reconnect
      // unconditionally re-subscribes the CE/PE legs.
      lastAtmStrike = null;

      // Build a fresh adapter and wire the shared handlers.
      feed = createBroker(clock);
      attachFeedHandlers(feed);
      await feed.connect();

      // Clear degraded flag — the feed is now live.
      setAuthDegraded(false);
      console.log('[index] reloadBroker: broker feed reconnected — receiving ticks');
    } finally {
      reloadInFlight = false;
    }
  }

  // Cold-start: attempt the initial broker connect via the shared reloadBroker()
  // path. For the non-Fyers or already-in-env case, use the original direct path
  // so we don't double-attempt a DB token load.
  //
  // Cold-start degraded boot (Fyers + no token): if loadStoredToken found nothing
  // reloadBroker() returns early and leaves feed===null. We then set authDegraded
  // and warn — same observable behaviour as before the refactor.
  const liveFyersNoToken =
    !simulate &&
    (process.env.BROKER ?? '').toLowerCase().trim() === 'fyers' &&
    !process.env.FYERS_ACCESS_TOKEN;

  if (liveFyersNoToken) {
    // Fyers + no token in env — reloadBroker() will try the DB (already done
    // above in the credential resolution block, but reloadBroker re-checks).
    // If the DB also has nothing it will log and leave feed===null. We defer
    // the degraded warning to after the reload attempt so the log is accurate.
  } else if (!simulate) {
    // Non-Fyers live broker or Fyers with token already in env — create the feed
    // directly without the DB-reload path (token is already in process.env).
    feed = createBroker(clock);
    attachFeedHandlers(feed);
  } else {
    // Simulation mode — createBroker selects the simulator adapter.
    feed = createBroker(clock);
    attachFeedHandlers(feed);
  }

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
    // Pass reloadBroker as the onTokenStored hook so the OAuth callback fires an
    // in-process feed reconnect after a successful Fyers login — no restart needed.
    startServer(pool, redis, () => {
      void reloadBroker();
    }),
  ]);

  // Pre-market Fyers token-validity check (opt-in via TOKEN_VALIDITY_SCHEDULER_ENABLED).
  // Self-guards and returns null when disabled / Redis unavailable, so this is safe
  // in every environment. Surfaces a "re-login required" degraded state, no refresh-grant.
  const tokenSchedule = registerTokenValiditySchedule(pool);

  // Connect broker feed after all consumers are ready so no ticks are dropped.
  // In cold-start degraded mode (Fyers + no token) we attempt reloadBroker() which
  // will re-check the DB one more time (in case saveToken raced ahead of startup).
  // If still no token, it logs and leaves feed===null.
  if (liveFyersNoToken) {
    // Attempt to connect via the reload path (re-checks DB, sets degraded if still no token).
    await reloadBroker();
    if (!feed) {
      // reloadBroker found no usable token — boot in degraded mode.
      setAuthDegraded(true);
      console.warn(
        '[index] No Fyers token in env or DB — booting in DEGRADED mode without a market feed. ' +
          'Open the dashboard and click "Login with Fyers" to authenticate; the feed will ' +
          'reconnect automatically without a restart.',
      );
    }
  } else if (feed) {
    await feed.connect();
    console.log('[index] broker feed connected — receiving ticks');
  }

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
      if (feed) await feed.disconnect();
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
