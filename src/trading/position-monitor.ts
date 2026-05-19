/**
 * Position Monitor Loop — T-18
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
            continue;
          }

          const snapshot = parseSnapshot(rawData);
          if (snapshot !== null) {
            // evaluateSnapshot is async; we await it to ensure ordering:
            // each snapshot is fully processed before we move to the next.
            // This prevents two snapshots from racing to close the same trade.
            await evaluateSnapshot(snapshot);
          }
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
