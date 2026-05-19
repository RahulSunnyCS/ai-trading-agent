/**
 * Unit tests for EntryEngine (src/trading/entry-engine.ts).
 *
 * All external dependencies (DB query, Redis streamConsume) are mocked at the
 * module level so no network or database connections are made. Time is injected
 * via FixedClock for deterministic gate evaluation.
 */

import type { Pool } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EntryEngine, type EntryIntent } from "../../trading/entry-engine.js";
import { FixedClock } from "../../utils/clock.js";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock("../../db/client.js", () => ({
  query: vi.fn(),
}));

vi.mock("../../redis/client.js", () => ({
  STREAM_STRADDLE: "straddle.values",
  streamConsume: vi.fn(),
}));

// Import mocked modules so we can control their behaviour per test
import { query } from "../../db/client.js";
import { streamConsume } from "../../redis/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * IST 10:00:00 on 2026-05-18 (a regular trading day, not in BLOCKED_DATES).
 * UTC equivalent: 2026-05-18T04:30:00.000Z
 */
const IST_1000_MAY18 = new Date("2026-05-18T04:30:00.000Z").getTime();

/**
 * IST 08:00:00 on 2026-05-18 — before the default entry window (09:20).
 * UTC equivalent: 2026-05-18T02:30:00.000Z
 */
const IST_0800_MAY18 = new Date("2026-05-18T02:30:00.000Z").getTime();

/**
 * IST 10:00:00 on 2026-01-15 — a blocked-date test target.
 * UTC equivalent: 2026-01-15T04:30:00.000Z
 */
const IST_1000_JAN15 = new Date("2026-01-15T04:30:00.000Z").getTime();

/** Valid straddle snapshot fields that pass all gates (except ones under test). */
const validFields: Record<string, string> = {
  straddleValue: "200",
  atmStrike: "22000",
  spot: "22000",
  underlying: "NIFTY",
  time: String(IST_1000_MAY18),
};

/** Minimal mock for pg.Pool — only used in constructor signature. */
const mockDb = {} as unknown as Pool;

/** Minimal mock for ioredis.Redis — only used in constructor signature. */
const mockRedis = {} as unknown as import("ioredis").Redis;

/**
 * Capture the handler registered via streamConsume so tests can invoke it
 * directly to simulate incoming Redis stream messages.
 */
function captureStreamHandler(): {
  getHandler: () => ((id: string, fields: Record<string, string>) => Promise<void>) | undefined;
} {
  let captured: ((id: string, fields: Record<string, string>) => Promise<void>) | undefined;

  vi.mocked(streamConsume).mockImplementation((_stream, _group, _consumer, handler) => {
    captured = handler;
  });

  return {
    getHandler: () => captured,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default: no open positions
  vi.mocked(query).mockResolvedValue([]);
});

afterEach(() => {
  // Clean up any env vars set during tests.
  // Reflect.deleteProperty is used instead of `delete process.env.X` to avoid
  // accidentally setting the value to the string "undefined" (which biome
  // rewrites `= undefined` assignments to — they are not the same as deletion).
  for (const key of [
    "BLOCKED_DATES",
    "VIX_MAX",
    "ENTRY_START_TIME",
    "ENTRY_CUTOFF_TIME",
    "ENTRY_COOLDOWN_MS",
  ]) {
    Reflect.deleteProperty(process.env, key);
  }
});

// ---------------------------------------------------------------------------
// Time gate tests
// ---------------------------------------------------------------------------

describe("EntryEngine — time gate", () => {
  it("blocks entry when clock is outside the entry window (before 09:20 IST)", async () => {
    const { getHandler } = captureStreamHandler();
    const clock = new FixedClock(IST_0800_MAY18);
    const engine = new EntryEngine({ db: mockDb, redis: mockRedis, clock });
    engine.start();

    const handler = getHandler();
    expect(handler).toBeDefined();

    const emitted: EntryIntent[] = [];
    engine.on("entry", (intent) => emitted.push(intent));

    await handler?.("msg-1", validFields);

    // query (open-positions check) should NOT be called — time gate fires first
    expect(query).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });

  it("passes the time gate and proceeds to open-position check at 10:00 IST", async () => {
    const { getHandler } = captureStreamHandler();
    const clock = new FixedClock(IST_1000_MAY18);
    const engine = new EntryEngine({ db: mockDb, redis: mockRedis, clock });
    engine.start();

    const handler = getHandler();
    const emitted: EntryIntent[] = [];
    engine.on("entry", (intent) => emitted.push(intent));

    await handler?.("msg-1", validFields);

    // query IS called when the time gate passes
    expect(query).toHaveBeenCalledOnce();
    // And the entry is emitted (no open positions, all other gates pass)
    expect(emitted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Blocked date gate tests
// ---------------------------------------------------------------------------

describe("EntryEngine — blocked date gate", () => {
  it("blocks entry on a blocked date even within the valid time window", async () => {
    process.env.BLOCKED_DATES = JSON.stringify(["2026-01-15"]);

    const { getHandler } = captureStreamHandler();
    const clock = new FixedClock(IST_1000_JAN15);
    // Construct AFTER setting env var so the constructor picks it up
    const engine = new EntryEngine({ db: mockDb, redis: mockRedis, clock });
    engine.start();

    const handler = getHandler();
    const emitted: EntryIntent[] = [];
    engine.on("entry", (intent) => emitted.push(intent));

    await handler?.("msg-1", validFields);

    expect(emitted).toHaveLength(0);
  });

  it("allows entry on a non-blocked date", async () => {
    process.env.BLOCKED_DATES = JSON.stringify(["2026-01-15"]);

    const { getHandler } = captureStreamHandler();
    // 2026-05-18 is NOT in the blocked list
    const clock = new FixedClock(IST_1000_MAY18);
    const engine = new EntryEngine({ db: mockDb, redis: mockRedis, clock });
    engine.start();

    const handler = getHandler();
    const emitted: EntryIntent[] = [];
    engine.on("entry", (intent) => emitted.push(intent));

    await handler?.("msg-1", validFields);

    expect(emitted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Open position gate tests
// ---------------------------------------------------------------------------

describe("EntryEngine — open position gate", () => {
  it("blocks entry when an existing open position is found in paper_trades", async () => {
    vi.mocked(query).mockResolvedValue([{ id: "existing-trade-id" }]);

    const { getHandler } = captureStreamHandler();
    const clock = new FixedClock(IST_1000_MAY18);
    const engine = new EntryEngine({ db: mockDb, redis: mockRedis, clock });
    engine.start();

    const handler = getHandler();
    const emitted: EntryIntent[] = [];
    engine.on("entry", (intent) => emitted.push(intent));

    await handler?.("msg-1", validFields);

    expect(emitted).toHaveLength(0);
  });

  it("allows entry when no open positions exist", async () => {
    vi.mocked(query).mockResolvedValue([]);

    const { getHandler } = captureStreamHandler();
    const clock = new FixedClock(IST_1000_MAY18);
    const engine = new EntryEngine({ db: mockDb, redis: mockRedis, clock });
    engine.start();

    const handler = getHandler();
    const emitted: EntryIntent[] = [];
    engine.on("entry", (intent) => emitted.push(intent));

    await handler?.("msg-1", validFields);

    expect(emitted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// VIX gate tests
// ---------------------------------------------------------------------------

describe("EntryEngine — VIX gate", () => {
  it("blocks entry when VIX exceeds VIX_MAX", async () => {
    process.env.VIX_MAX = "20";

    const { getHandler } = captureStreamHandler();
    const clock = new FixedClock(IST_1000_MAY18);
    const engine = new EntryEngine({ db: mockDb, redis: mockRedis, clock });
    engine.start();

    const handler = getHandler();
    const emitted: EntryIntent[] = [];
    engine.on("entry", (intent) => emitted.push(intent));

    const fieldsWithHighVix = { ...validFields, vix: "25" };
    await handler?.("msg-1", fieldsWithHighVix);

    expect(emitted).toHaveLength(0);
  });

  it("allows entry when VIX equals VIX_MAX (boundary: > not >=)", async () => {
    process.env.VIX_MAX = "20";

    const { getHandler } = captureStreamHandler();
    const clock = new FixedClock(IST_1000_MAY18);
    const engine = new EntryEngine({ db: mockDb, redis: mockRedis, clock });
    engine.start();

    const handler = getHandler();
    const emitted: EntryIntent[] = [];
    engine.on("entry", (intent) => emitted.push(intent));

    // VIX exactly at the cap — the gate condition is `> VIX_MAX`, not `>=`
    const fieldsAtCap = { ...validFields, vix: "20" };
    await handler?.("msg-1", fieldsAtCap);

    expect(emitted).toHaveLength(1);
  });

  it("passes gate when VIX field is absent (missing VIX = allow)", async () => {
    process.env.VIX_MAX = "20";

    const { getHandler } = captureStreamHandler();
    const clock = new FixedClock(IST_1000_MAY18);
    const engine = new EntryEngine({ db: mockDb, redis: mockRedis, clock });
    engine.start();

    const handler = getHandler();
    const emitted: EntryIntent[] = [];
    engine.on("entry", (intent) => emitted.push(intent));

    // Fields without a vix key at all
    const { vix: _vix, ...fieldsNoVix } = validFields;
    await handler?.("msg-1", fieldsNoVix);

    expect(emitted).toHaveLength(1);
  });

  it("passes gate when VIX_MAX is not set (gate disabled)", async () => {
    // No VIX_MAX env var

    const { getHandler } = captureStreamHandler();
    const clock = new FixedClock(IST_1000_MAY18);
    const engine = new EntryEngine({ db: mockDb, redis: mockRedis, clock });
    engine.start();

    const handler = getHandler();
    const emitted: EntryIntent[] = [];
    engine.on("entry", (intent) => emitted.push(intent));

    const fieldsWithVix = { ...validFields, vix: "50" };
    await handler?.("msg-1", fieldsWithVix);

    // VIX_MAX not configured → gate is disabled → entry should be emitted
    expect(emitted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Cooldown throttle tests
// ---------------------------------------------------------------------------

describe("EntryEngine — cooldown throttle", () => {
  it("suppresses a second entry signal within the cooldown window", async () => {
    // Use 5-minute cooldown (300_000 ms) with a fixed clock (time never advances)
    process.env.ENTRY_COOLDOWN_MS = "300000";

    const { getHandler } = captureStreamHandler();
    const clock = new FixedClock(IST_1000_MAY18);
    const engine = new EntryEngine({ db: mockDb, redis: mockRedis, clock });
    engine.start();

    const handler = getHandler();
    const emitted: EntryIntent[] = [];
    engine.on("entry", (intent) => emitted.push(intent));

    // First snapshot — should emit
    await handler?.("msg-1", validFields);
    expect(emitted).toHaveLength(1);

    // Second snapshot at the same instant (clock is fixed) — still within cooldown
    await handler?.("msg-2", { ...validFields, time: String(IST_1000_MAY18 + 1000) });
    expect(emitted).toHaveLength(1); // still only 1 — cooldown suppresses the second
  });

  it("allows a second entry after the cooldown window has elapsed", async () => {
    process.env.ENTRY_COOLDOWN_MS = "1000"; // 1-second cooldown for this test

    // First call at T=0
    const clockT0 = new FixedClock(IST_1000_MAY18);
    const { getHandler: captureT0 } = captureStreamHandler();
    const engineT0 = new EntryEngine({ db: mockDb, redis: mockRedis, clock: clockT0 });
    engineT0.start();

    const handlerT0 = captureT0();
    const emittedT0: EntryIntent[] = [];
    engineT0.on("entry", (intent) => emittedT0.push(intent));
    await handlerT0?.("msg-1", validFields);
    expect(emittedT0).toHaveLength(1);

    // Create a NEW engine (simulates app restart / fresh cooldown state)
    // so the second call is not throttled
    vi.clearAllMocks();
    vi.mocked(query).mockResolvedValue([]);

    const clockT1 = new FixedClock(IST_1000_MAY18 + 5000); // 5s later — past 1s cooldown
    const { getHandler: captureT1 } = captureStreamHandler();
    const engineT1 = new EntryEngine({ db: mockDb, redis: mockRedis, clock: clockT1 });
    engineT1.start();

    const handlerT1 = captureT1();
    const emittedT1: EntryIntent[] = [];
    engineT1.on("entry", (intent) => emittedT1.push(intent));
    await handlerT1?.("msg-2", validFields);
    expect(emittedT1).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Missing / malformed field tests
// ---------------------------------------------------------------------------

describe("EntryEngine — malformed snapshot fields", () => {
  it("skips without error when straddleValue is absent", async () => {
    const { getHandler } = captureStreamHandler();
    const clock = new FixedClock(IST_1000_MAY18);
    const engine = new EntryEngine({ db: mockDb, redis: mockRedis, clock });
    engine.start();

    const handler = getHandler();
    const emitted: EntryIntent[] = [];
    engine.on("entry", (intent) => emitted.push(intent));

    // Fields with no straddleValue key
    const incompleteFields: Record<string, string> = { atmStrike: "22000" };

    // Must not throw
    await expect(handler?.("msg-1", incompleteFields)).resolves.toBeUndefined();
    expect(emitted).toHaveLength(0);
  });

  it("skips without error when straddleValue is an empty string", async () => {
    const { getHandler } = captureStreamHandler();
    const clock = new FixedClock(IST_1000_MAY18);
    const engine = new EntryEngine({ db: mockDb, redis: mockRedis, clock });
    engine.start();

    const handler = getHandler();
    const emitted: EntryIntent[] = [];
    engine.on("entry", (intent) => emitted.push(intent));

    await expect(
      handler?.("msg-1", { ...validFields, straddleValue: "" }),
    ).resolves.toBeUndefined();
    expect(emitted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Happy path: emitted EntryIntent fields
// ---------------------------------------------------------------------------

describe("EntryEngine — happy path emits EntryIntent with correct fields", () => {
  it("emits an EntryIntent with the correct straddleValue, atmStrike, and underlying", async () => {
    const { getHandler } = captureStreamHandler();
    const clock = new FixedClock(IST_1000_MAY18);
    const engine = new EntryEngine({ db: mockDb, redis: mockRedis, clock });
    engine.start();

    const handler = getHandler();
    const emitted: EntryIntent[] = [];
    engine.on("entry", (intent) => emitted.push(intent));

    const snapshot: Record<string, string> = {
      straddleValue: "215.50",
      atmStrike: "22050",
      spot: "22042",
      underlying: "NIFTY",
      vix: "13.2",
      time: String(IST_1000_MAY18),
    };

    await handler?.("msg-1", snapshot);

    expect(emitted).toHaveLength(1);
    const intent = emitted[0];

    expect(intent?.straddleValue).toBe("215.50");
    expect(intent?.atmStrike).toBe(22050);
    expect(intent?.underlying).toBe("NIFTY");
    expect(intent?.spot).toBe("22042");
    expect(intent?.vixAtEntry).toBe("13.2");
    expect(intent?.entryTimeMs).toBe(IST_1000_MAY18);
  });

  it("emits vixAtEntry as null when vix field is missing from the snapshot", async () => {
    const { getHandler } = captureStreamHandler();
    const clock = new FixedClock(IST_1000_MAY18);
    const engine = new EntryEngine({ db: mockDb, redis: mockRedis, clock });
    engine.start();

    const handler = getHandler();
    const emitted: EntryIntent[] = [];
    engine.on("entry", (intent) => emitted.push(intent));

    const { vix: _vix, ...fieldsNoVix } = validFields;
    await handler?.("msg-1", fieldsNoVix);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.vixAtEntry).toBeNull();
  });

  it("accepts snake_case field keys as fallback for straddleValue", async () => {
    const { getHandler } = captureStreamHandler();
    const clock = new FixedClock(IST_1000_MAY18);
    const engine = new EntryEngine({ db: mockDb, redis: mockRedis, clock });
    engine.start();

    const handler = getHandler();
    const emitted: EntryIntent[] = [];
    engine.on("entry", (intent) => emitted.push(intent));

    // Use snake_case key (legacy format)
    const snakeCaseFields: Record<string, string> = {
      straddle_value: "180.00",
      atm_strike: "22100",
      spot: "22095",
      time: String(IST_1000_MAY18),
    };

    await handler?.("msg-1", snakeCaseFields);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.straddleValue).toBe("180.00");
    expect(emitted[0]?.atmStrike).toBe(22100);
  });
});

// ---------------------------------------------------------------------------
// stop() tests
// ---------------------------------------------------------------------------

describe("EntryEngine — stop()", () => {
  it("discards messages received after stop() is called", async () => {
    const { getHandler } = captureStreamHandler();
    const clock = new FixedClock(IST_1000_MAY18);
    const engine = new EntryEngine({ db: mockDb, redis: mockRedis, clock });
    engine.start();

    const handler = getHandler();
    const emitted: EntryIntent[] = [];
    engine.on("entry", (intent) => emitted.push(intent));

    // Stop the engine before the message arrives
    engine.stop();

    await handler?.("msg-1", validFields);

    // query must not be called; entry must not be emitted
    expect(query).not.toHaveBeenCalled();
    expect(emitted).toHaveLength(0);
  });
});
