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
import { computeAcceleration, computeRoc } from './straddle-math';
import type { BrokerTick, Underlying } from './brokers/types';

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
            : clock.timestamp();

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
    const ts = tick.timestamp ?? tick.time ?? clock.timestamp();
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
    const expiry = getCurrentExpiry(underlying, clock);
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
      timestamp: clock.timestamp(),
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
    try {
      const streamId = await redisClient.xadd('straddle.values', '*', 'data', JSON.stringify(snapshot));
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
 * Promise-based sleep.  Used in the poll loop to avoid a tight spin when
 * no new messages are available in the Redis stream.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
