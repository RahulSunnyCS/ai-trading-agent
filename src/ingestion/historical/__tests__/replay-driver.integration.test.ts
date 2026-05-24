/**
 * Integration tests for the ReplayDriver — C2 coverage gap.
 *
 * @integration — requires Docker services (PostgreSQL + Redis)
 *
 * Run with: bun run test:integration
 * Requires: docker compose up -d (TimescaleDB + Redis)
 *
 * What is tested:
 *   C2. ticksConsumed() input-side barrier guarantees the price map is populated
 *       before each snapshotStep() fires under REAL Redis latency. The previous
 *       10-microtask-yield heuristic (await Promise.resolve() × 10) only worked
 *       against a synchronous in-memory fake Redis. Under real Redis, the barrier
 *       must be a concrete, named observable that resolves only after the poll
 *       loop's XREAD cursor has advanced past the last published tick ID.
 *
 *   C2a. The produced snapshot ledger is deterministic across repeated runs:
 *        running the same replay twice against the same Redis state produces the
 *        same sequence of snapshotCount, straddleValue, and snapshotStepsPublished.
 *
 * Design decisions:
 *   - We use REAL Redis (createTestRedis) so that real network latency applies
 *     between the XADD and the StraddleCalculator's XREAD poll.
 *   - We use a stub PositionMonitor that resolves processedThrough() immediately
 *     so the driver can complete without a real DB connection. The C2 coverage
 *     target is the ticksConsumed barrier, not the drain barrier.
 *   - We use REAL StraddleCalculator with startId='0' and noInterval=true.
 *   - We use a minimal HistoricalFeed shim (not createHistoricalFeed) to avoid
 *     needing a PostgreSQL pool with test data. The feed emits synthetic ticks
 *     whose symbols and ltps are chosen so the StraddleCalculator can compute a
 *     snapshot — one index tick + one CE tick + one PE tick.
 *   - The VirtualClock starts at a known Thursday-market-hours timestamp so
 *     getCurrentExpiry() resolves to a known expiry date and buildOptionSymbol()
 *     produces the symbols we inject into the feed.
 *   - Tests are skipped when REDIS_URL is absent (no Docker) via describe.skipIf.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Redis } from 'ioredis';
import { cleanTestRedis, createTestRedis } from '../../../test/integration/helpers.js';
import type { PositionMonitor } from '../../../trading/position-monitor.js';
import { VirtualClock } from '../../../utils/clock.js';
import {
  buildOptionSymbol,
  getAtmStrike,
  getCurrentExpiry,
} from '../../brokers/instrument-registry.js';
import type { BrokerTick } from '../../brokers/types.js';
import { createStraddleCalculator } from '../../straddle-calc.js';
import type { StraddleCalculator } from '../../straddle-calc.js';
import type { HistoricalFeed } from '../historical-feed.js';
import { createReplayDriver } from '../replay-driver.js';

// ---------------------------------------------------------------------------
// Skip guard — skip the entire suite when REDIS_URL is absent (Docker down)
// ---------------------------------------------------------------------------

const SKIP = !process.env.REDIS_URL;

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

/**
 * A Thursday during NSE market hours (IST 09:30 = UTC 04:00).
 * getCurrentExpiry() for a Thursday before 15:30 IST returns the same day.
 * Using 2024-01-25 (Thursday) so the expiry date and all derived symbols
 * are deterministic regardless of the test runner's wall-clock time.
 */
const REPLAY_START_MS = new Date('2024-01-25T04:00:00.000Z').getTime();

/**
 * NIFTY spot price → ATM strike = 22400 (50-pt intervals).
 */
const NIFTY_SPOT = 22400;

/**
 * CE and PE prices chosen so the straddle value is a round number (300).
 */
const CE_PRICE = 155;
const PE_PRICE = 145;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal HistoricalFeed shim that emits a fixed sequence of ticks
 * without needing a PostgreSQL connection.
 *
 * Emits three ticks at timestamp REPLAY_START_MS:
 *   1. NIFTY50-INDEX at NIFTY_SPOT (to populate the underlying price map entry)
 *   2. CE symbol at CE_PRICE
 *   3. PE symbol at PE_PRICE
 *
 * This is the minimal tick set required for StraddleCalculator.snapshotStep()
 * to produce a non-null snapshot (all three prices must be in the price map).
 */
function buildMinimalFeed(clock: VirtualClock, tickCount = 1): HistoricalFeed {
  // Derive the symbols the StraddleCalculator will look up from the price map.
  // These must match exactly what computeAndPublishSnapshot() builds internally.
  const expiry = getCurrentExpiry('NIFTY', clock);
  const atmStrike = getAtmStrike('NIFTY', NIFTY_SPOT);
  const ceSymbol = buildOptionSymbol('NIFTY', expiry, atmStrike, 'CE');
  const peSymbol = buildOptionSymbol('NIFTY', expiry, atmStrike, 'PE');

  // All ticks are tagged at REPLAY_START_MS so they fall within the first
  // emitUpTo(REPLAY_START_MS) call in the driver loop.
  const ticks: BrokerTick[] = [];
  for (let i = 0; i < tickCount; i++) {
    // Stagger by 1 ms to give each tick a unique timestamp (required for
    // Redis XADD '*' auto-ID ordering to match emit order).
    const ts = REPLAY_START_MS + i;
    ticks.push({ symbol: 'NSE:NIFTY50-INDEX', ltp: NIFTY_SPOT, timestamp: ts, time: ts });
    ticks.push({ symbol: ceSymbol, ltp: CE_PRICE, timestamp: ts, time: ts });
    ticks.push({ symbol: peSymbol, ltp: PE_PRICE, timestamp: ts, time: ts });
  }

  const callbacks: Array<(tick: BrokerTick) => void> = [];
  let emitIndex = 0;
  let loaded = false;

  return {
    async connect(): Promise<void> {},
    subscribe(_symbols: string[]): void {},
    async disconnect(): Promise<void> {},
    onTick(cb: (tick: BrokerTick) => void): void {
      callbacks.push(cb);
    },
    onDisconnect(_cb: (reason: string) => void): void {},

    async load(): Promise<number> {
      loaded = true;
      return ticks.length;
    },

    emitUpTo(virtualNowMs: number): number {
      if (!loaded) throw new Error('[test feed] call load() before emitUpTo()');
      let emitted = 0;
      while (emitIndex < ticks.length) {
        const tick = ticks[emitIndex];
        if (!tick || (tick.time ?? tick.timestamp ?? 0) > virtualNowMs) break;
        for (const cb of callbacks) cb(tick);
        emitIndex++;
        emitted++;
      }
      return emitted;
    },

    done(): boolean {
      return loaded && emitIndex >= ticks.length;
    },
  };
}

/**
 * Build a stub PositionMonitor that resolves processedThrough() immediately
 * so we can test the ticksConsumed barrier in isolation.
 */
function buildStubPositionMonitor(): PositionMonitor {
  return {
    async start(): Promise<void> {},
    async stop(): Promise<void> {},
    async processedThrough(_streamId: string): Promise<void> {},
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('replay-driver real-Redis integration', () => {
  let redis: Redis;

  beforeAll(async () => {
    redis = createTestRedis();
    // Ensure the client is connected before any test runs by issuing a PING.
    await redis.ping();
  }, 15_000);

  afterAll(async () => {
    await redis.quit();
  });

  afterEach(async () => {
    // Flush all keys between tests to prevent stale stream entries from
    // leaking into the next test's XREAD cursor window.
    await cleanTestRedis(redis);
  });

  // ── C2: ticksConsumed barrier populates the price map before snapshotStep ──

  it('ticksConsumed barrier ensures the price map is populated before snapshotStep fires under real Redis latency', async () => {
    // This test exercises the exact scenario that the microtask-yield heuristic
    // could not guarantee: under real Redis network latency, XADD returns a
    // stream ID before the StraddleCalculator's XREAD poll loop has read the
    // entry. Without ticksConsumed(), snapshotStep() would fire against a stale
    // price map and return null (no snapshot), making snapshotStepsPublished=0.
    // With ticksConsumed(), the driver waits until the poll loop has consumed
    // the tick, so the price map is populated and snapshotStep() produces a
    // non-null snapshot.

    const clock = new VirtualClock(REPLAY_START_MS);
    const feed = buildMinimalFeed(clock);
    const positionMonitor = buildStubPositionMonitor();

    // StraddleCalculator with startId='0' (replay mode) and noInterval=true.
    const straddleCalc: StraddleCalculator = createStraddleCalculator(redis, {
      underlying: 'NIFTY',
      startId: '0',
      noInterval: true,
      clock,
    });

    await straddleCalc.start();
    await positionMonitor.start();
    await feed.load();

    const driver = createReplayDriver(feed, redis, straddleCalc, positionMonitor, clock, {
      snapshotIntervalMs: 15_000,
    });

    let summary;
    try {
      summary = await driver.run();
    } finally {
      await straddleCalc.stop();
      await positionMonitor.stop();
    }

    // The feed emits 3 ticks (index + CE + PE). ticksConsumed must have
    // waited for all three to reach the price map before snapshotStep fired.
    expect(summary.ticksEmitted).toBe(3);

    // With the price map populated, snapshotStep() must produce a non-null
    // result and publish to straddle.values. If ticksConsumed had not worked,
    // this would be 0 (snapshot skipped due to missing prices).
    expect(summary.snapshotStepsPublished).toBeGreaterThanOrEqual(1);
    expect(summary.snapshotStepsAttempted).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it('ticksConsumed resolves fast when the poll loop has already advanced past the target ID', async () => {
    // Publish one tick directly to the stream BEFORE starting the calculator.
    // When the calculator starts and its poll loop runs the first XREAD, it
    // will consume this tick and advance lastId past the target.
    // Then ticksConsumed(target) should resolve immediately (fast path).

    const entryId = await redis.xadd(
      'market.ticks',
      '*',
      'data',
      JSON.stringify({
        symbol: 'NSE:NIFTY50-INDEX',
        ltp: NIFTY_SPOT,
        timestamp: REPLAY_START_MS,
        time: REPLAY_START_MS,
      }),
    );

    expect(typeof entryId).toBe('string');
    expect(entryId).not.toBeNull();

    const clock = new VirtualClock(REPLAY_START_MS);
    const straddleCalc = createStraddleCalculator(redis, {
      underlying: 'NIFTY',
      startId: '0',
      noInterval: true,
      clock,
    });

    await straddleCalc.start();

    // Wait for the poll loop to consume the pre-published tick. We do this by
    // awaiting ticksConsumed with a timeout. If the barrier resolves, we know
    // the poll loop has advanced past entryId.
    await straddleCalc.ticksConsumed(entryId as string);

    // The fast path must have fired: if we get here without hanging, the barrier
    // resolved. The latestSnapshot is null (only index tick, no CE/PE), which is
    // expected — we are testing the barrier mechanic, not snapshot correctness.
    expect(straddleCalc.getLatestSnapshot()).toBeNull();

    await straddleCalc.stop();
  }, 15_000);

  // ── C2a: Determinism across repeated runs ──────────────────────────────────

  it('snapshot ledger is deterministic across two consecutive replay runs', async () => {
    // Run the driver twice over the same Redis state (flushed between runs via
    // afterEach). Compare the snapshotStepsPublished and the latest snapshot
    // straddleValue across both runs.

    async function singleRun(): Promise<{
      snapshotStepsPublished: number;
      straddleValue: number | null;
    }> {
      // Flush Redis so each run starts from a clean stream.
      await cleanTestRedis(redis);

      const clock = new VirtualClock(REPLAY_START_MS);
      const feed = buildMinimalFeed(clock);
      const positionMonitor = buildStubPositionMonitor();
      const straddleCalc = createStraddleCalculator(redis, {
        underlying: 'NIFTY',
        startId: '0',
        noInterval: true,
        clock,
      });

      await straddleCalc.start();
      await positionMonitor.start();
      await feed.load();

      const driver = createReplayDriver(feed, redis, straddleCalc, positionMonitor, clock, {
        snapshotIntervalMs: 15_000,
      });

      let summary;
      try {
        summary = await driver.run();
      } finally {
        await straddleCalc.stop();
        await positionMonitor.stop();
      }

      return {
        snapshotStepsPublished: summary.snapshotStepsPublished,
        straddleValue: straddleCalc.getLatestSnapshot()?.straddleValue ?? null,
      };
    }

    const run1 = await singleRun();
    const run2 = await singleRun();

    // Both runs must produce the same number of published snapshots.
    expect(run1.snapshotStepsPublished).toBe(run2.snapshotStepsPublished);
    // Both runs must produce the same straddle value.
    expect(run1.straddleValue).toBe(run2.straddleValue);
    // The straddle value must match the input (CE_PRICE + PE_PRICE = 300).
    expect(run1.straddleValue).toBeCloseTo(CE_PRICE + PE_PRICE, 5);
  }, 40_000);

  it('driver completes with zero published snapshots when no CE or PE ticks are present', async () => {
    // Edge case: the feed only emits the index tick — no option ticks.
    // The StraddleCalculator cannot compute a snapshot (price map incomplete).
    // The driver must complete cleanly (no hang) and report 0 snapshots published.

    const clock = new VirtualClock(REPLAY_START_MS);
    const positionMonitor = buildStubPositionMonitor();

    // Feed with only one index tick — no CE, no PE.
    const singleIndexTick: BrokerTick = {
      symbol: 'NSE:NIFTY50-INDEX',
      ltp: NIFTY_SPOT,
      timestamp: REPLAY_START_MS,
      time: REPLAY_START_MS,
    };

    const callbacks: Array<(tick: BrokerTick) => void> = [];
    let emitIndex = 0;
    let loaded = false;
    const ticks = [singleIndexTick];

    const minimalFeed: HistoricalFeed = {
      async connect(): Promise<void> {},
      subscribe(_symbols: string[]): void {},
      async disconnect(): Promise<void> {},
      onTick(cb: (tick: BrokerTick) => void): void {
        callbacks.push(cb);
      },
      onDisconnect(_cb: (reason: string) => void): void {},
      async load(): Promise<number> {
        loaded = true;
        return ticks.length;
      },
      emitUpTo(virtualNowMs: number): number {
        if (!loaded) throw new Error('[test feed] call load() before emitUpTo()');
        let emitted = 0;
        while (emitIndex < ticks.length) {
          const tick = ticks[emitIndex];
          if (!tick || (tick.time ?? tick.timestamp ?? 0) > virtualNowMs) break;
          for (const cb of callbacks) cb(tick);
          emitIndex++;
          emitted++;
        }
        return emitted;
      },
      done(): boolean {
        return loaded && emitIndex >= ticks.length;
      },
    };

    const straddleCalc = createStraddleCalculator(redis, {
      underlying: 'NIFTY',
      startId: '0',
      noInterval: true,
      clock,
    });

    await straddleCalc.start();
    await positionMonitor.start();
    await minimalFeed.load();

    const driver = createReplayDriver(minimalFeed, redis, straddleCalc, positionMonitor, clock, {
      snapshotIntervalMs: 15_000,
    });

    let summary;
    try {
      summary = await driver.run();
    } finally {
      await straddleCalc.stop();
      await positionMonitor.stop();
    }

    expect(summary.ticksEmitted).toBe(1);
    // No CE or PE → price map incomplete → snapshotStep returns null.
    expect(summary.snapshotStepsPublished).toBe(0);
    // snapshotStep was still attempted (the driver always attempts one step
    // after the last emitUpTo, even if it produces nothing).
    expect(summary.snapshotStepsAttempted).toBeGreaterThanOrEqual(1);
  }, 20_000);

  it('ticksConsumed(lastXaddId) resolves and the price map holds all published tick values', async () => {
    // Publish multiple ticks and verify that after ticksConsumed resolves,
    // the StraddleCalculator's price map reflects the last known price for each
    // symbol. We verify this by calling snapshotStep() after ticksConsumed()
    // and asserting the snapshot reflects the prices we published.

    const clock = new VirtualClock(REPLAY_START_MS);
    const expiry = getCurrentExpiry('NIFTY', clock);
    const atmStrike = getAtmStrike('NIFTY', NIFTY_SPOT);
    const ceSymbol = buildOptionSymbol('NIFTY', expiry, atmStrike, 'CE');
    const peSymbol = buildOptionSymbol('NIFTY', expiry, atmStrike, 'PE');

    const straddleCalc = createStraddleCalculator(redis, {
      underlying: 'NIFTY',
      startId: '0',
      noInterval: true,
      clock,
    });

    await straddleCalc.start();

    // Publish all three required ticks and capture the last ID.
    const ts = REPLAY_START_MS;
    await redis.xadd(
      'market.ticks',
      '*',
      'data',
      JSON.stringify({ symbol: 'NSE:NIFTY50-INDEX', ltp: NIFTY_SPOT, timestamp: ts, time: ts }),
    );
    await redis.xadd(
      'market.ticks',
      '*',
      'data',
      JSON.stringify({ symbol: ceSymbol, ltp: CE_PRICE, timestamp: ts, time: ts }),
    );
    const lastId = await redis.xadd(
      'market.ticks',
      '*',
      'data',
      JSON.stringify({ symbol: peSymbol, ltp: PE_PRICE, timestamp: ts, time: ts }),
    );

    expect(lastId).not.toBeNull();

    // Wait until the poll loop has consumed all three ticks.
    await straddleCalc.ticksConsumed(lastId as string);

    // Now snapshotStep() MUST produce a non-null snapshot because all three
    // prices are in the price map (the barrier guarantees it).
    const streamId = await straddleCalc.snapshotStep();

    expect(streamId).not.toBeNull();
    const snapshot = straddleCalc.getLatestSnapshot();
    expect(snapshot).not.toBeNull();
    expect(snapshot?.straddleValue).toBeCloseTo(CE_PRICE + PE_PRICE, 5);
    expect(snapshot?.cePrice).toBeCloseTo(CE_PRICE, 5);
    expect(snapshot?.pePrice).toBeCloseTo(PE_PRICE, 5);

    await straddleCalc.stop();
  }, 20_000);
});
