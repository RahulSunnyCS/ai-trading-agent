/**
 * Unit tests for GlobalMacroFeed and getMacroContext.
 *
 * All external dependencies (Redis, fetch) are mocked — no real HTTP requests
 * and no Redis instance required.
 *
 * Clock is injected to control the poll-window check deterministically.
 */

import type { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMacroContext,
  GlobalMacroFeed,
  type MacroDataPoint,
  type MacroContext,
} from "../global-macro-feed.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal Redis mock with vi.fn() stubs for get and set.
 * We only stub the methods used by GlobalMacroFeed and getMacroContext.
 */
function makeMockRedis(): {
  redis: Redis;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn().mockResolvedValue(null) as ReturnType<typeof vi.fn>;
  const set = vi.fn().mockResolvedValue("OK");
  const redis = { get, set } as unknown as Redis;
  return { redis, get, set };
}

/**
 * Builds a minimal valid Yahoo Finance chart API response for a given price
 * and previous close. Mirrors the shape expected by fetchInstrument().
 */
function makeYFResponse(price: number, prevClose: number): object {
  return {
    chart: {
      result: [
        {
          meta: {
            regularMarketPrice: price,
            regularMarketPreviousClose: prevClose,
          },
        },
      ],
      error: null,
    },
  };
}

/**
 * A clock fixed to a timestamp that falls within the default IST poll window
 * (08:00–23:00). We use 2026-05-19T06:00:00Z = 11:30 IST, well within window.
 */
const WITHIN_WINDOW_EPOCH_MS = new Date("2026-05-19T06:00:00Z").getTime(); // 11:30 IST

/**
 * A clock fixed to a timestamp outside the IST poll window.
 * 2026-05-19T20:00:00Z = 01:30 IST next day — outside 08:00–23:00.
 */
const OUTSIDE_WINDOW_EPOCH_MS = new Date("2026-05-19T20:00:00Z").getTime(); // 01:30 IST

const withinWindowClock = { now: () => WITHIN_WINDOW_EPOCH_MS, today: () => "", toISTDate: () => "", toISTTime: () => "" };
const outsideWindowClock = { now: () => OUTSIDE_WINDOW_EPOCH_MS, today: () => "", toISTDate: () => "", toISTTime: () => "" };

// ---------------------------------------------------------------------------
// Suite 1: getMacroContext
// ---------------------------------------------------------------------------

describe("getMacroContext", () => {
  it("returns null for all fields when all Redis keys are absent", async () => {
    const { redis, get } = makeMockRedis();

    // All five keys return null (not in Redis / TTL expired).
    get.mockResolvedValue(null);

    const ctx = await getMacroContext(redis);

    expect(ctx.us_vix).toBeNull();
    expect(ctx.sp500).toBeNull();
    expect(ctx.dax).toBeNull();
    expect(ctx.crude_oil).toBeNull();
    expect(ctx.gold).toBeNull();
  });

  it("parses stored data points correctly for present keys, null for absent ones", async () => {
    const { redis, get } = makeMockRedis();

    const vixPoint: MacroDataPoint = { value: 18.5, change_pct: -2.3, timestamp: 1000000 };
    const sp500Point: MacroDataPoint = { value: 5200.0, change_pct: 0.8, timestamp: 1000001 };

    // Only us_vix and sp500 are present in Redis.
    get.mockImplementation(async (key: string) => {
      if (key === "macro:us_vix") return JSON.stringify(vixPoint);
      if (key === "macro:sp500") return JSON.stringify(sp500Point);
      return null;
    });

    const ctx: MacroContext = await getMacroContext(redis);

    // Populated fields should match the stored values exactly.
    expect(ctx.us_vix).toEqual(vixPoint);
    expect(ctx.sp500).toEqual(sp500Point);

    // Absent fields remain null.
    expect(ctx.dax).toBeNull();
    expect(ctx.crude_oil).toBeNull();
    expect(ctx.gold).toBeNull();
  });

  it("returns null for a key whose Redis value has invalid shape", async () => {
    const { redis, get } = makeMockRedis();

    // Stored JSON is missing the required numeric fields.
    get.mockImplementation(async (key: string) => {
      if (key === "macro:gold") return JSON.stringify({ bad: "data" });
      return null;
    });

    const ctx = await getMacroContext(redis);

    // Shape validation failure → null for that instrument.
    expect(ctx.gold).toBeNull();
    // Others unaffected.
    expect(ctx.us_vix).toBeNull();
  });

  it("returns null for a key when Redis.get throws", async () => {
    const { redis, get } = makeMockRedis();

    get.mockImplementation(async (key: string) => {
      if (key === "macro:crude_oil") throw new Error("Redis connection error");
      return null;
    });

    // Must not throw — errors are caught and returned as null.
    const ctx = await getMacroContext(redis);
    expect(ctx.crude_oil).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Suite 2: GlobalMacroFeed._doPoll()
// ---------------------------------------------------------------------------

describe("GlobalMacroFeed._doPoll()", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches all five instruments and stores each to Redis on a successful poll", async () => {
    const { redis, set } = makeMockRedis();

    // Stub global fetch to return a valid YF response for every symbol.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => makeYFResponse(100, 98),
      }),
    );

    const feed = new GlobalMacroFeed(redis, withinWindowClock);
    await feed._doPoll();

    // Redis.set must have been called once per instrument (5 total).
    expect(set).toHaveBeenCalledTimes(5);

    // Each call should use the correct key pattern and EX ttl.
    const keys = set.mock.calls.map((c) => c[0] as string);
    expect(keys).toContain("macro:us_vix");
    expect(keys).toContain("macro:sp500");
    expect(keys).toContain("macro:dax");
    expect(keys).toContain("macro:crude_oil");
    expect(keys).toContain("macro:gold");

    // Spot-check one stored value parses correctly.
    const vixCall = set.mock.calls.find((c) => c[0] === "macro:us_vix");
    expect(vixCall).toBeDefined();
    const stored = JSON.parse(vixCall![1] as string) as MacroDataPoint;
    expect(stored.value).toBe(100);
    // change_pct = ((100 - 98) / 98) * 100 ≈ 2.0408...
    expect(stored.change_pct).toBeCloseTo(2.0408, 3);
    expect(stored.timestamp).toBe(WITHIN_WINDOW_EPOCH_MS);

    // Verify TTL was set.
    expect(vixCall![2]).toBe("EX");
    expect(vixCall![3]).toBe(900);
  });

  it("skips the poll without throwing when outside the IST window", async () => {
    const { redis, set } = makeMockRedis();

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const feed = new GlobalMacroFeed(redis, outsideWindowClock);
    await feed._doPoll();

    // Neither fetch nor Redis.set should have been called.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("does not crash when fetch throws for one instrument; stores the rest", async () => {
    const { redis, set } = makeMockRedis();

    let callCount = 0;

    // First symbol (^VIX) throws a network error; all others succeed.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        callCount++;
        // The URL contains the encoded symbol — ^VIX becomes %5EVIX.
        if ((url as string).includes("%5EVIX")) {
          // Throw on both the initial attempt and the retry attempt so the
          // instrument is fully skipped after MAX_ATTEMPTS (2).
          throw new Error("network timeout");
        }
        return {
          ok: true,
          json: async () => makeYFResponse(200, 195),
        };
      }),
    );

    // Should not throw.
    const feed = new GlobalMacroFeed(redis, withinWindowClock);
    await expect(feed._doPoll()).resolves.toBeUndefined();

    // The four successful instruments should each be stored.
    // us_vix fails, so we expect 4 Redis.set calls.
    expect(set).toHaveBeenCalledTimes(4);

    const keys = set.mock.calls.map((c) => c[0] as string);
    expect(keys).not.toContain("macro:us_vix");
    expect(keys).toContain("macro:sp500");
    expect(keys).toContain("macro:dax");
    expect(keys).toContain("macro:crude_oil");
    expect(keys).toContain("macro:gold");
  });

  it("does not crash when fetch returns HTTP error for one instrument", async () => {
    const { redis, set } = makeMockRedis();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        // Return 429 for DAX (^GDAXI → %5EGDAXI), success for others.
        if ((url as string).includes("GDAXI")) {
          return { ok: false, status: 429, statusText: "Too Many Requests" };
        }
        return {
          ok: true,
          json: async () => makeYFResponse(300, 295),
        };
      }),
    );

    const feed = new GlobalMacroFeed(redis, withinWindowClock);
    await expect(feed._doPoll()).resolves.toBeUndefined();

    // Four stored (dax skipped).
    expect(set).toHaveBeenCalledTimes(4);

    const keys = set.mock.calls.map((c) => c[0] as string);
    expect(keys).not.toContain("macro:dax");
  });

  it("does not store anything when all fetches fail", async () => {
    const { redis, set } = makeMockRedis();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("all down")),
    );

    const feed = new GlobalMacroFeed(redis, withinWindowClock);
    await expect(feed._doPoll()).resolves.toBeUndefined();

    expect(set).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Suite 3: GlobalMacroFeed start/stop lifecycle
// ---------------------------------------------------------------------------

describe("GlobalMacroFeed start/stop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("start() is idempotent — calling it twice does not create duplicate timers", () => {
    const { redis } = makeMockRedis();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeYFResponse(10, 9),
    }));

    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

    const feed = new GlobalMacroFeed(redis, withinWindowClock);
    feed.start();
    feed.start(); // second call must be a no-op

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    feed.stop();
  });

  it("stop() prevents further polls after being called", () => {
    const { redis, set } = makeMockRedis();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeYFResponse(50, 48),
    }));

    // Use a short interval so we can advance fake timers easily.
    process.env["MACRO_POLL_INTERVAL_MS"] = "60000";

    const feed = new GlobalMacroFeed(redis, withinWindowClock);
    feed.start();
    feed.stop();

    // Advance past the interval — no poll should fire because stop() cleared the timer.
    vi.advanceTimersByTime(120_000);

    expect(set).not.toHaveBeenCalled();

    // Clean up the env var so other tests are not affected.
    delete process.env["MACRO_POLL_INTERVAL_MS"];
  });
});
