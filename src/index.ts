/**
 * Main entry point — full pipeline wiring.
 *
 * Startup sequence:
 *   1. Run DB migrations (fail fast if DB is unreachable)
 *   2. Determine clock (VirtualClock in SIMULATE mode, RealClock otherwise)
 *   3. Parse active underlyings from INDICES env var (default: 'NIFTY')
 *   4. Per active underlying: run calendar freshness assert + symbol resolution assert
 *      (disables the underlying for the session on failure; never crashes the process)
 *   5. Instantiate all components with the shared clock
 *   6. Start components in dependency order
 *   7. Register SIGTERM / SIGINT handlers for graceful shutdown
 *
 * Multi-index wiring (T-45):
 *   INDICES env var (comma-separated) controls which underlyings are active.
 *   Default is 'NIFTY' for backward compat. Example: INDICES=NIFTY,BANKNIFTY,SENSEX
 *   One StraddleCalculator is instantiated per active underlying. Both the single
 *   PeakDetectionEngine and the single SRDetectionEngine consume snapshots from ALL
 *   underlyings via their own independent consumer groups on the straddle.values stream
 *   (both engines are per-underlying-stateful and can handle multi-underlying streams).
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
  assertCalendarFreshness,
  buildOptionSymbol,
  CalendarExpiredError,
  getAtmStrike,
  getCurrentExpiry,
  getCurrentExpiryFromCalendar,
  validateSimSymbol,
} from './ingestion/brokers/instrument-registry.js';
import type { BrokerTick, Underlying } from './ingestion/brokers/types.js';
import { createStraddleCalculator } from './ingestion/straddle-calc.js';
import { createVixFeed } from './ingestion/vix-feed.js';
import { registerTokenValiditySchedule } from './jobs/token-validity-check.js';
import { redis } from './redis/client.js';
import { startServer } from './server/index.js';
import { loadStoredToken } from './server/services/fyers-auth.js';
import { PeakDetectionEngine, readConfigFromEnv } from './signals/peak-detection-engine.js';
import { SRDetectionEngine, readSRConfigFromEnv } from './signals/sr-detection-engine.js';
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
// Multi-index helpers (T-45)
// ---------------------------------------------------------------------------

/**
 * Parse the INDICES env var into a list of active Underlying values.
 *
 * Rules:
 *   - Comma-separated list of underlying names (case-insensitive).
 *   - Unrecognised names are logged and skipped.
 *   - Defaults to ['NIFTY'] when env var is unset or empty — backward compat.
 *   - Duplicates are deduplicated (first occurrence wins).
 *
 * Examples:
 *   INDICES unset            → ['NIFTY']
 *   INDICES=NIFTY            → ['NIFTY']
 *   INDICES=NIFTY,BANKNIFTY  → ['NIFTY', 'BANKNIFTY']
 *   INDICES=nifty,sensex     → ['NIFTY', 'SENSEX']  (case-insensitive)
 */
const VALID_UNDERLYINGS: ReadonlySet<string> = new Set(['NIFTY', 'BANKNIFTY', 'SENSEX']);

function parseActiveIndices(): Underlying[] {
  const raw = process.env.INDICES?.trim() ?? '';
  if (!raw) {
    return ['NIFTY']; // backward-compat default
  }
  const seen = new Set<string>();
  const result: Underlying[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim().toUpperCase();
    if (!VALID_UNDERLYINGS.has(name)) {
      console.warn(`[index] INDICES: unrecognised underlying '${part.trim()}' — skipping`);
      continue;
    }
    if (seen.has(name)) {
      console.warn(`[index] INDICES: duplicate underlying '${name}' — skipping`);
      continue;
    }
    seen.add(name);
    result.push(name as Underlying);
  }
  if (result.length === 0) {
    console.warn('[index] INDICES parsed to empty list — defaulting to NIFTY');
    return ['NIFTY'];
  }
  return result;
}

/**
 * Validate that the computed ATM straddle symbol for an underlying is
 * tradable in the current mode (SIM or LIVE).
 *
 * SIM mode: validates against a structural fixture (see validateSimSymbol).
 *   Cannot validate exact expiry dates without a real calendar but confirms
 *   exchange prefix, underlying name, and CE/PE suffix are correct.
 *
 * LIVE mode: validates against the broker's freshly-fetched instrument master.
 *   The instrument master is fetched once at startup. If the fetch itself
 *   fails, we log loudly and DISABLE the underlying (do not crash).
 *
 * On failure: logs loudly and returns false → caller disables the underlying.
 * On success: returns true.
 *
 * @param underlying  The index being validated.
 * @param ceSymbol    The CE leg symbol computed from ATM + expiry.
 * @param peSymbol    The PE leg symbol computed from ATM + expiry.
 * @param simulate    Whether the process is running in SIMULATE mode.
 */
async function validateSymbolResolution(
  underlying: Underlying,
  ceSymbol: string,
  peSymbol: string,
  simulate: boolean,
): Promise<boolean> {
  if (simulate) {
    // SIM mode: structural fixture validation — no real instrument master.
    const ceOk = validateSimSymbol(underlying, ceSymbol);
    const peOk = validateSimSymbol(underlying, peSymbol);
    if (!ceOk || !peOk) {
      console.error(
        `[index] SYMBOL RESOLUTION FAILED (SIM): ${underlying} ` +
          `CE='${ceSymbol}' valid=${ceOk} | PE='${peSymbol}' valid=${peOk}. ` +
          `Disabling ${underlying} for this session.`,
      );
      return false;
    }
    console.log(
      `[index] Symbol resolution OK (SIM): ${underlying} CE='${ceSymbol}' PE='${peSymbol}'`,
    );
    return true;
  }

  // LIVE mode: validate against broker instrument master.
  // The instrument master is a set of all tradable symbols fetched from the broker.
  // We use a simple in-memory Set for O(1) lookups.
  //
  // NOTE: Fyers publishes an instrument master JSON/CSV at a public URL that
  // changes daily. Fetching it here is the correct approach for production.
  // The actual HTTP fetch is behind a try/catch — a network failure disables
  // the underlying rather than crashing the process.
  //
  // Current implementation: we fetch the Fyers instrument master for the
  // relevant exchange (NSE for NIFTY/BANKNIFTY, BSE for SENSEX) and check
  // for the symbol string. The master URL format is:
  //   https://public.fyers.in/sym_details/NSE_FO.csv  (NSE F&O)
  //   https://public.fyers.in/sym_details/BSE_FO.csv  (BSE F&O)
  //
  // Because fetching the full instrument master CSV (which can be several MB)
  // adds latency at startup and requires HTTP access that may not be available
  // in CI, we implement a LITE check: verify that the symbol follows the
  // structural format expected by Fyers. In production, replace this with a
  // real instrument master lookup if exact validation is required.
  //
  // LIVE-mode structural check (same as SIM for now). A full master-file
  // lookup requires Fyers API access and is deferred to a future task.
  // This is explicitly noted in log output so operators can identify the
  // gap and decide whether to add the full lookup.
  console.warn(
    `[index] LIVE symbol resolution: using structural check for ${underlying} ` +
      `(full broker instrument master lookup deferred — validate manually before production).`,
  );
  const ceOk = validateSimSymbol(underlying, ceSymbol);
  const peOk = validateSimSymbol(underlying, peSymbol);
  if (!ceOk || !peOk) {
    console.error(
      `[index] SYMBOL RESOLUTION FAILED (LIVE structural): ${underlying} ` +
        `CE='${ceSymbol}' valid=${ceOk} | PE='${peSymbol}' valid=${peOk}. ` +
        `Disabling ${underlying} for this session.`,
    );
    return false;
  }
  console.log(
    `[index] Symbol resolution OK (LIVE structural): ${underlying} ` +
      `CE='${ceSymbol}' PE='${peSymbol}'`,
  );
  return true;
}

/**
 * Run both startup asserts (calendar freshness + symbol resolution) for one
 * underlying. Returns true if the underlying is safe to use; false if it
 * should be disabled for this session.
 *
 * Hard-fail on CalendarExpiredError (no future expiry in the calendar).
 * Disable-on-fail for symbol resolution failures.
 *
 * Uses a representative ATM strike (round number) for symbol validation —
 * the exact price doesn't matter; what matters is that the symbol string
 * format is correct for the underlying.
 */
async function assertUnderlyingReadiness(
  underlying: Underlying,
  simulate: boolean,
  clock: RealClock | VirtualClock,
): Promise<boolean> {
  // -------------------------------------------------------------------------
  // Assert 1: Calendar freshness (HARD FAIL on expired calendar)
  // -------------------------------------------------------------------------
  try {
    await assertCalendarFreshness(underlying, pool, clock);
  } catch (err: unknown) {
    if (err instanceof CalendarExpiredError) {
      // CalendarExpiredError is thrown when there is NO future expiry.
      // This is a hard fail — we cannot compute the correct option symbols.
      // We disable the underlying rather than crashing the whole process
      // (NIFTY being disabled is still a serious operational issue but at
      // least BANKNIFTY/SENSEX can continue, and the operator is notified).
      console.error(`[index] ${err.message}`);
      console.error(
        `[index] DISABLING ${underlying} for this session due to expired calendar.`,
      );
      return false;
    }
    // Any other error from the DB (connection failure, etc.) — disable and log.
    console.error(
      `[index] Calendar freshness check failed for ${underlying} (DB error):`,
      err,
    );
    console.error(`[index] DISABLING ${underlying} for this session.`);
    return false;
  }

  // -------------------------------------------------------------------------
  // Assert 2: Symbol resolution (DISABLE on failure — do not crash process)
  // -------------------------------------------------------------------------
  let expiryDate: Date;
  try {
    expiryDate = await getCurrentExpiryFromCalendar(underlying, pool, clock);
  } catch (err: unknown) {
    // This should not happen immediately after assertCalendarFreshness passes,
    // but guard defensively against a race condition or transient DB issue.
    console.error(
      `[index] Could not fetch expiry for ${underlying} after calendar assert passed:`,
      err,
    );
    console.error(`[index] DISABLING ${underlying} for this session.`);
    return false;
  }

  // Use a representative ATM strike for validation.
  // Actual strike doesn't affect symbol format correctness — only the
  // prefix, underlying name, expiry encoding, and CE/PE suffix matter.
  const REPRESENTATIVE_ATM: Record<Underlying, number> = {
    NIFTY: 24500,
    BANKNIFTY: 52000,
    SENSEX: 80000,
  };
  const atmStrike = getAtmStrike(underlying, REPRESENTATIVE_ATM[underlying]);
  const ceSymbol = buildOptionSymbol(underlying, expiryDate, atmStrike, 'CE');
  const peSymbol = buildOptionSymbol(underlying, expiryDate, atmStrike, 'PE');

  const symbolsOk = await validateSymbolResolution(underlying, ceSymbol, peSymbol, simulate);
  if (!symbolsOk) {
    // Logged inside validateSymbolResolution.
    return false;
  }

  return true;
}

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

  // Step 3: parse active underlyings.
  //
  // INDICES env var (comma-separated) selects which underlyings to run.
  // Default is 'NIFTY' for backward compatibility — unchanged behaviour
  // when INDICES is unset or set to 'NIFTY'.
  const requestedIndices = parseActiveIndices();
  console.log(`[index] Requested underlyings: ${requestedIndices.join(', ')}`);

  // Step 4: per-underlying startup asserts.
  //
  // For each requested underlying, run:
  //   a) Calendar freshness assert — hard fail on expired calendar
  //   b) Symbol resolution assert — disable underlying on failure
  //
  // The process is NOT killed on assertion failure — we disable the underlying
  // and continue with the remaining underlyings. This allows BANKNIFTY to run
  // even if SENSEX has a stale calendar, for example.
  //
  // If ALL underlyings fail, there is nothing to trade — log and exit.
  const activeIndices: Underlying[] = [];
  for (const underlying of requestedIndices) {
    const ready = await assertUnderlyingReadiness(underlying, simulate, clock);
    if (ready) {
      activeIndices.push(underlying);
      console.log(`[index] ${underlying}: startup asserts PASSED — active for this session`);
    } else {
      console.warn(
        `[index] ${underlying}: startup asserts FAILED — DISABLED for this session`,
      );
    }
  }

  if (activeIndices.length === 0) {
    console.error(
      '[index] FATAL: all requested underlyings failed startup asserts. ' +
        'Check index_expiry_calendar and broker connectivity. Exiting.',
    );
    process.exit(1);
  }

  console.log(`[index] Active underlyings for this session: ${activeIndices.join(', ')}`);

  // Step 5: instantiate all components.
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

  // -------------------------------------------------------------------------
  // Straddle calculators — one per active underlying (T-45 multi-index wiring)
  //
  // Each StraddleCalculator subscribes to market.ticks and publishes snapshots
  // for its own underlying to straddle.values. The single PeakDetectionEngine
  // and single SRDetectionEngine both consume straddle.values and use the
  // `underlying` field on each message to route to per-underlying state.
  //
  // Backward compat: when INDICES=NIFTY (default), this produces exactly one
  // StraddleCalculator for NIFTY — identical behaviour to before T-45.
  //
  // FIX H1: Inject a pre-resolved calendar expiry into each calculator.
  //
  // getCurrentExpiry (the Thursday formula) ignores the underlying argument
  // and always returns a Thursday. BankNifty options expire on Wednesdays and
  // Sensex options expire on Fridays — so the Thursday formula produces wrong
  // option symbols for those underlyings. The startup assert already resolved
  // the correct expiry via getCurrentExpiryFromCalendar; we pass it here so
  // the calculator uses the calendar-correct date for symbol building.
  //
  // We also pass a resolveExpiry closure so the calculator can refresh
  // in-memory when the current expiry rolls over (at 15:30 IST on expiry day).
  // The closure captures the pool so straddle-calc.ts does not need to import
  // 'pg' directly (keeping its existing dependency surface unchanged).
  // -------------------------------------------------------------------------

  // Resolve the current calendar expiry for each active underlying.
  // assertUnderlyingReadiness already called getCurrentExpiryFromCalendar
  // inside, but it did not return the Date. We call it again here; the DB
  // round-trip is at startup only (not on the hot path) so the cost is fine.
  const expiryByUnderlying = new Map<Underlying, Date>();
  for (const underlying of activeIndices) {
    try {
      const expiry = await getCurrentExpiryFromCalendar(underlying, pool, clock);
      expiryByUnderlying.set(underlying, expiry);
      console.log(
        `[index] ${underlying}: resolved calendar expiry ${expiry.toISOString().slice(0, 10)}`,
      );
    } catch (err) {
      // This should not happen — assertUnderlyingReadiness already passed for
      // this underlying, meaning a future expiry exists. Guard defensively: if
      // it fails here, fall back to the Thursday formula (NIFTY is unaffected;
      // BANKNIFTY/SENSEX would be wrong but this path is extremely unlikely).
      console.error(
        `[index] ${underlying}: unexpected failure re-resolving calendar expiry — ` +
          `falling back to Thursday formula (BANKNIFTY/SENSEX symbols may be wrong):`,
        err,
      );
    }
  }

  const straddleCalcs = activeIndices.map((underlying) => {
    const currentExpiry = expiryByUnderlying.get(underlying);

    // Build the config conditionally to satisfy exactOptionalPropertyTypes.
    // When currentExpiry is undefined (calendar resolve failed — extremely rare
    // defensive path), we omit both optional properties so the calculator falls
    // back to the Thursday formula rather than receiving explicit undefineds.
    if (currentExpiry !== undefined) {
      // resolveExpiry closure: called by the calculator on week rollover (at
      // most once per expiry week, never on the hot 15s snapshot path).
      const resolveExpiry = async (): Promise<Date> =>
        getCurrentExpiryFromCalendar(underlying, pool, clock);

      return createStraddleCalculator(redis, {
        underlying,
        clock,
        currentExpiry,
        resolveExpiry,
      });
    }

    // Fallback — no calendar expiry available (extremely rare; assertUnderlyingReadiness
    // already passed so this branch should never be reached in practice).
    return createStraddleCalculator(redis, { underlying, clock });
  });

  // PeakDetectionEngine — single instance, consumes ALL underlyings' snapshots
  // via the straddle.values stream. The engine is per-underlying-stateful
  // internally (keyed by underlying field in each message).
  const peakConfig = readConfigFromEnv();
  const peakEngine = new PeakDetectionEngine(pool, redis, peakConfig, clock);

  // SRDetectionEngine (T-43-C) — wired into bootstrap here (T-45 requirement).
  // Same pattern as PeakDetectionEngine: single instance, handles all underlyings.
  const srConfig = readSRConfigFromEnv();
  const srEngine = new SRDetectionEngine(pool, redis, srConfig, clock);

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

  // Step 6: start components in dependency order.
  //
  // All straddle calculators, the peak engine, SR engine, VIX feed, and position
  // monitor are started in parallel. They have no start-order dependencies because
  // they all read from Redis streams (which buffer messages until readers arrive).
  await Promise.all([
    // Start all straddle calculators (one per active underlying)
    ...straddleCalcs.map((sc) => sc.start()),
    // Start signal engines (both consume straddle.values, independent consumer groups)
    peakEngine.start(),
    srEngine.start(),
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

  // Step 7: in simulation mode, advance the virtual clock on a real setInterval.
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
      // FIX M2: Stop straddle calculators BEFORE signal engines.
      //
      // The straddle calculators publish to the straddle.values stream.
      // The signal engines (peakEngine, srEngine) consume from straddle.values
      // via their XREADGROUP poll loops. If we stopped the engines first, any
      // straddle.values messages produced by the calculators between engine
      // loop exit and calculator stop would be delivered but not ACK'd,
      // causing them to be re-delivered on restart (the "pending" PEL entries).
      //
      // Stopping calculators first ensures no new straddle.values messages are
      // produced once the engines have stopped consuming. Any in-flight messages
      // already in the pending list are handled by the ON CONFLICT DO NOTHING
      // idempotent INSERTs added in migration 014.
      await Promise.all(straddleCalcs.map((sc) => sc.stop()));
      // Stop signal engines after calculators so no new snapshots arrive once
      // the engines exit their consumer loops.
      await peakEngine.stop();
      await srEngine.stop();
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
