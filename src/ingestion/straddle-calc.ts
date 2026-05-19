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
}

export interface StraddleCalculator {
  /** Begins reading ticks from Redis and scheduling 15-second snapshots. */
  start(): Promise<void>;
  /** Stops the snapshot interval and the polling loop. */
  stop(): Promise<void>;
  /** Returns the last published snapshot, or null if none yet. */
  getLatestSnapshot(): StraddleSnapshot | null;
}

// ---------------------------------------------------------------------------
// Internal type for the price map entries
// ---------------------------------------------------------------------------

interface PriceEntry {
  price: number;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Rolling-buffer helpers (pure, exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Compute ROC from the last two straddle values in the buffer.
 *
 * Returns 0 when:
 *   - fewer than 2 values are present (not enough history), or
 *   - the previous value is 0 (would produce divide-by-zero / Infinity).
 *
 * Formula: (current - previous) / previous * 100
 */
export function computeRoc(buffer: readonly number[]): number {
  if (buffer.length < 2) return 0;
  const prev = buffer[buffer.length - 2];
  const curr = buffer[buffer.length - 1];
  // Both indexes are guaranteed non-undefined because of the length guard above,
  // but TypeScript with noUncheckedIndexedAccess requires explicit checks.
  if (prev === undefined || curr === undefined || prev === 0) return 0;
  return ((curr - prev) / prev) * 100;
}

/**
 * Compute acceleration (second derivative of straddle value) from the rolling
 * buffer by comparing the two most recent ROC values.
 *
 * Returns 0 when fewer than 3 values are in the buffer (need two consecutive
 * ROC intervals to compare).
 */
export function computeAcceleration(buffer: readonly number[]): number {
  if (buffer.length < 3) return 0;

  // ROC between the last three values: [... a, b, c]
  // roc_prev = (b - a) / a * 100
  // roc_curr = (c - b) / b * 100
  const a = buffer[buffer.length - 3];
  const b = buffer[buffer.length - 2];
  const c = buffer[buffer.length - 1];

  if (a === undefined || b === undefined || c === undefined) return 0;
  if (a === 0 || b === 0) return 0;

  const rocPrev = ((b - a) / a) * 100;
  const rocCurr = ((c - b) / b) * 100;
  return rocCurr - rocPrev;
}

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

  // Last XREAD cursor — '$' means "only new messages from now on".
  // We start at '$' so we do not replay the entire stream history on start.
  let lastId = '$';

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
   * Build and publish one snapshot.  Called by setInterval every `snapshotIntervalMs`.
   *
   * Skips the snapshot (with a debug log) if CE or PE price is not yet known —
   * this is normal on startup before the first relevant ticks arrive.
   */
  async function takeSnapshot(): Promise<void> {
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
      return;
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
      return;
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

    // Publish to Redis stream `straddle.values`.
    try {
      await redisClient.xadd('straddle.values', '*', 'data', JSON.stringify(snapshot));
    } catch (err) {
      console.error('[straddle-calc] failed to publish snapshot to Redis:', err);
    }
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

      // Schedule periodic snapshots.
      snapshotInterval = setInterval(() => {
        void takeSnapshot();
      }, snapshotIntervalMs);
    },

    async stop(): Promise<void> {
      running = false;

      if (snapshotInterval !== null) {
        clearInterval(snapshotInterval);
        snapshotInterval = null;
      }
    },

    getLatestSnapshot(): StraddleSnapshot | null {
      return latestSnapshot;
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
