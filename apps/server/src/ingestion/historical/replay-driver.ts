/**
 * ReplayDriver — deterministic replay orchestrator for backtesting
 *
 * Wires the historical feed through the SAME live pipeline:
 *   HistoricalFeed.emitUpTo(t)
 *     → feed.onTick callbacks
 *       → redis.xadd('market.ticks', ...)
 *         → StraddleCalculator poll loop (startId='0')
 *           → await straddleCalc.snapshotStep()  ← awaitable, not fire-and-forget
 *             → redis.xadd('straddle.values', streamId)
 *               → PositionMonitor poll loop (startId='0')
 *                 → await positionMonitor.processedThrough(streamId)  ← drain barrier
 *                   → clock.advance(snapshotIntervalMs)  ← clock advances LAST
 *
 * Determinism guarantees:
 *   1. VirtualClock.tick() drives cadence — no wall-clock setInterval in replay.
 *   2. All awaits are concrete and observable (snapshotStep + processedThrough).
 *   3. ZERO floating promises in the driver loop (no bare `void`).
 *   4. '$' cursors are forbidden — both consumers start at '0'.
 *   5. feed.emitUpTo() is called BEFORE snapshotStep() at each interval, so
 *      ticks at time T are in the price map before the snapshot at T fires.
 *   6. clock.advance() is called AFTER processedThrough() resolves, so positions
 *      are evaluated at the correct virtual time.
 *
 * The driver does NOT start/stop the StraddleCalculator or PositionMonitor
 * setInterval/poll loops — the caller starts them before calling run() and
 * stops them after run() returns. This keeps the driver free of lifecycle
 * management concerns.
 *
 * Security: no user-supplied values are passed to SQL; all DB access is via
 * the HistoricalFeed which uses parameterised queries.
 */

import type { Redis } from 'ioredis';

import type { PositionMonitorInterface } from '../../trading/position-monitor';
import type { VirtualClock } from '../../utils/clock';
import type { BrokerTick } from '../brokers/types';
import type { StraddleCalculator } from '../straddle-calc';
import type { HistoricalFeed } from './historical-feed';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ReplayConfig {
  /**
   * Interval between snapshot cadence steps in milliseconds.
   * Must match the snapshotIntervalMs used to configure StraddleCalculator.
   * Default: 15000 (15 seconds — same as live).
   */
  snapshotIntervalMs?: number;

  /**
   * Speed multiplier for the virtual clock.
   * 1.0 = real-time, 60.0 = 60x faster, etc.
   * This only affects wall-clock time reporting — VirtualClock.advance() does
   * not respect wall time. The multiplier is used solely for log output.
   * Default: 1.0.
   */
  speedMultiplier?: number;

  /**
   * If true, log a debug line for each emitted tick.
   * Default: false (too noisy for large replays).
   */
  verboseTicks?: boolean;
}

/**
 * Summary returned by ReplayDriver.run() after the replay window is exhausted.
 */
export interface ReplaySummary {
  /** Total ticks emitted by the historical feed. */
  ticksEmitted: number;
  /** Number of snapshot steps attempted (interval boundaries crossed). */
  snapshotStepsAttempted: number;
  /** Number of snapshots that produced a stream entry (non-null from snapshotStep). */
  snapshotStepsPublished: number;
  /** Wall-clock milliseconds elapsed during the replay run. */
  wallClockMs: number;
  /** Virtual milliseconds spanned by the replay window. */
  virtualMs: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ReplayDriver.
 *
 * @param feed            HistoricalFeed loaded with the replay window's ticks.
 * @param redis           Redis client — same instance used by the pipeline components.
 * @param straddleCalc    StraddleCalculator with startId='0' and no setInterval running.
 * @param positionMonitor PositionMonitor already start()ed (poll loop running).
 * @param clock           VirtualClock initialised to the replay window's start time.
 * @param config          Optional tuning parameters.
 */
export function createReplayDriver(
  feed: HistoricalFeed,
  redis: Redis,
  straddleCalc: StraddleCalculator,
  positionMonitor: PositionMonitorInterface,
  clock: VirtualClock,
  config?: ReplayConfig,
): { run(): Promise<ReplaySummary> } {
  const snapshotIntervalMs = config?.snapshotIntervalMs ?? 15_000;

  return {
    async run(): Promise<ReplaySummary> {
      const wallStart = Date.now();
      let ticksEmitted = 0;
      let snapshotStepsAttempted = 0;
      let snapshotStepsPublished = 0;

      // Register tick handler: each emitted tick is written to the market.ticks
      // Redis stream. This is the SAME code path as the live pipeline (see src/index.ts).
      //
      // WHY await inside the callback?
      // emitUpTo() is synchronous, but xadd is async. We need to await all xadd
      // calls before calling snapshotStep() to guarantee ticks are in Redis before
      // the snapshot fires. We collect the promises and await them after emitUpTo().
      //
      // ZERO floating promises: we never use `void redis.xadd(...)` in replay.
      // Every xadd is awaited via the xaddPromises array.
      // Typed as Promise<string | null> (ioredis xadd returns string | null).
      // We extract the last non-null ID to use as the input-side barrier target for
      // straddleCalc.ticksConsumed() — proving all published ticks are in the price map.
      const xaddPromises: Array<Promise<string | null>> = [];

      feed.onTick((tick: BrokerTick) => {
        // Serialise the tick exactly as the live pipeline does in src/index.ts.
        // The StraddleCalculator's parseTick() function reads the 'data' field.
        const p = redis.xadd('market.ticks', '*', 'data', JSON.stringify(tick));
        xaddPromises.push(p);
        ticksEmitted++;
      });

      // Replay loop: advance virtual clock one interval at a time.
      // The loop runs until the feed is exhausted (all ticks emitted).
      //
      // Loop invariant at each iteration:
      //   - virtualNow = clock.now() is the current virtual timestamp.
      //   - We emit all ticks up to virtualNow (they are now in Redis).
      //   - We await the snapshot step (computes from current price map, writes to straddle.values).
      //   - We await the drain barrier (position monitor has consumed the snapshot).
      //   - We advance the clock by snapshotIntervalMs.
      //
      // WHY emit-then-snapshot rather than snapshot-then-emit?
      // Ticks at time T must be in the price map before the snapshot at T fires.
      // The snapshot reads the latest price for each symbol at the moment it runs.
      // If we snapshot first, we'd use stale prices from T-1. The live system
      // naturally satisfies this (ticks arrive continuously, snapshot fires at T)
      // so we must mirror it.

      while (!feed.done()) {
        const virtualNow = clock.now();

        // Step 1: emit ticks up to (and including) the current virtual timestamp.
        // xaddPromises accumulates all pending xadd calls from the onTick handler.
        xaddPromises.length = 0; // reset for this interval
        feed.emitUpTo(virtualNow);

        // Step 2: await all xadd calls before snapshotStep so ticks are in Redis.
        // ZERO floating promises: every xadd from this interval is awaited here.
        // Capture the last published stream ID so we can use it as the barrier target.
        let lastPublishedId: string | null = null;
        if (xaddPromises.length > 0) {
          const ids = await Promise.all(xaddPromises);
          // The last non-null resolved ID is the highest in this batch (xadd IDs are
          // monotonically increasing). We search from the end to find the last non-null.
          // A null from xadd would be a Redis error case but we guard defensively.
          for (let i = ids.length - 1; i >= 0; i--) {
            const id = ids[i];
            if (id !== null && id !== undefined) {
              lastPublishedId = id;
              break;
            }
          }
        }

        // Wait until the StraddleCalculator poll loop has consumed all ticks published
        // in this step BEFORE calling snapshotStep(). This replaces the previous
        // 10-microtask-yield heuristic which was only reliable against a synchronous
        // in-memory fake Redis. Under real Redis latency, snapshotStep() could fire
        // against a stale price map and silently corrupt the snapshot — breaking the
        // determinism guarantee that is the whole point of this milestone.
        //
        // ticksConsumed(lastPublishedId) is a named, concrete barrier: it resolves
        // ONLY when the calculator's XREAD cursor has advanced past lastPublishedId,
        // proving all ticks are in the price map. It mirrors the output-side barrier
        // (processedThrough) already used by the PositionMonitor.
        if (lastPublishedId !== null) {
          await straddleCalc.ticksConsumed(lastPublishedId);
        }

        // Step 3: take a deterministic snapshot.
        // snapshotStep() awaits the xadd to straddle.values before resolving.
        // The returned streamId is the concrete handle for the drain barrier.
        snapshotStepsAttempted++;
        const streamId = await straddleCalc.snapshotStep();

        if (streamId !== null) {
          snapshotStepsPublished++;

          // Step 4: await the drain barrier.
          // processedThrough(streamId) resolves only after the position monitor
          // poll loop has consumed and fully processed the snapshot with this ID.
          // This guarantees no snapshot sits un-consumed when we advance the clock.
          await positionMonitor.processedThrough(streamId);
        }

        // Step 5: advance the virtual clock to the next interval.
        // VirtualClock.advance() fires any registered tick() callbacks (e.g. from
        // VixFeed, watchdog) that have registered on this clock. In replay, only
        // the driver itself drives the clock — no setInterval.
        //
        // advance() is called LAST, after both snapshotStep() and processedThrough()
        // have resolved, so all side effects at virtual time T are complete before
        // the clock moves to T+1.
        clock.advance(snapshotIntervalMs);
      }

      const wallClockMs = Date.now() - wallStart;

      return {
        ticksEmitted,
        snapshotStepsAttempted,
        snapshotStepsPublished,
        wallClockMs,
        virtualMs: snapshotStepsAttempted * snapshotIntervalMs,
      };
    },
  };
}
