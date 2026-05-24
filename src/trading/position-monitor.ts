/**
 * Position Monitor Loop
 *
 * Subscribes to the `straddle.values` Redis stream and, on each new snapshot,
 * evaluates all open positions for exit conditions.  This is the runtime loop
 * that connects straddle calculator output to the exit engine.
 *
 * Design decisions:
 * - Uses the same non-blocking XREAD pattern as straddle-calc.ts: no BLOCK
 *   argument so the `running` flag is checked on every iteration for clean
 *   shutdown.
 * - In-memory watermark map (tradeId → min straddle value) is lazily
 *   initialised: the first observed straddle value becomes the baseline, not
 *   the entry value.  This prevents stale entry values from distorting the
 *   trailing-stop calculation when the monitor starts mid-session.
 * - Each PaperTradeRecord has a `personalityId` field but position evaluation
 *   is personality-agnostic here — the monitor closes any open trade that
 *   meets an exit condition, regardless of which personality opened it.
 * - Malformed JSON in the stream is silently skipped (logged as a warning) so
 *   a single bad entry does not halt evaluation of subsequent entries.
 */

import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import type { StraddleSnapshot } from '../ingestion/straddle-calc';
import { type Clock, RealClock } from '../utils/clock';
import { exitTrade, getOpenTrades } from './paper-trade';
import { type Position, evaluateExit, updateHighWatermark } from './trigger-exit';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PositionMonitorConfig {
  clock?: Clock;
  /** Default stop-loss as a fraction of entry value (default: 0.20 = 20%). */
  defaultStopLossPct?: number;
  /** Default trailing-stop as a fraction of running minimum (default: 0.15 = 15%). */
  defaultTrailingStopPct?: number;
  /** Default profit-target as a fraction of entry value (default: 0.30 = 30%). */
  defaultTargetPct?: number;
  /** HH:MM in IST for forced end-of-day exit (default: '15:15'). */
  defaultEodExitIST?: string;
}

export interface PositionMonitor {
  start(): Promise<void>;
  stop(): Promise<void>;
  /**
   * NAMED DRAIN BARRIER — resolves when the poll loop has processed the entry
   * with the given Redis stream ID (or any entry with a later ID, which implies
   * the given entry was also processed since XREAD delivers entries in order).
   *
   * WHY this primitive instead of a sleep?
   * Sleeping is not observable — there is no way to assert it in a test without
   * relying on wall-clock time, which is non-deterministic. A concrete Promise
   * keyed on the stream ID is observable: the test (or driver) awaits it, and
   * it resolves when the poll loop's cursor has advanced past the target ID.
   * The comparison is a simple lexicographic comparison of Redis stream IDs,
   * which have the form "<ms>-<seq>" and compare correctly as strings under the
   * same semantics Redis itself uses.
   *
   * WHY at this boundary (before clock.advance)?
   * In the replay driver, after snapshotStep() publishes to straddle.values,
   * the position monitor poll loop must consume that entry BEFORE we advance
   * the virtual clock to the next interval. If we advance first, positions
   * would be evaluated at the wrong clock time, breaking determinism.
   *
   * REPLAY PATH ONLY: in live mode this method is never called. The poll loop
   * always runs and the barrier bookkeeping has negligible overhead.
   *
   * @param streamId  Redis stream ID of the entry to wait for, e.g. "1700000000000-0".
   */
  processedThrough(streamId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal: resolved config with every field present
// ---------------------------------------------------------------------------

interface ResolvedConfig {
  clock: Clock;
  defaultStopLossPct: number;
  defaultTrailingStopPct: number;
  defaultTargetPct: number;
  defaultEodExitIST: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a Position snapshot from a PaperTradeRecord and the current observed
 * straddle value.
 *
 * The config defaults supply thresholds that are not yet persisted per-trade.
 * Phase 2 will switch to per-trade thresholds stored in the DB.
 */
function buildPosition(
  entryStraddleValue: number,
  entryTimestampMs: number,
  currentValue: number,
  watermark: number,
  config: ResolvedConfig,
): Position {
  return {
    entryStraddleValue,
    currentStraddleValue: currentValue,
    entryTimestamp: entryTimestampMs,
    stopLossPct: config.defaultStopLossPct,
    trailingStopPct: config.defaultTrailingStopPct,
    targetPct: config.defaultTargetPct,
    highWatermark: watermark,
    eodExitIST: config.defaultEodExitIST,
  };
}

/**
 * Parse and validate a raw JSON string from the `straddle.values` stream.
 *
 * Returns null and logs a warning for any malformed or type-incorrect input so
 * a single bad entry does not break the evaluation loop.
 */
function parseSnapshot(raw: string): StraddleSnapshot | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('straddleValue' in parsed) ||
      !('timestamp' in parsed) ||
      !('underlying' in parsed)
    ) {
      console.warn('[position-monitor] malformed snapshot (missing required fields):', raw);
      return null;
    }

    const obj = parsed as Record<string, unknown>;

    // Narrow the fields we actually use; other StraddleSnapshot fields are
    // present in the JSON but we only need straddleValue + timestamp here.
    if (typeof obj.straddleValue !== 'number' || typeof obj.timestamp !== 'number') {
      console.warn('[position-monitor] malformed snapshot (wrong field types):', raw);
      return null;
    }

    // Cast to StraddleSnapshot — the remaining fields (cePrice, pePrice, etc.)
    // are trusted from the straddle-calc publisher which owns this schema.
    return parsed as StraddleSnapshot;
  } catch {
    console.warn('[position-monitor] failed to parse snapshot JSON:', raw);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a PositionMonitor that polls the `straddle.values` stream and
 * evaluates all open positions on each new snapshot.
 *
 * The returned object has no side effects until `start()` is called.
 */
export function createPositionMonitor(
  redisClient: Redis,
  db: Pool,
  config?: PositionMonitorConfig,
): PositionMonitor {
  // Resolve config with defaults so downstream code never deals with undefined.
  const resolved: ResolvedConfig = {
    clock: config?.clock ?? new RealClock(),
    defaultStopLossPct: config?.defaultStopLossPct ?? 0.2,
    defaultTrailingStopPct: config?.defaultTrailingStopPct ?? 0.15,
    defaultTargetPct: config?.defaultTargetPct ?? 0.3,
    defaultEodExitIST: config?.defaultEodExitIST ?? '15:15',
  };

  // In-memory high watermark map: tradeId → lowest straddle value seen.
  // Using tradeId (string) as the key because trade IDs are UUIDs from
  // PostgreSQL — globally unique and compared by value equality.
  const watermarks = new Map<string, number>();

  // XREAD cursor for `straddle.values`.
  // Starting at '0' replays from the beginning of the current stream so the
  // monitor catches any snapshots published before it started.  The practical
  // effect is at most a few seconds of history — this is intentional: we want
  // to initialise watermarks from real recent market data rather than a stale
  // entry value that may be hours old.
  let lastId = '0';

  // Running flag — set to false by stop() to terminate the poll loop cleanly.
  let running = false;

  // ---------------------------------------------------------------------------
  // Drain barrier — processedThrough(streamId) implementation
  // ---------------------------------------------------------------------------
  //
  // We store pending barriers as a Map from target stream ID to a list of
  // resolve functions. When the poll loop advances lastId to >= targetId, all
  // pending barriers whose target is <= lastId are resolved.
  //
  // WHY a Map of arrays?
  // Multiple callers could await processedThrough() for different stream IDs
  // simultaneously (though in practice the replay driver only awaits one at a
  // time). The array handles the edge case where two callers await the same ID.
  //
  // WHY lexicographic comparison?
  // Redis stream IDs have the form "<milliseconds>-<sequence>". Lexicographic
  // comparison works correctly when the millisecond parts have the same number
  // of digits (which they always do — epoch ms is always 13 digits for dates
  // in the range 2001–2286). The sequence suffix is zero-padded by Redis.
  // This is the same comparison Redis itself uses in commands like XRANGE.
  const pendingBarriers = new Map<string, Array<() => void>>();

  /**
   * Internal: called by the poll loop after updating lastId.
   * Resolves any barriers whose target ID is <= the current lastId.
   */
  function resolveBarriers(currentId: string): void {
    for (const [targetId, resolvers] of pendingBarriers) {
      // Compare as Redis IDs: lexicographic works because ms-part is fixed-width.
      if (currentId >= targetId) {
        for (const resolve of resolvers) {
          resolve();
        }
        pendingBarriers.delete(targetId);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Core evaluation logic (called on every new snapshot)
  // -------------------------------------------------------------------------

  /**
   * Load all open trades and evaluate each against the current snapshot.
   *
   * Exits are applied immediately (DB write via exitTrade).  The watermark
   * map is updated or cleaned up after each trade is processed.
   *
   * We call getOpenTrades on every snapshot tick rather than caching the list
   * because trades may be opened by other parts of the system between ticks.
   * At 15-second snapshot intervals this DB read is negligible.
   */
  async function evaluateSnapshot(snapshot: StraddleSnapshot): Promise<void> {
    const currentValue = snapshot.straddleValue;

    let openTrades: Awaited<ReturnType<typeof getOpenTrades>>;
    try {
      openTrades = await getOpenTrades(db);
    } catch (err) {
      console.error('[position-monitor] failed to load open trades:', err);
      return;
    }

    for (const trade of openTrades) {
      const tradeId = trade.id;
      const entryValue = Number(trade.entryStraddleValue);

      // Lazily initialise the watermark to the first observed straddle value.
      // Using the current market value (not entryStraddleValue) because the
      // monitor may start mid-session after the trade has already moved from
      // its entry value.  A stale entry value would immediately fire a trailing
      // stop if the market has already moved against us.
      const existingWatermark = watermarks.get(tradeId);
      const watermark = existingWatermark ?? currentValue;
      if (existingWatermark === undefined) {
        watermarks.set(tradeId, watermark);
      }

      const position = buildPosition(
        entryValue,
        trade.entryTimestamp.getTime(),
        currentValue,
        watermark,
        resolved,
      );

      const decision = evaluateExit(position, resolved.clock);

      if (decision.shouldExit) {
        // Remove from watermark map before the async DB write so that if
        // another concurrent snapshot arrives for the same tradeId before the
        // write completes, it will re-initialise the watermark rather than
        // evaluating exit on a trade that is already being closed.
        watermarks.delete(tradeId);

        try {
          await exitTrade(db, {
            tradeId,
            exitStraddleValue: currentValue,
            exitTimestamp: snapshot.timestamp,
            exitReason: decision.reason,
          });
          console.info(`[position-monitor] exited trade ${tradeId} — reason: ${decision.reason}`);
        } catch (err) {
          console.error(`[position-monitor] failed to exit trade ${tradeId}:`, err);
          // Re-insert the watermark so the next tick re-evaluates this trade
          // rather than silently leaving it open with no watermark entry.
          watermarks.set(tradeId, watermark);
        }
      } else {
        // Update the high watermark (running minimum) for the next tick.
        const updated = updateHighWatermark(currentValue, watermark);
        watermarks.set(tradeId, updated);
      }
    }

    // Clean up watermark entries for trades that have already been closed
    // externally (e.g. manually from the API) — they will not appear in
    // openTrades but may still have a stale entry in the map.
    const openIds = new Set(openTrades.map((t) => t.id));
    for (const [id] of watermarks) {
      if (!openIds.has(id)) {
        watermarks.delete(id);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Poll loop
  // -------------------------------------------------------------------------

  /**
   * Non-blocking XREAD poll loop for `straddle.values`.
   *
   * Same pattern as straddle-calc.ts: XREAD without BLOCK so the `running`
   * flag is checked on every iteration and stop() terminates cleanly without
   * waiting for a blocking call to time out.
   */
  async function pollLoop(): Promise<void> {
    while (running) {
      try {
        // XREAD COUNT 100 STREAMS straddle.values <lastId>
        const results = await redisClient.xread('COUNT', 100, 'STREAMS', 'straddle.values', lastId);

        if (!results || results.length === 0) {
          // No new snapshots — sleep briefly to avoid a tight CPU spin.
          await sleep(100);
          continue;
        }

        // results shape: [ [ 'streamName', [ [ 'id', ['field', 'value', ...] ] ] ] ]
        const streamResult = results[0];
        if (!streamResult) {
          await sleep(100);
          continue;
        }

        // Cast to the known ioredis XREAD shape.
        const entries = streamResult[1] as [string, string[]][];

        for (const entry of entries) {
          const entryId = entry[0];
          const rawFields = entry[1];
          if (!entryId || !rawFields) continue;

          // Advance cursor so processed messages are never re-read.
          lastId = entryId;

          // Extract the `data` field containing the serialised StraddleSnapshot.
          let rawData: string | undefined;
          for (let i = 0; i + 1 < rawFields.length; i += 2) {
            if (rawFields[i] === 'data') {
              rawData = rawFields[i + 1];
              break;
            }
          }

          if (rawData === undefined) {
            console.warn('[position-monitor] stream entry missing `data` field, id:', entryId);
            // Advance drain barrier even for skipped entries: we have processed
            // (or rather, skipped) up to this ID, so barriers targeting it can resolve.
            resolveBarriers(lastId);
            continue;
          }

          const snapshot = parseSnapshot(rawData);
          if (snapshot !== null) {
            // evaluateSnapshot is async; we await it to ensure ordering:
            // each snapshot is fully processed before we move to the next.
            // This prevents two snapshots from racing to close the same trade.
            await evaluateSnapshot(snapshot);
          }

          // Resolve any drain barriers keyed on this stream ID AFTER the
          // snapshot is fully processed. This guarantees that processedThrough()
          // callers see the side-effects (DB writes, watermark updates) before
          // their await resolves.
          resolveBarriers(lastId);
        }
      } catch (err) {
        // Log but continue — transient Redis errors should not crash the loop.
        console.error('[position-monitor] error in poll loop:', err);
        await sleep(100);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;
      // Run the poll loop concurrently; do not await here so start() returns
      // immediately and the caller is not blocked.
      void pollLoop();
    },

    async stop(): Promise<void> {
      running = false;
      // The poll loop checks `running` at the top of each iteration and exits
      // naturally.  No forced termination is needed because XREAD is called
      // without BLOCK, so the next iteration check will see running=false.
    },

    processedThrough(streamId: string): Promise<void> {
      // If the poll loop has already advanced past this ID, resolve immediately.
      // This handles the case where the snapshot was consumed before processedThrough()
      // was called — common in unit tests where the poll loop runs ahead.
      if (lastId >= streamId) {
        return Promise.resolve();
      }

      // Otherwise register a deferred resolve under this target ID.
      // The poll loop calls resolveBarriers() after each entry is processed.
      return new Promise<void>((resolve) => {
        const existing = pendingBarriers.get(streamId);
        if (existing !== undefined) {
          existing.push(resolve);
        } else {
          pendingBarriers.set(streamId, [resolve]);
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
