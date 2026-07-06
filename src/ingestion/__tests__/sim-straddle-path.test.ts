/**
 * Tests for the simulator → straddle-calc integration path.
 *
 * Verifies that the MarketDataSimulator (post-epic change) emits synthetic ATM
 * CE and PE option-leg ticks in addition to the NIFTY index tick, and that the
 * StraddleCalculator produces a snapshot with straddleValue = cePrice + pePrice
 * when all three legs are present.
 *
 * Before the epic, the simulator only emitted the index tick. The straddle
 * calculator would then skip the snapshot because the priceMap lacked CE and PE
 * entries. This test confirms the gap is closed.
 *
 * Design:
 *  - No real Redis, no Docker required — a fake Redis stub is used (same
 *    pattern as straddle-calc.test.ts).
 *  - vi.useFakeTimers() controls the simulator's setInterval so ticks are
 *    triggered deterministically without waiting for real time.
 *  - A FixedClock is injected into the simulator and the calculator so that
 *    getCurrentExpiry / buildOptionSymbol produce identical symbol strings in
 *    both components (the ATM symbol match is the mechanism under test).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FixedClock } from '../../utils/clock';
import { buildOptionSymbol, getAtmStrike, getCurrentExpiry } from '../brokers/instrument-registry';
import type { BrokerTick } from '../brokers/types';
import { MarketDataSimulator } from '../market-data-sim';
import { createStraddleCalculator } from '../straddle-calc';
import type { StraddleSnapshot } from '../straddle-calc';

// ---------------------------------------------------------------------------
// Fake Redis — same minimal stub as straddle-calc.test.ts
// ---------------------------------------------------------------------------

function makeXreadResult(
  streamName: string,
  entries: Array<{ id: string; data: string }>,
): [string, [string, string[]][]][] | null {
  if (entries.length === 0) return null;
  const msgs: [string, string[]][] = entries.map(({ id, data }) => [id, ['data', data]]);
  return [[streamName, msgs]];
}

interface FakeRedis {
  xread: ReturnType<typeof vi.fn>;
  xadd: ReturnType<typeof vi.fn>;
}

function makeFakeRedis(): FakeRedis {
  return {
    xread: vi.fn().mockResolvedValue(null),
    xadd: vi.fn().mockResolvedValue('1-0'),
  };
}

// ---------------------------------------------------------------------------
// Simulator emits CE and PE legs — unit-level check (no Redis)
// ---------------------------------------------------------------------------

describe('MarketDataSimulator — synthetic ATM CE/PE emission', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  it('emits exactly 3 ticks per interval: index + CE + PE', async () => {
    // Thursday noon IST: getCurrentExpiry returns this Thursday as the expiry.
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);

    const sim = new MarketDataSimulator({
      startPrice: 22_400,
      intervalMs: 1_000,
      clock,
    });

    const emitted: BrokerTick[] = [];
    sim.onTick((tick) => emitted.push(tick));

    await sim.connect();

    // Advance fake timers by exactly one interval to fire one batch of ticks.
    vi.advanceTimersByTime(1_000);
    // Allow the setInterval callback to run via microtask flush.
    await Promise.resolve();

    await sim.disconnect();

    // One interval must have produced exactly 3 ticks: index + CE + PE.
    expect(emitted.length).toBe(3);
  });

  it('emits the index tick first (symbol NSE:NIFTY50-INDEX)', async () => {
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);

    const sim = new MarketDataSimulator({ startPrice: 22_400, intervalMs: 1_000, clock });
    const emitted: BrokerTick[] = [];
    sim.onTick((tick) => emitted.push(tick));

    await sim.connect();
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    await sim.disconnect();

    expect(emitted[0]?.symbol).toBe('NSE:NIFTY50-INDEX');
    expect(emitted[0]?.isIndex).toBe(true);
  });

  it('emits a CE tick with optionType CE and strike matching ATM', async () => {
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);
    const startPrice = 22_400;

    const sim = new MarketDataSimulator({ startPrice, intervalMs: 1_000, clock });
    const emitted: BrokerTick[] = [];
    sim.onTick((tick) => emitted.push(tick));

    await sim.connect();
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    await sim.disconnect();

    const ceTick = emitted.find((t) => t.optionType === 'CE');
    expect(ceTick).toBeDefined();
    expect(ceTick?.isIndex).toBe(false);
    // ATM for 22400 with 50pt interval → 22400
    const expectedAtm = getAtmStrike('NIFTY', startPrice);
    expect(ceTick?.strike).toBe(expectedAtm);
    expect(typeof ceTick?.ltp).toBe('number');
    expect(ceTick?.ltp ?? 0).toBeGreaterThan(0);
  });

  it('emits a PE tick with optionType PE and strike matching ATM', async () => {
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);
    const startPrice = 22_400;

    const sim = new MarketDataSimulator({ startPrice, intervalMs: 1_000, clock });
    const emitted: BrokerTick[] = [];
    sim.onTick((tick) => emitted.push(tick));

    await sim.connect();
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    await sim.disconnect();

    const peTick = emitted.find((t) => t.optionType === 'PE');
    expect(peTick).toBeDefined();
    expect(peTick?.isIndex).toBe(false);
    const expectedAtm = getAtmStrike('NIFTY', startPrice);
    expect(peTick?.strike).toBe(expectedAtm);
    expect(typeof peTick?.ltp).toBe('number');
    expect(peTick?.ltp ?? 0).toBeGreaterThan(0);
  });

  it('CE and PE symbols match what buildOptionSymbol produces for the same clock and spot', async () => {
    // This is the core correctness invariant: the simulator must use exactly
    // the same symbol-building logic as the straddle calculator so that when
    // the calculator looks up the CE/PE prices in its priceMap, the keys match.
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);
    const startPrice = 22_400;

    const sim = new MarketDataSimulator({ startPrice, intervalMs: 1_000, clock });
    const emitted: BrokerTick[] = [];
    sim.onTick((tick) => emitted.push(tick));

    await sim.connect();
    vi.advanceTimersByTime(1_000);
    await Promise.resolve();
    await sim.disconnect();

    const indexTick = emitted.find((t) => t.isIndex);
    const ceTick = emitted.find((t) => t.optionType === 'CE');
    const peTick = emitted.find((t) => t.optionType === 'PE');

    expect(indexTick).toBeDefined();
    expect(ceTick).toBeDefined();
    expect(peTick).toBeDefined();

    // Reconstruct expected symbols using the same instrument-registry functions.
    const spot = indexTick!.ltp;
    const expiry = getCurrentExpiry('NIFTY', clock);
    const atmStrike = getAtmStrike('NIFTY', spot);

    const expectedCeSymbol = buildOptionSymbol('NIFTY', expiry, atmStrike, 'CE');
    const expectedPeSymbol = buildOptionSymbol('NIFTY', expiry, atmStrike, 'PE');

    expect(ceTick!.symbol).toBe(expectedCeSymbol);
    expect(peTick!.symbol).toBe(expectedPeSymbol);
  });
});

// ---------------------------------------------------------------------------
// Straddle calculator produces snapshot = cePrice + pePrice when CE/PE present
// ---------------------------------------------------------------------------

describe('straddle-calc — snapshot produced when simulator CE/PE ticks are present', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('produces a snapshot with straddleValue = cePrice + pePrice when all three legs are fed', async () => {
    // Thursday noon IST — same date used in straddle-calc.test.ts for consistency.
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);
    const spot = 22_400;

    // Build expected symbols — same helpers the simulator uses.
    const expiry = getCurrentExpiry('NIFTY', clock);
    const atmStrike = getAtmStrike('NIFTY', spot);
    const ceSymbol = buildOptionSymbol('NIFTY', expiry, atmStrike, 'CE');
    const peSymbol = buildOptionSymbol('NIFTY', expiry, atmStrike, 'PE');

    const cePrice = 148.5;
    const pePrice = 152.75;

    // Simulate exactly what the simulator emits: index tick + CE tick + PE tick,
    // all with the same timestamp and using the same symbol builder.
    const expiryIso = expiry.toISOString().slice(0, 10);

    const ticks = [
      {
        id: '1-1',
        data: JSON.stringify({
          symbol: 'NSE:NIFTY50-INDEX',
          ltp: spot,
          timestamp: fixedDate.getTime(),
        }),
      },
      {
        id: '1-2',
        data: JSON.stringify({
          symbol: ceSymbol,
          ltp: cePrice,
          timestamp: fixedDate.getTime(),
          optionType: 'CE',
          strike: atmStrike,
          expiry: expiryIso,
          isIndex: false,
        }),
      },
      {
        id: '1-3',
        data: JSON.stringify({
          symbol: peSymbol,
          ltp: pePrice,
          timestamp: fixedDate.getTime(),
          optionType: 'PE',
          strike: atmStrike,
          expiry: expiryIso,
          isIndex: false,
        }),
      },
    ];

    const redis = makeFakeRedis();
    redis.xread
      .mockResolvedValueOnce(makeXreadResult('market.ticks', ticks))
      .mockResolvedValue(null);

    const calculator = createStraddleCalculator(redis as unknown as import('ioredis').Redis, {
      underlying: 'NIFTY',
      snapshotIntervalMs: 15_000,
      clock,
    });

    await calculator.start();

    // Flush microtasks so the async poll loop processes the XREAD result.
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    // Fire the snapshot interval.
    vi.advanceTimersByTime(15_000);
    // Allow the interval callback (fire-and-forget) to run.
    await Promise.resolve();
    // Allow the xadd promise inside the callback to resolve.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    await calculator.stop();

    // xadd must have been called exactly once — snapshot was NOT skipped.
    expect(redis.xadd).toHaveBeenCalledTimes(1);

    // Parse the published snapshot and verify the straddle value.
    const xaddArgs = redis.xadd.mock.calls[0] as unknown[];
    // Call shape: xadd('straddle.values', 'MAXLEN', '~', '10000', '*', 'data', <json>)
    expect(xaddArgs[0]).toBe('straddle.values');
    const snapshot = JSON.parse(xaddArgs[6] as string) as StraddleSnapshot;

    expect(snapshot.cePrice).toBeCloseTo(cePrice, 5);
    expect(snapshot.pePrice).toBeCloseTo(pePrice, 5);
    expect(snapshot.straddleValue).toBeCloseTo(cePrice + pePrice, 5);
    expect(snapshot.atmStrike).toBe(atmStrike);
    expect(snapshot.underlying).toBe('NIFTY');
  });

  it('skips snapshot when only the index tick is present (CE and PE missing) — pre-epic regression guard', async () => {
    // This test documents the PRE-EPIC failure mode: a simulator that only
    // emits the index tick causes straddle-calc to log a "missing CE/PE" debug
    // message and skip the xadd entirely. The simulator fix in this epic means
    // this scenario should no longer occur in production, but the guard ensures
    // the calculator's skip logic still works correctly if somehow fed incomplete data.
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);

    const ticks = [
      {
        id: '2-1',
        data: JSON.stringify({
          symbol: 'NSE:NIFTY50-INDEX',
          ltp: 22_400,
          timestamp: fixedDate.getTime(),
        }),
      },
      // No CE tick. No PE tick.
    ];

    const redis = makeFakeRedis();
    redis.xread
      .mockResolvedValueOnce(makeXreadResult('market.ticks', ticks))
      .mockResolvedValue(null);

    const calculator = createStraddleCalculator(redis as unknown as import('ioredis').Redis, {
      underlying: 'NIFTY',
      snapshotIntervalMs: 15_000,
      clock,
    });

    await calculator.start();

    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    vi.advanceTimersByTime(15_000);
    await Promise.resolve();
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    await calculator.stop();

    // With only the index tick, snapshot must be skipped — xadd not called.
    expect(redis.xadd).not.toHaveBeenCalled();
  });

  it('getLatestSnapshot() is non-null after snapshot is produced with CE and PE', async () => {
    const fixedDate = new Date('2024-01-25T06:30:00Z');
    const clock = new FixedClock(fixedDate);
    const spot = 22_400;

    const expiry = getCurrentExpiry('NIFTY', clock);
    const atmStrike = getAtmStrike('NIFTY', spot);
    const ceSymbol = buildOptionSymbol('NIFTY', expiry, atmStrike, 'CE');
    const peSymbol = buildOptionSymbol('NIFTY', expiry, atmStrike, 'PE');

    const ticks = [
      {
        id: '3-1',
        data: JSON.stringify({
          symbol: 'NSE:NIFTY50-INDEX',
          ltp: spot,
          timestamp: fixedDate.getTime(),
        }),
      },
      {
        id: '3-2',
        data: JSON.stringify({ symbol: ceSymbol, ltp: 150, timestamp: fixedDate.getTime() }),
      },
      {
        id: '3-3',
        data: JSON.stringify({ symbol: peSymbol, ltp: 145, timestamp: fixedDate.getTime() }),
      },
    ];

    const redis = makeFakeRedis();
    redis.xread
      .mockResolvedValueOnce(makeXreadResult('market.ticks', ticks))
      .mockResolvedValue(null);

    const calculator = createStraddleCalculator(redis as unknown as import('ioredis').Redis, {
      underlying: 'NIFTY',
      snapshotIntervalMs: 15_000,
      clock,
    });

    await calculator.start();

    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }

    vi.advanceTimersByTime(15_000);
    await Promise.resolve();
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }

    await calculator.stop();

    const latest = calculator.getLatestSnapshot();
    expect(latest).not.toBeNull();
    expect(latest?.straddleValue).toBe(150 + 145);
    expect(latest?.snapshotCount).toBe(1);
  });
});
