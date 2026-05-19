/**
 * Unit tests for StraddleCalculator (src/ingestion/straddle-calc.ts).
 *
 * All external dependencies (Redis, PostgreSQL, broker feed) are mocked.
 * Time is controlled via VirtualClock so snapshots are triggered
 * deterministically without real timers.
 */

import type { Redis } from "ioredis";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VirtualClock } from "../../utils/clock.js";
import type { BrokerFeed, BrokerTick } from "../brokers/types.js";
import { StraddleCalculator } from "../straddle-calc.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock the STREAM_STRADDLE import used internally by StraddleCalculator.
// The value itself is not under test; we only care about xadd call arguments.
vi.mock("../../redis/client.js", () => ({
  STREAM_STRADDLE: "straddle.values",
  streamPublish: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockRedis(): { redis: Redis; xadd: ReturnType<typeof vi.fn> } {
  const xadd = vi.fn().mockResolvedValue("1-0");
  const redis = { xadd } as unknown as Redis;
  return { redis, xadd };
}

function makeMockDb(): { db: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const db = { query } as unknown as Pool;
  return { db, query };
}

function makeMockBroker(): { broker: BrokerFeed; fireTick: (tick: BrokerTick) => void } {
  let tickHandler: ((tick: BrokerTick) => void) | undefined;

  const broker = {
    connect: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    on: vi.fn((event: string, handler: unknown) => {
      if (event === "tick") {
        tickHandler = handler as (tick: BrokerTick) => void;
      }
      return broker;
    }),
  } as unknown as BrokerFeed;

  const fireTick = (tick: BrokerTick) => {
    if (tickHandler) {
      tickHandler(tick);
    }
  };

  return { broker, fireTick };
}

function makeNiftyTick(ltp: number): BrokerTick {
  return {
    time: Date.now(),
    symbol: "NSE:NIFTY-INDEX",
    underlying: "NIFTY",
    ltp,
    bid: ltp - 1,
    ask: ltp + 1,
    volume: 0,
    oi: 0,
    isIndex: true,
  };
}

function makeVixTick(ltp: number): BrokerTick {
  return {
    time: Date.now(),
    symbol: "NSE:INDIAVIX-INDEX",
    underlying: "INDIAVIX",
    ltp,
    bid: ltp - 0.1,
    ask: ltp + 0.1,
    volume: 0,
    oi: 0,
    isIndex: true,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StraddleCalculator — no publish before first tick", () => {
  it("does not call xadd when no tick has arrived yet, even after the interval elapses", async () => {
    const { redis, xadd } = makeMockRedis();
    const { db } = makeMockDb();
    const clock = new VirtualClock(0);
    const { broker } = makeMockBroker();

    const calc = new StraddleCalculator({ db, redis, clock });

    // Use a 1000ms interval so that advancing by 15_000 definitely crosses it.
    process.env.STRADDLE_INTERVAL_MS = "1000";
    calc.start(broker);

    // Advance clock by 15 seconds — crosses the 1-second interval 15 times.
    // No NIFTY tick has arrived, so _lastSpot is null and no publish should occur.
    clock.advance(15_000);

    // Allow any microtasks/promises to flush
    await Promise.resolve();
    await Promise.resolve();

    expect(xadd).not.toHaveBeenCalled();

    calc.stop();
    Reflect.deleteProperty(process.env, "STRADDLE_INTERVAL_MS");
  });
});

describe("StraddleCalculator — publishes after NIFTY tick arrives", () => {
  beforeEach(() => {
    process.env.STRADDLE_INTERVAL_MS = "1000";
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, "STRADDLE_INTERVAL_MS");
  });

  it("calls xadd once after a NIFTY tick is fired and the interval elapses", async () => {
    const { redis, xadd } = makeMockRedis();
    const { db } = makeMockDb();
    const clock = new VirtualClock(0);
    const { broker, fireTick } = makeMockBroker();

    const calc = new StraddleCalculator({ db, redis, clock });
    calc.start(broker);

    // Fire a NIFTY spot tick
    fireTick(makeNiftyTick(22000));

    // Advance past the snapshot interval
    clock.advance(1500);

    // Allow async chains to settle
    await Promise.resolve();
    await Promise.resolve();

    expect(xadd).toHaveBeenCalledOnce();

    calc.stop();
  });

  it("published fields include straddleValue, atmStrike, spot, and underlying", async () => {
    const { redis, xadd } = makeMockRedis();
    const { db } = makeMockDb();
    const clock = new VirtualClock(0);
    const { broker, fireTick } = makeMockBroker();

    const calc = new StraddleCalculator({ db, redis, clock });
    calc.start(broker);

    fireTick(makeNiftyTick(22000));
    clock.advance(1500);
    await Promise.resolve();
    await Promise.resolve();

    expect(xadd).toHaveBeenCalledOnce();

    // xadd is called with: (STREAM, "MAXLEN", "~", "10000", "*", ...flatFields)
    const callArgs = xadd.mock.calls[0] as unknown[];
    // flatFields start at index 5 and are [k, v, k, v, ...]
    const flatFields = callArgs.slice(5) as string[];

    const fields: Record<string, string> = {};
    for (let i = 0; i < flatFields.length - 1; i += 2) {
      fields[flatFields[i] as string] = flatFields[i + 1] as string;
    }

    expect(fields).toHaveProperty("straddleValue");
    expect(fields).toHaveProperty("atmStrike");
    expect(fields).toHaveProperty("spot", "22000");
    expect(fields).toHaveProperty("underlying", "NIFTY");

    calc.stop();
  });

  it("atmStrike is the nearest 50-point multiple of the NIFTY spot", async () => {
    const { redis, xadd } = makeMockRedis();
    const { db } = makeMockDb();
    const clock = new VirtualClock(0);
    const { broker, fireTick } = makeMockBroker();

    const calc = new StraddleCalculator({ db, redis, clock });
    calc.start(broker);

    // spot=22137 → ATM = 22150 (nearest 50)
    fireTick(makeNiftyTick(22137));
    clock.advance(1500);
    await Promise.resolve();
    await Promise.resolve();

    const flatFields = (xadd.mock.calls[0] as unknown[]).slice(5) as string[];
    const fields: Record<string, string> = {};
    for (let i = 0; i < flatFields.length - 1; i += 2) {
      fields[flatFields[i] as string] = flatFields[i + 1] as string;
    }

    expect(fields.atmStrike).toBe("22150");

    calc.stop();
  });

  it("VIX tick updates the vix field in the published payload", async () => {
    const { redis, xadd } = makeMockRedis();
    const { db } = makeMockDb();
    const clock = new VirtualClock(0);
    const { broker, fireTick } = makeMockBroker();

    const calc = new StraddleCalculator({ db, redis, clock });
    calc.start(broker);

    // Fire VIX tick first, then NIFTY spot tick
    fireTick(makeVixTick(14.5));
    fireTick(makeNiftyTick(22000));

    clock.advance(1500);
    await Promise.resolve();
    await Promise.resolve();

    const flatFields = (xadd.mock.calls[0] as unknown[]).slice(5) as string[];
    const fields: Record<string, string> = {};
    for (let i = 0; i < flatFields.length - 1; i += 2) {
      fields[flatFields[i] as string] = flatFields[i + 1] as string;
    }

    expect(fields.vix).toBe("14.5");

    calc.stop();
  });

  it("without a VIX tick, the vix field is published as the string 'null'", async () => {
    const { redis, xadd } = makeMockRedis();
    const { db } = makeMockDb();
    const clock = new VirtualClock(0);
    const { broker, fireTick } = makeMockBroker();

    const calc = new StraddleCalculator({ db, redis, clock });
    calc.start(broker);

    fireTick(makeNiftyTick(22000));
    clock.advance(1500);
    await Promise.resolve();
    await Promise.resolve();

    const flatFields = (xadd.mock.calls[0] as unknown[]).slice(5) as string[];
    const fields: Record<string, string> = {};
    for (let i = 0; i < flatFields.length - 1; i += 2) {
      fields[flatFields[i] as string] = flatFields[i + 1] as string;
    }

    expect(fields.vix).toBe("null");

    calc.stop();
  });
});

describe("StraddleCalculator — stop() prevents further publishes", () => {
  it("does not call xadd after stop() even when the interval elapses again", async () => {
    process.env.STRADDLE_INTERVAL_MS = "1000";

    const { redis, xadd } = makeMockRedis();
    const { db } = makeMockDb();
    const clock = new VirtualClock(0);
    const { broker, fireTick } = makeMockBroker();

    const calc = new StraddleCalculator({ db, redis, clock });
    calc.start(broker);

    // Fire a tick so _lastSpot is set
    fireTick(makeNiftyTick(22000));

    // Advance to trigger one snapshot
    clock.advance(1500);
    await Promise.resolve();
    await Promise.resolve();

    // Should have published once
    expect(xadd).toHaveBeenCalledOnce();

    // Stop the calculator, then advance the clock further
    calc.stop();
    xadd.mockClear();

    clock.advance(3000);
    await Promise.resolve();
    await Promise.resolve();

    // No further publishes should occur after stop()
    expect(xadd).not.toHaveBeenCalled();

    Reflect.deleteProperty(process.env, "STRADDLE_INTERVAL_MS");
  });
});

describe("StraddleCalculator — non-NIFTY index ticks are ignored", () => {
  it("BANKNIFTY tick does not set the spot and no snapshot is published", async () => {
    process.env.STRADDLE_INTERVAL_MS = "1000";

    const { redis, xadd } = makeMockRedis();
    const { db } = makeMockDb();
    const clock = new VirtualClock(0);
    const { broker, fireTick } = makeMockBroker();

    const calc = new StraddleCalculator({ db, redis, clock });
    calc.start(broker);

    // Fire a BANKNIFTY tick (should be ignored, only NIFTY drives snapshots)
    fireTick({
      time: Date.now(),
      symbol: "NSE:BANKNIFTY-INDEX",
      underlying: "BANKNIFTY",
      ltp: 49000,
      bid: 48999,
      ask: 49001,
      volume: 0,
      oi: 0,
      isIndex: true,
    });

    clock.advance(1500);
    await Promise.resolve();
    await Promise.resolve();

    // No NIFTY tick has arrived — no publish
    expect(xadd).not.toHaveBeenCalled();

    calc.stop();
    Reflect.deleteProperty(process.env, "STRADDLE_INTERVAL_MS");
  });
});
