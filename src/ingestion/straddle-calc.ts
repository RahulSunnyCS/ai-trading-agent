/**
 * Straddle Calculator
 *
 * Subscribes to the `market.ticks` Redis Stream, maintains an in-memory price
 * map, and every `snapshotIntervalMs` milliseconds computes a StraddleSnapshot
 * for the current ATM strike of the configured underlying.  Each snapshot is
 * published to the `straddle.values` Redis Stream for downstream consumers
 * (signal generator, dashboard, etc.).
 *
 * ROC (Rate of Change) and acceleration (second derivative of straddle value)
 * are computed from a rolling buffer of the last `rocWindowSize` straddle values.
 *
 * Design decisions:
 * - Non-blocking XREAD poll loop (no BLOCK) so the `running` flag is checked on
 *   every iteration, enabling clean shutdown without waiting for a blocking call.
 * - A small sleep between empty polls prevents a tight CPU spin when no ticks are
 *   arriving (typical outside market hours).
 * - The interval for snapshots is kept separate from the poll loop; snapshot timing
 *   is driven by setInterval so it stays as close to wall-clock-aligned as Bun allows.
 */

import type { Redis } from 'ioredis';

import type { Clock } from '../utils/clock';
import { RealClock } from '../utils/clock';
import { buildOptionSymbol, getAtmStrike, getCurrentExpiry } from './brokers/instrument-registry';
import type { BrokerTick, Underlying } from './brokers/types';
import { computeAcceleration, computeRoc } from './straddle-math';

// IST offset in milliseconds — used for expiry rollover detection.
// IST = UTC+5:30, no DST. Declared at module level to avoid re-computing
// inside the hot 15s snapshot path.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
// Expiry is considered expired after 15:30 IST on expiry day.
// We check this as: (istHour > 15) || (istHour === 15 && istMin >= 30)
const EXPIRY_CUTOFF_HOUR = 15;
const EXPIRY_CUTOFF_MIN = 30;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface StraddleSnapshot {
  underlying: Underlying;
  /** Unix ms (from clock) */
  timestamp: number;
  atmStrike: number;
  cePrice: number;
  pePrice: number;
  /** cePrice + pePrice */
  straddleValue: number;
  /** Rate of change: (current - prev) / prev * 100; 0 when < 2 snapshots */
  roc: number;
  /** Second derivative: roc_current - roc_prev; 0 when < 3 snapshots */
  acceleration: number;
  /** How many snapshots have been collected so far (monotonically increasing) */
  snapshotCount: number;
}

export interface StraddleCalcConfig {
  underlying: Underlying;
  /** Snapshot interval in ms (default: 15000) */
  snapshotIntervalMs?: number;
  /** Number of past straddle values to keep for ROC/acceleration (default: 5) */
  rocWindowSize?: number;
  /** Injectable clock for deterministic testing (default: RealClock) */
  clock?: Clock;
  /**
   * XREAD cursor start ID (default: '$' for live mode = only new messages).
   * In replay mode, set to '0' so the poll loop reads from the beginning of the stream.
   * We never pass '$' in replay because '$' would skip all ticks published before
   * the poll loop starts, breaking publish/consume ordering.
   */
  startId?: string;
  /**
   * If true, start() does NOT set up a setInterval for snapshot cadence.
   * Used in replay mode where snapshotStep() drives cadence directly.
   * Default: false (live mode uses setInterval).
   *
   * WHY needed in tests?
   * The replay test uses vi.useFakeTimers(). When fake timers advance past
   * snapshotIntervalMs, the setInterval would fire an extra void snapshot,
   * corrupting the deterministic snapshot count. Setting noInterval=true
   * prevents this by not registering the interval at all.
   */
  noInterval?: boolean;
  /**
   * Pre-resolved current weekly expiry date for this underlying.
   *
   * When provided, the calculator uses this date for option symbol building
   * instead of the synchronous Thursday-weekday formula (getCurrentExpiry).
   * This is REQUIRED for BankNifty (Wednesday expiry) and Sensex (Friday
   * expiry) to produce correct symbols — getCurrentExpiry always returns a
   * Thursday and is therefore wrong for those underlyings.
   *
   * Resolution: call getCurrentExpiryFromCalendar(pool, underlying, clock) in
   * index.ts at startup and pass the result here. The calculator caches it
   * and refreshes in-memory when the clock advances past the expiry date so
   * there are NO per-tick DB calls.
   *
   * Week rollover: when the clock indicates the cached expiry has passed
   * (15:30 IST on expiry day), the calculator calls resolveExpiry() to fetch
   * the next expiry and caches the result. This is a one-off async call at
   * the week boundary — not a hot-path operation.
   *
   * When omitted, falls back to getCurrentExpiry (Thursday formula).
   * NIFTY is unaffected — its weekly expiry is always Thursday, matching the
   * formula. Always provide this for BANKNIFTY and SENSEX.
   */
  currentExpiry?: Date;
  /**
   * Async function to re-resolve the expiry from the calendar when the cached
   * expiry has rolled over. Called at most once per expiry week (not per tick).
   *
   * Must be provided when currentExpiry is provided. If omitted, week rollover
   * falls back to the Thursday formula (safe for NIFTY, wrong for others).
   *
   * WHY not injected via the pool directly?
   * Keeping the DB pool out of StraddleCalcConfig preserves the existing
   * contract (straddle-calc.ts does not import 'pg' directly). index.ts
   * owns the pool and wraps the call in this closure.
   */
  resolveExpiry?: () => Promise<Date>;
}

export interface StraddleCalculator {
  /** Begins reading ticks from Redis and scheduling 15-second snapshots. */
  start(): Promise<void>;
  /** Stops the snapshot interval and the polling loop. */
  stop(): Promise<void>;
  /** Returns the last published snapshot, or null if none yet. */
  getLatestSnapshot(): StraddleSnapshot | null;
  /**
   * Deterministic replay hook: compute one snapshot from current price map state
   * and resolve ONLY after the snapshot is written to the `straddle.values` stream.
   *
   * The returned string is the Redis stream ID assigned by XADD (e.g. "1700000000000-0").
   * Returns null and skips when required prices (CE or PE) are missing.
   *
   * LIVE MODE: never call this from live code — use setInterval + void takeSnapshot().
   * REPLAY MODE: the driver awaits this to guarantee ordering (no floating promise).
   *
   * Why a dedicated method rather than making takeSnapshot() public?
   * - We need the stream ID returned to callers (the drain barrier needs it).
   * - It makes the live/replay distinction explicit in the type signature.
   * - The live setInterval path stays fire-and-forget (no await) per the contract
   *   that says "live mode behaviour is unchanged".
   */
  snapshotStep(): Promise<string | null>;
  /**
   * INPUT-SIDE DRAIN BARRIER — resolves when the poll loop's market.ticks cursor
   * has advanced past (or to) the given stream ID.
   *
   * WHY this is needed:
   * The poll loop runs concurrently and reads from market.ticks via XREAD. After
   * publishing ticks to Redis, the replay driver must wait until the calculator
   * has actually consumed those entries and updated its price map BEFORE calling
   * snapshotStep(). Without this barrier, snapshotStep() could fire against a stale
   * price map and silently produce wrong snapshot values, breaking the determinism
   * guarantee. The previous microtask-yield loop (10× await Promise.resolve()) was
   * a hand-tuned heuristic that only worked against a synchronous in-memory fake
   * Redis — it is not reliable under real Redis latency.
   *
   * USAGE: after all xadd calls for a step resolve, capture the last published
   * stream ID and await calculator.ticksConsumed(lastXaddId) before calling
   * snapshotStep().
   *
   * LIVE MODE: never call this from live code. It is a no-op for live use and
   * has no overhead when never called.
   *
   * @param lastXaddId  The Redis stream ID of the last tick published to market.ticks.
   */
  ticksConsumed(lastXaddId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal type for the price map entries
// ---------------------------------------------------------------------------

interface PriceEntry {
  price: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Rolling-buffer helpers — re-exported from straddle-math for backward
// compatibility with existing tests that import them from straddle-calc.
// The implementation now lives exclusively in straddle-math.ts.
// ---------------------------------------------------------------------------

export { computeRoc, computeAcceleration } from './straddle-math';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a StraddleCalculator bound to the provided Redis client and config.
 *
 * The returned object has no side effects until `start()` is called.
 */
export function createStraddleCalculator(
  redisClient: Redis,
  config: StraddleCalcConfig,
): StraddleCalculator {
  const underlying = config.underlying;
  const snapshotIntervalMs = config.snapshotIntervalMs ?? 15_000;
  const rocWindowSize = config.rocWindowSize ?? 5;
  const clock: Clock = config.clock ?? new RealClock();

  // ---------------------------------------------------------------------------
  // Expiry caching — FIX H1
  //
  // The synchronous getCurrentExpiry() always returns the nearest Thursday
  // regardless of the `underlying` argument. BankNifty options expire on
  // Wednesdays and Sensex options expire on Fridays — so the Thursday formula
  // produces wrong symbols for those underlyings.
  //
  // We solve this by accepting a pre-resolved calendar expiry at construction
  // time (config.currentExpiry) and refreshing it in-memory on week rollover.
  //
  // Week rollover detection: after the expiry date's 15:30 IST cutoff, the
  // current expiry is "expired". We detect this synchronously in
  // resolveCurrentExpiry() using the clock, then kick off a single async
  // refresh. The refresh is debounced via `expiryRefreshInFlight` so concurrent
  // snapshot calls during the rollover moment never trigger multiple DB hits.
  //
  // WHY cache in a mutable variable rather than re-computing per snapshot?
  // getCurrentExpiryFromCalendar() is async (DB call). The 15s snapshot path
  // is fire-and-forget and cannot await async work on the hot path. Caching
  // the result and refreshing lazily on rollover is the only correct approach.
  // ---------------------------------------------------------------------------

  // Mutable cached expiry — updated on week rollover.
  let cachedExpiry: Date | null = config.currentExpiry ?? null;
  // Guards against concurrent refresh calls during the rollover window.
  let expiryRefreshInFlight = false;

  /**
   * Return the expiry date to use for this snapshot.
   *
   * Uses the cached calendar expiry when available. Falls back to the Thursday
   * formula (getCurrentExpiry) only when no calendar expiry was injected.
   * Triggers an async rollover refresh when the clock is past the expiry cutoff
   * on the expiry day — the current snapshot still uses the OLD expiry (which
   * is still correct until 15:30 IST), and subsequent snapshots see the new
   * one once the refresh resolves.
   *
   * WHY still return the old expiry during refresh?
   * The old expiry is valid up to (and including) 15:30 IST on expiry day.
   * Returning null or blocking would break the current snapshot. The async
   * refresh updates cachedExpiry before the next snapshot fires (15s later).
   */
  function resolveCurrentExpiry(): Date {
    if (cachedExpiry === null) {
      // No calendar expiry injected — use Thursday fallback.
      // NIFTY is correct with this; BANKNIFTY/SENSEX are wrong but this is a
      // config error (caller must always provide currentExpiry for non-NIFTY).
      return getCurrentExpiry(underlying, clock);
    }

    // Check if the cached expiry has rolled over. We detect rollover as:
    //   clock is >= 15:30 IST on the expiry day OR clock is past the expiry day.
    //
    // We compare UTC calendar dates: the cached expiry is UTC-midnight-aligned
    // (parsed as YYYY-MM-DDT00:00:00.000Z in instrument-registry), so its
    // getUTCDate/Month/Year are the correct IST calendar date values.
    const nowMs = clock.timestamp?.() ?? clock.now();
    const nowIst = new Date(nowMs + IST_OFFSET_MS);
    const expiryUtcDate = cachedExpiry;

    // Check if the IST calendar date is PAST the expiry date
    const nowIstDateOnly = new Date(
      Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()),
    );
    const expiryDateOnly = new Date(
      Date.UTC(
        expiryUtcDate.getUTCFullYear(),
        expiryUtcDate.getUTCMonth(),
        expiryUtcDate.getUTCDate(),
      ),
    );

    const isPastExpiryDay = nowIstDateOnly > expiryDateOnly;
    const isExpiryDay = nowIstDateOnly.getTime() === expiryDateOnly.getTime();
    const istHour = nowIst.getUTCHours();
    const istMin = nowIst.getUTCMinutes();
    const isPastCutoff =
      istHour > EXPIRY_CUTOFF_HOUR ||
      (istHour === EXPIRY_CUTOFF_HOUR && istMin >= EXPIRY_CUTOFF_MIN);

    const needsRollover = isPastExpiryDay || (isExpiryDay && isPastCutoff);

    if (needsRollover && !expiryRefreshInFlight && config.resolveExpiry) {
      // Trigger the async refresh. This is NOT awaited — the current snapshot
      // still uses the old expiry (valid up to 15:30 IST on expiry day), and
      // the next snapshot (15s later) will see the refreshed expiry.
      expiryRefreshInFlight = true;
      config
        .resolveExpiry()
        .then((newExpiry) => {
          cachedExpiry = newExpiry;
          console.log(
            `[straddle-calc] Week rollover for ${underlying}: ` +
              `new expiry ${newExpiry.toISOString().slice(0, 10)}`,
          );
        })
        .catch((err: unknown) => {
          console.error(
            `[straddle-calc] Failed to refresh expiry for ${underlying} on rollover:`,
            err,
          );
          // Leave cachedExpiry as-is — the next snapshot will retry
          // (expiryRefreshInFlight is reset in finally).
        })
        .finally(() => {
          expiryRefreshInFlight = false;
        });
    }

    return cachedExpiry;
  }

  // In-memory map from Fyers symbol string → latest price + timestamp.
  const priceMap = new Map<string, PriceEntry>();

  // Rolling buffer of straddle values (capped at rocWindowSize).
  const straddleBuffer: number[] = [];

  // Total snapshots published (used to populate snapshotCount in the struct).
  let snapshotCount = 0;

  // Most recently published snapshot.
  let latestSnapshot: StraddleSnapshot | null = null;

  // Control flags.
  let running = false;
  let snapshotInterval: ReturnType<typeof setInterval> | null = null;

  // Last XREAD cursor.
  // '$' (default, live mode) = only new messages from now on; we skip history.
  // '0' (replay mode) = read from the beginning so ticks published before poll
  // loop starts are NOT dropped. The startId config option controls which.
  // We assert: replay callers MUST NOT pass '$' — enforced at the config layer.
  const startIdValue = config.startId ?? '$';
  let lastId = startIdValue;

  // ---------------------------------------------------------------------------
  // Input-side drain barrier — ticksConsumed(lastXaddId) implementation
  // ---------------------------------------------------------------------------
  //
  // Mirrors the output-side barrier in PositionMonitor (pendingBarriers).
  // When the poll loop advances lastId, it calls resolveTickBarriers() to
  // resolve any waiting promises whose target ID is now <= lastId.
  //
  // WHY Map<string, Array<() => void>>?
  // Same reasoning as PositionMonitor.pendingBarriers — multiple callers could
  // await different IDs simultaneously (though in practice the driver awaits
  // one at a time). The array handles multiple callers at the same ID.
  const pendingTickBarriers = new Map<string, Array<() => void>>();

  /**
   * Internal: resolve any tick barriers whose target <= currentId.
   * Called by the poll loop after advancing lastId.
   */
  function resolveTickBarriers(currentId: string): void {
    for (const [targetId, resolvers] of pendingTickBarriers) {
      // Lexicographic comparison is correct for Redis stream IDs (ms-part is
      // fixed-width 13 digits for dates in the range 2001-2286).
      if (currentId >= targetId) {
        for (const resolve of resolvers) {
          resolve();
        }
        pendingTickBarriers.delete(targetId);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Tick processing
  // ---------------------------------------------------------------------------

  /**
   * Parse a raw JSON `data` field from a stream entry into a BrokerTick.
   * Returns null and logs a warning on malformed input.
   */
  function parseTick(raw: string): BrokerTick | null {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('symbol' in parsed) ||
        !('ltp' in parsed)
      ) {
        console.warn('[straddle-calc] malformed tick (missing required fields):', raw);
        return null;
      }
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.symbol !== 'string' || typeof obj.ltp !== 'number') {
        console.warn('[straddle-calc] malformed tick (wrong field types):', raw);
        return null;
      }
      // Accept either `timestamp` (payment branch) or `time` (milestones-0-1 branch)
      const timestamp =
        typeof obj.timestamp === 'number'
          ? obj.timestamp
          : typeof obj.time === 'number'
            ? obj.time
            : (clock.timestamp?.() ?? clock.now());

      const tick: BrokerTick = {
        symbol: obj.symbol,
        ltp: obj.ltp,
        timestamp,
        time: timestamp,
      };
      if (typeof obj.volume === 'number') tick.volume = obj.volume;
      if (typeof obj.oi === 'number') tick.oi = obj.oi;
      if (typeof obj.bid === 'number') tick.bid = obj.bid;
      if (typeof obj.ask === 'number') tick.ask = obj.ask;
      return tick;
    } catch {
      console.warn('[straddle-calc] failed to parse tick JSON:', raw);
      return null;
    }
  }

  /**
   * Update the in-memory price map for a single tick.
   */
  function processTick(tick: BrokerTick): void {
    const ts = tick.timestamp ?? tick.time ?? clock.timestamp?.() ?? clock.now();
    priceMap.set(tick.symbol, { price: tick.ltp, timestamp: ts });
  }

  // ---------------------------------------------------------------------------
  // Snapshot logic
  // ---------------------------------------------------------------------------

  /**
   * Core snapshot compute-and-publish.
   *
   * Returns the Redis stream ID assigned by XADD when a snapshot was published,
   * or null when the snapshot was skipped (missing prices).
   *
   * This function is the single implementation used by BOTH paths:
   *   - Live path: called by setInterval via takeSnapshotFireAndForget() which
   *     wraps this in `void` so the live path is unchanged.
   *   - Replay path: snapshotStep() calls this and AWAITS it, guaranteeing that
   *     the xadd completes before the driver advances the clock.
   *
   * WHY return the stream ID?
   * The replay driver passes it to positionMonitor.processedThrough(streamId)
   * so the drain barrier knows exactly which snapshot to wait for. Without the
   * ID, the barrier would have no concrete observable to key on.
   */
  async function computeAndPublishSnapshot(): Promise<string | null> {
    // Resolve the current ATM strike from the latest underlying price.
    // resolveCurrentExpiry() returns the calendar-correct expiry (injected at
    // construction) and triggers an async refresh on week rollover. Falls back
    // to the Thursday formula only when no calendar expiry was injected.
    const expiry = resolveCurrentExpiry();
    const underlyingSymbol =
      underlying === 'NIFTY'
        ? 'NSE:NIFTY50-INDEX'
        : underlying === 'BANKNIFTY'
          ? 'NSE:NIFTYBANK-INDEX'
          : 'BSE:SENSEX-INDEX';

    const underlyingEntry = priceMap.get(underlyingSymbol);
    if (!underlyingEntry) {
      console.debug(
        `[straddle-calc] skipping snapshot — no underlying price for ${underlyingSymbol}`,
      );
      return null;
    }

    const atmStrike = getAtmStrike(underlying, underlyingEntry.price);
    const ceSymbol = buildOptionSymbol(underlying, expiry, atmStrike, 'CE');
    const peSymbol = buildOptionSymbol(underlying, expiry, atmStrike, 'PE');

    const ceEntry = priceMap.get(ceSymbol);
    const peEntry = priceMap.get(peSymbol);

    if (!ceEntry || !peEntry) {
      console.debug(
        `[straddle-calc] skipping snapshot — missing CE (${ceSymbol}) or PE (${peSymbol}) price`,
      );
      return null;
    }

    const cePrice = ceEntry.price;
    const pePrice = peEntry.price;
    const straddleValue = cePrice + pePrice;

    // Push to rolling buffer, capped at rocWindowSize.
    straddleBuffer.push(straddleValue);
    if (straddleBuffer.length > rocWindowSize) {
      straddleBuffer.shift();
    }

    const roc = computeRoc(straddleBuffer);
    const acceleration = computeAcceleration(straddleBuffer);

    snapshotCount += 1;

    const snapshot: StraddleSnapshot = {
      underlying,
      timestamp: clock.timestamp?.() ?? clock.now(),
      atmStrike,
      cePrice,
      pePrice,
      straddleValue,
      roc,
      acceleration,
      snapshotCount,
    };

    latestSnapshot = snapshot;

    // Publish to Redis stream `straddle.values` and return the assigned stream ID.
    // The returned ID is used by the replay drain barrier in position-monitor.
    // MAXLEN ~10000: approximate trim (O(1) amortised) caps the stream at ~10k
    // entries so it never grows unbounded in long-running sessions.
    try {
      const streamId = await redisClient.xadd(
        'straddle.values',
        'MAXLEN',
        '~',
        '10000',
        '*',
        'data',
        JSON.stringify(snapshot),
      );
      // ioredis xadd with '*' always returns a non-null string per Redis spec.
      // Guard anyway so the return type is correct at runtime.
      return streamId ?? null;
    } catch (err) {
      console.error('[straddle-calc] failed to publish snapshot to Redis:', err);
      return null;
    }
  }

  /**
   * Live-path wrapper: fire-and-forget wrapper around computeAndPublishSnapshot.
   *
   * Called by setInterval in live mode. The `void` discards the Promise so the
   * interval callback stays synchronous — unchanged live behaviour.
   * This function is NEVER called from the replay path.
   */
  function takeSnapshotFireAndForget(): void {
    void computeAndPublishSnapshot();
  }

  // ---------------------------------------------------------------------------
  // Poll loop
  // ---------------------------------------------------------------------------

  /**
   * Non-blocking XREAD poll loop.
   *
   * Reads up to 100 entries per iteration.  When no new entries arrive, sleeps
   * 100 ms before retrying to avoid a tight CPU spin.  The `running` flag is
   * checked before every iteration so stop() terminates the loop cleanly.
   *
   * Error handling: any exception from XREAD is caught and logged; the loop
   * continues.  This matches the resilience contract stated in the task spec:
   * "never throw from the polling loop".
   */
  async function pollLoop(): Promise<void> {
    while (running) {
      try {
        // XREAD COUNT 100 STREAMS market.ticks <lastId>
        // Returns null when no new entries are available.
        const results = await redisClient.xread('COUNT', 100, 'STREAMS', 'market.ticks', lastId);

        if (!results || results.length === 0) {
          // No new data — sleep briefly to avoid spinning at 100% CPU.
          await sleep(100);
          continue;
        }

        // results shape: [ [ 'streamName', [ [ 'id', ['field', 'value', ...] ] ] ] ]
        const streamResult = results[0];
        if (!streamResult) {
          await sleep(100);
          continue;
        }

        // Cast to the known ioredis shape for XREAD.
        const entries = streamResult[1] as [string, string[]][];
        for (const entry of entries) {
          const id = entry[0];
          const rawFields = entry[1];
          if (!id || !rawFields) continue;

          // Advance cursor so we never re-read processed messages.
          lastId = id;

          // Extract the `data` field containing the serialized BrokerTick.
          let rawData: string | undefined;
          for (let i = 0; i + 1 < rawFields.length; i += 2) {
            if (rawFields[i] === 'data') {
              rawData = rawFields[i + 1];
              break;
            }
          }

          if (rawData === undefined) {
            console.warn('[straddle-calc] stream entry missing `data` field, id:', id);
            continue;
          }

          const tick = parseTick(rawData);
          if (tick !== null) {
            processTick(tick);
          }

          // Resolve any input-side barriers whose target ID is now <= lastId.
          // This is called per-entry (not per-batch) to resolve barriers as early
          // as possible: if only 3 of 100 entries were published in a step, the
          // driver's barrier resolves after entry 3, not after all 100.
          resolveTickBarriers(lastId);
        }
      } catch (err) {
        // Log but continue — transient Redis hiccups should not crash the loop.
        console.error('[straddle-calc] error in poll loop:', err);
        await sleep(100);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;

      // Start the polling loop (runs until stop() is called).
      // We do not await it — it runs concurrently with the snapshot interval.
      void pollLoop();

      // Schedule periodic snapshots using fire-and-forget — live behaviour unchanged.
      // In replay mode (noInterval=true), the setInterval is skipped entirely;
      // cadence is driven by snapshotStep() calls instead. This prevents the
      // interval from firing extra void snapshots during replay (which would corrupt
      // the deterministic snapshot count when fake timers advance).
      if (!config.noInterval) {
        snapshotInterval = setInterval(takeSnapshotFireAndForget, snapshotIntervalMs);
      }
    },

    async stop(): Promise<void> {
      running = false;

      if (snapshotInterval !== null) {
        clearInterval(snapshotInterval);
        snapshotInterval = null;
      }

      // Drain any pending input-side barriers so callers do not hang forever.
      // If the poll loop exits (running=false) while a driver is still awaiting
      // ticksConsumed(), that promise would never resolve without this drain.
      // We resolve (not reject) so the driver can proceed cleanly to shutdown
      // rather than catching an error it has no way to handle.
      for (const resolvers of pendingTickBarriers.values()) {
        for (const resolve of resolvers) {
          resolve();
        }
      }
      pendingTickBarriers.clear();
    },

    getLatestSnapshot(): StraddleSnapshot | null {
      return latestSnapshot;
    },

    /**
     * Replay-path awaitable snapshot hook.
     *
     * Runs the same compute-and-publish logic as the live path but returns the
     * Redis stream ID so the driver can pass it to the drain barrier.
     * The caller MUST await this call — it resolves ONLY after the XADD completes.
     *
     * ZERO floating promises: computeAndPublishSnapshot is fully awaited here.
     * The live path's void wrapper (takeSnapshotFireAndForget) is NEVER called
     * from replay — this method is the only entry point in the replay path.
     */
    snapshotStep(): Promise<string | null> {
      return computeAndPublishSnapshot();
    },

    /**
     * Input-side drain barrier — resolves when the poll loop cursor has advanced
     * past (or to) the given market.ticks stream ID.
     *
     * Used by the replay driver to guarantee that all ticks published in one step
     * are in the price map BEFORE snapshotStep() fires. Replacing the previous
     * 10-microtask-yield heuristic which was only reliable against a synchronous
     * in-memory fake Redis and could silently produce wrong snapshots under real
     * Redis latency.
     *
     * Resolves immediately if the poll loop has already advanced past lastXaddId.
     */
    ticksConsumed(lastXaddId: string): Promise<void> {
      // Fast path: the poll loop has already consumed past this ID.
      if (lastId >= lastXaddId) {
        return Promise.resolve();
      }

      // Slow path: register a deferred resolve under this target ID.
      // resolveTickBarriers() will fire it when the poll loop advances past lastXaddId.
      return new Promise<void>((resolve) => {
        const existing = pendingTickBarriers.get(lastXaddId);
        if (existing !== undefined) {
          existing.push(resolve);
        } else {
          pendingTickBarriers.set(lastXaddId, [resolve]);
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Internal sleep helper
// ---------------------------------------------------------------------------

/**
 * Promise-based sleep.  Used in the poll loop to avoid a tight CPU spin when
 * no new messages are available in the Redis stream.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
