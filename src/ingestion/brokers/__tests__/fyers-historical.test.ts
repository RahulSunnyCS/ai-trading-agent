/**
 * Unit tests for fyers-historical.ts
 *
 * All tests use an injected fetchFn and sleepFn — no live network calls,
 * no DB connections. The db parameter is always null in these tests (env-var
 * credential path is exercised directly).
 *
 * Coverage:
 *   1. chunkDateRange — chunking math for various resolutions and ranges
 *   2. HTTP 429 — exponential backoff up to MAX_RETRIES, then FyersRateLimitError
 *   3. HTTP 401 — FyersAuthError with lastSuccessfulCutoff (mid-fetch auth failure)
 *   4. Fyers-level auth error — HTTP 200 with s="error" and token-related message
 *   5. Missing-strike gap marker — empty chunk produces FyersCandleGap
 *   6. No-creds loud failure — FyersNoCredentialsError when env vars absent
 *   7. Successful multi-chunk fetch — candles assembled correctly, meta accurate
 *   8. Malformed candle tuple — skipped gracefully, no crash
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FyersAuthError,
  FyersNoCredentialsError,
  FyersRateLimitError,
  type FetchFn,
  type FyersResolution,
  RESOLUTION_DAY_CAPS,
  chunkDateRange,
  fetchHistoricalCandles,
} from "../fyers-historical.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake successful Fyers history response. */
function okResponse(candles: number[][]): Response {
  return new Response(JSON.stringify({ s: "ok", candles }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build a fake Fyers error response (HTTP 200, s="error"). */
function apiErrorResponse(message: string, code?: number): Response {
  return new Response(JSON.stringify({ s: "error", message, code }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** Build a fake HTTP status response with empty body. */
function httpStatusResponse(status: number): Response {
  return new Response("", { status });
}

/** A candle tuple at the given epoch seconds. */
function candle(epochSec: number): number[] {
  return [epochSec, 100, 105, 95, 102, 1000];
}

/** Parse ISO date to epoch seconds (UTC). */
function toEpochSec(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/** A no-op sleep function (returns immediately — never adds test delays). */
const noopSleep = vi.fn().mockResolvedValue(undefined);

/**
 * Wrap a vi.fn() mock as a FetchFn.
 *
 * vi.fn() returns Vitest's Mock type, which lacks the static `preconnect`
 * member present in bun-types' `typeof fetch`. Casting through `unknown`
 * avoids the compile error without weakening the mock — at runtime the
 * callable interface is fully satisfied.
 */
function asFetchFn(mock: ReturnType<typeof vi.fn>): FetchFn {
  return mock as unknown as FetchFn;
}

/** Set FYERS env vars and return a cleanup function. */
function setFyersEnv(): () => void {
  const prev = {
    FYERS_ACCESS_TOKEN: process.env["FYERS_ACCESS_TOKEN"],
    FYERS_APP_ID: process.env["FYERS_APP_ID"],
  };
  process.env["FYERS_ACCESS_TOKEN"] = "test-access-token-xyz";
  process.env["FYERS_APP_ID"] = "TESTAPP1234-100";
  return () => {
    if (prev.FYERS_ACCESS_TOKEN === undefined) {
      delete process.env["FYERS_ACCESS_TOKEN"];
    } else {
      process.env["FYERS_ACCESS_TOKEN"] = prev.FYERS_ACCESS_TOKEN;
    }
    if (prev.FYERS_APP_ID === undefined) {
      delete process.env["FYERS_APP_ID"];
    } else {
      process.env["FYERS_APP_ID"] = prev.FYERS_APP_ID;
    }
  };
}

/** Clear FYERS env vars and return a cleanup function. */
function clearFyersEnv(): () => void {
  const prev = {
    FYERS_ACCESS_TOKEN: process.env["FYERS_ACCESS_TOKEN"],
    FYERS_APP_ID: process.env["FYERS_APP_ID"],
  };
  delete process.env["FYERS_ACCESS_TOKEN"];
  delete process.env["FYERS_APP_ID"];
  return () => {
    if (prev.FYERS_ACCESS_TOKEN !== undefined) {
      process.env["FYERS_ACCESS_TOKEN"] = prev.FYERS_ACCESS_TOKEN;
    }
    if (prev.FYERS_APP_ID !== undefined) {
      process.env["FYERS_APP_ID"] = prev.FYERS_APP_ID;
    }
  };
}

// ---------------------------------------------------------------------------
// 1. chunkDateRange — chunking math
// ---------------------------------------------------------------------------

describe("chunkDateRange", () => {
  it("returns a single chunk when range fits within maxDays", () => {
    const from = new Date("2024-01-01T00:00:00Z");
    const to = new Date("2024-01-10T00:00:00Z"); // 9-day range, cap=30
    const chunks = chunkDateRange(from, to, 30);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.from.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(chunks[0]!.to.toISOString()).toBe("2024-01-10T00:00:00.000Z");
  });

  it("splits a 60-day range into chunks not exceeding 30 days each", () => {
    const from = new Date("2024-01-01T00:00:00Z");
    // Jan 1 → Mar 1 = 60 days (Jan=31, Feb=29 in 2024 leap year)
    const to = new Date("2024-03-01T00:00:00Z");

    const chunks = chunkDateRange(from, to, 30);

    // With maxDays=30, chunk1: Jan1-Jan30 (30 inclusive days),
    // chunk2: Jan31-Feb29 (30 inclusive days), chunk3: Mar1-Mar1 (1 day) = 3 chunks.
    // The algorithm splits at 30-day boundaries, so a 60-day range yields 3 chunks,
    // not 2, because each chunk covers [from, from+29days] inclusive.
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.from.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(chunks[0]!.to.toISOString()).toBe("2024-01-30T00:00:00.000Z");
    expect(chunks[1]!.from.toISOString()).toBe("2024-01-31T00:00:00.000Z");
    expect(chunks[1]!.to.toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(chunks[2]!.from.toISOString()).toBe("2024-03-01T00:00:00.000Z");
    expect(chunks[2]!.to.toISOString()).toBe("2024-03-01T00:00:00.000Z");
  });

  it("splits exactly 30 days into a single chunk (30-day range fits within a 30-day cap)", () => {
    // Jan 1 to Jan 30 = 30 inclusive days → 1 chunk (fits within maxDays=30)
    const from = new Date("2024-01-01T00:00:00Z");
    const to = new Date("2024-01-30T00:00:00Z");

    const chunks = chunkDateRange(from, to, 30);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.from.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(chunks[0]!.to.toISOString()).toBe("2024-01-30T00:00:00.000Z");
  });

  it("splits a 91-day range into adjacent chunks each at most 30 days wide", () => {
    const from = new Date("2024-01-01T00:00:00Z");
    const to = new Date("2024-04-01T00:00:00Z"); // 91 days from Jan 1 to Apr 1

    const chunks = chunkDateRange(from, to, 30);

    // Jan 1→Apr 1 = 91 days. Chunk boundaries at 30-day inclusive intervals:
    // chunk1: Jan 1→Jan 30, chunk2: Jan 31→Feb 29, chunk3: Mar 1→Mar 30,
    // chunk4: Mar 31→Apr 1 = 4 chunks total.
    expect(chunks).toHaveLength(4);

    // Verify adjacent chunks: no overlap and no gap (consecutive days)
    for (let i = 1; i < chunks.length; i++) {
      const prevTo = chunks[i - 1]!.to.getTime();
      const currFrom = chunks[i]!.from.getTime();
      expect(currFrom - prevTo).toBe(24 * 60 * 60 * 1000); // exactly 1 day apart
    }

    // Last chunk ends at exactly 'to'
    expect(chunks[chunks.length - 1]!.to.toISOString()).toBe("2024-04-01T00:00:00.000Z");

    // Every chunk width must not exceed maxDays
    for (const chunk of chunks) {
      const widthDays = (chunk.to.getTime() - chunk.from.getTime()) / (24 * 60 * 60 * 1000) + 1;
      expect(widthDays).toBeLessThanOrEqual(30);
    }
  });

  it("returns an empty array when from is after to", () => {
    const from = new Date("2024-03-01T00:00:00Z");
    const to = new Date("2024-01-01T00:00:00Z");
    expect(chunkDateRange(from, to, 30)).toHaveLength(0);
  });

  it("returns a single 1-day chunk when from === to", () => {
    const from = new Date("2024-06-15T00:00:00Z");
    const to = new Date("2024-06-15T00:00:00Z");
    const chunks = chunkDateRange(from, to, 30);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.from.toISOString()).toBe("2024-06-15T00:00:00.000Z");
    expect(chunks[0]!.to.toISOString()).toBe("2024-06-15T00:00:00.000Z");
  });

  it("RESOLUTION_DAY_CAPS values are all positive integers", () => {
    const resolutions = Object.keys(RESOLUTION_DAY_CAPS) as FyersResolution[];
    for (const res of resolutions) {
      const cap = RESOLUTION_DAY_CAPS[res];
      expect(cap).toBeGreaterThan(0);
      expect(Number.isInteger(cap)).toBe(true);
    }
  });

  it("365-day range with daily resolution fits in a single chunk", () => {
    const from = new Date("2023-01-01T00:00:00Z");
    const to = new Date("2023-12-31T00:00:00Z");
    const chunks = chunkDateRange(from, to, RESOLUTION_DAY_CAPS["D"]);
    // 364 days < 365 cap, so exactly 1 chunk
    expect(chunks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. HTTP 429 — exponential backoff
// ---------------------------------------------------------------------------

describe("fetchHistoricalCandles — HTTP 429 backoff", () => {
  let cleanupEnv: () => void;

  beforeEach(() => {
    cleanupEnv = setFyersEnv();
    noopSleep.mockClear();
  });

  afterEach(() => {
    cleanupEnv();
  });

  it("retries on 429 and succeeds before MAX_RETRIES", async () => {
    // Return 429 twice, then a successful response
    const candles = [candle(toEpochSec("2024-01-01T09:15:00Z"))];
    let callCount = 0;
    const rawMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) return httpStatusResponse(429);
      return okResponse(candles);
    });
    const mockFetch = asFetchFn(rawMock);

    const result = await fetchHistoricalCandles(null, {
      symbol: "NSE:NIFTY50-INDEX",
      resolution: "D",
      from: new Date("2024-01-01T00:00:00Z"),
      to: new Date("2024-01-01T00:00:00Z"),
      fetchFn: mockFetch,
      sleepFn: noopSleep,
    });

    // 2 retries + 1 success = 3 fetch calls
    expect(rawMock).toHaveBeenCalledTimes(3);
    // sleepFn called for each retry
    expect(noopSleep).toHaveBeenCalledTimes(2);
    expect(result.candles).toHaveLength(1);
  });

  it("throws FyersRateLimitError after MAX_RETRIES (5) exhausted", async () => {
    // Always return 429
    const rawMock = vi.fn().mockResolvedValue(httpStatusResponse(429));
    const mockFetch = asFetchFn(rawMock);

    await expect(
      fetchHistoricalCandles(null, {
        symbol: "NSE:NIFTY50-INDEX",
        resolution: "D",
        from: new Date("2024-01-01T00:00:00Z"),
        to: new Date("2024-01-01T00:00:00Z"),
        fetchFn: mockFetch,
        sleepFn: noopSleep,
      }),
    ).rejects.toThrow(FyersRateLimitError);

    // MAX_RETRIES=5: attempts 0..5 = 6 fetch calls total
    // (attempt 5 is the last try that receives 429 and throws)
    expect(rawMock).toHaveBeenCalledTimes(6);
    // Sleep called 5 times (for attempts 0..4; attempt 5 throws without sleeping)
    expect(noopSleep).toHaveBeenCalledTimes(5);
  });

  it("FyersRateLimitError carries the attempt count", async () => {
    const rawMock = vi.fn().mockResolvedValue(httpStatusResponse(429));
    const mockFetch = asFetchFn(rawMock);

    let err: FyersRateLimitError | undefined;
    try {
      await fetchHistoricalCandles(null, {
        symbol: "NSE:NIFTY50-INDEX",
        resolution: "D",
        from: new Date("2024-01-01T00:00:00Z"),
        to: new Date("2024-01-01T00:00:00Z"),
        fetchFn: mockFetch,
        sleepFn: noopSleep,
      });
    } catch (e) {
      if (e instanceof FyersRateLimitError) err = e;
    }

    expect(err).toBeDefined();
    expect(err!.attemptsExhausted).toBe(6); // MAX_RETRIES + 1 = 6
  });
});

// ---------------------------------------------------------------------------
// 3. HTTP 401 — FyersAuthError with lastSuccessfulCutoff (mid-fetch)
// ---------------------------------------------------------------------------

describe("fetchHistoricalCandles — HTTP 401 auth failure mid-fetch", () => {
  let cleanupEnv: () => void;

  beforeEach(() => {
    cleanupEnv = setFyersEnv();
  });

  afterEach(() => {
    cleanupEnv();
  });

  it("throws FyersAuthError with null cutoff when first chunk returns 401", async () => {
    const rawMock = vi.fn().mockResolvedValue(httpStatusResponse(401));
    const mockFetch = asFetchFn(rawMock);

    let err: FyersAuthError | undefined;
    try {
      await fetchHistoricalCandles(null, {
        symbol: "NSE:NIFTY50-INDEX",
        resolution: "D",
        from: new Date("2024-01-01T00:00:00Z"),
        to: new Date("2024-01-31T00:00:00Z"),
        fetchFn: mockFetch,
        sleepFn: noopSleep,
      });
    } catch (e) {
      if (e instanceof FyersAuthError) err = e;
    }

    expect(err).toBeDefined();
    expect(err!.name).toBe("FyersAuthError");
    // No candles fetched before failure → cutoff is null
    expect(err!.lastSuccessfulCutoff).toBeNull();
    expect(err!.message).toContain("restart from the beginning");
  });

  it("throws FyersAuthError with cutoff set to last candle when second chunk returns 401", async () => {
    // First chunk: succeeds with one candle
    const firstChunkCandleTs = toEpochSec("2024-01-15T09:15:00Z");
    const firstChunkCandles = [candle(firstChunkCandleTs)];

    let callCount = 0;
    const rawMock = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // First chunk: success
        return okResponse(firstChunkCandles);
      }
      // Second chunk: auth failure
      return httpStatusResponse(401);
    });
    const mockFetch = asFetchFn(rawMock);

    let err: FyersAuthError | undefined;
    try {
      // Use a range that forces 2 chunks: resolution "1" has 30-day cap,
      // 31-day range (Jan 1 → Jan 31) = 2 chunks
      await fetchHistoricalCandles(null, {
        symbol: "NSE:NIFTY50-INDEX",
        resolution: "1",
        from: new Date("2024-01-01T00:00:00Z"),
        to: new Date("2024-01-31T00:00:00Z"),
        fetchFn: mockFetch,
        sleepFn: noopSleep,
      });
    } catch (e) {
      if (e instanceof FyersAuthError) err = e;
    }

    expect(err).toBeDefined();
    // lastSuccessfulCutoff should be the timestamp of the last candle from chunk 1
    expect(err!.lastSuccessfulCutoff).toBeInstanceOf(Date);
    expect(err!.lastSuccessfulCutoff!.getTime()).toBe(firstChunkCandleTs * 1000);
    expect(err!.message).toContain("resume from this point");
    expect(err!.message).toContain("2024-01-15");
  });

  it("FyersAuthError is an instance of Error (subclass check)", () => {
    const err = new FyersAuthError("test message", null);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FyersAuthError);
  });
});

// ---------------------------------------------------------------------------
// 4. Fyers-level auth error (HTTP 200, s="error", token message)
// ---------------------------------------------------------------------------

describe("fetchHistoricalCandles — Fyers-level auth error", () => {
  let cleanupEnv: () => void;

  beforeEach(() => {
    cleanupEnv = setFyersEnv();
  });

  afterEach(() => {
    cleanupEnv();
  });

  it("treats s=error with 'token' in message as FyersAuthError", async () => {
    const mockFetch = asFetchFn(
      vi.fn().mockResolvedValue(apiErrorResponse("Invalid token", 16)),
    );

    await expect(
      fetchHistoricalCandles(null, {
        symbol: "NSE:NIFTY50-INDEX",
        resolution: "D",
        from: new Date("2024-01-01T00:00:00Z"),
        to: new Date("2024-01-01T00:00:00Z"),
        fetchFn: mockFetch,
        sleepFn: noopSleep,
      }),
    ).rejects.toThrow(FyersAuthError);
  });

  it("treats s=error with code=16 as FyersAuthError (Fyers token-expiry code)", async () => {
    const mockFetch = asFetchFn(
      vi.fn().mockResolvedValue(apiErrorResponse("Session expired", 16)),
    );

    await expect(
      fetchHistoricalCandles(null, {
        symbol: "NSE:NIFTY50-INDEX",
        resolution: "D",
        from: new Date("2024-01-01T00:00:00Z"),
        to: new Date("2024-01-01T00:00:00Z"),
        fetchFn: mockFetch,
        sleepFn: noopSleep,
      }),
    ).rejects.toThrow(FyersAuthError);
  });

  it("treats s=error with non-auth message as a generic Error (not FyersAuthError)", async () => {
    const rawMock = vi.fn().mockResolvedValue(apiErrorResponse("Symbol not found", 404));
    const mockFetch = asFetchFn(rawMock);

    await expect(
      fetchHistoricalCandles(null, {
        symbol: "NSE:INVALIDSYM",
        resolution: "D",
        from: new Date("2024-01-01T00:00:00Z"),
        to: new Date("2024-01-01T00:00:00Z"),
        fetchFn: mockFetch,
        sleepFn: noopSleep,
      }),
    ).rejects.toThrow("Fyers history API error");

    // Must NOT be an FyersAuthError
    let caught: unknown;
    try {
      await fetchHistoricalCandles(null, {
        symbol: "NSE:INVALIDSYM",
        resolution: "D",
        from: new Date("2024-01-01T00:00:00Z"),
        to: new Date("2024-01-01T00:00:00Z"),
        fetchFn: asFetchFn(vi.fn().mockResolvedValue(apiErrorResponse("Symbol not found", 404))),
        sleepFn: noopSleep,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeInstanceOf(FyersAuthError);
  });
});

// ---------------------------------------------------------------------------
// 5. Missing-strike gap marker — empty chunk produces FyersCandleGap
// ---------------------------------------------------------------------------

describe("fetchHistoricalCandles — gap markers for empty chunks", () => {
  let cleanupEnv: () => void;

  beforeEach(() => {
    cleanupEnv = setFyersEnv();
  });

  afterEach(() => {
    cleanupEnv();
  });

  it("records a gap when a chunk returns zero candles", async () => {
    // Fyers returns s=ok but candles=[] (strike not listed, market closed, etc.)
    const mockFetch = asFetchFn(vi.fn().mockResolvedValue(okResponse([])));

    const result = await fetchHistoricalCandles(null, {
      symbol: "NSE:NIFTY2412523000CE",
      resolution: "D",
      from: new Date("2024-01-01T00:00:00Z"),
      to: new Date("2024-01-05T00:00:00Z"),
      fetchFn: mockFetch,
      sleepFn: noopSleep,
    });

    // No candles returned
    expect(result.candles).toHaveLength(0);
    // One gap recorded (the entire range returned zero candles)
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]!.from.toISOString()).toBe("2024-01-01T00:00:00.000Z");
    expect(result.gaps[0]!.to.toISOString()).toBe("2024-01-05T00:00:00.000Z");
    // Gap reason should be non-empty and descriptive
    expect(result.gaps[0]!.reason.length).toBeGreaterThan(10);
  });

  it("records a gap for each empty chunk in a multi-chunk range", async () => {
    // Two chunks: first returns data, second returns empty (strike expired)
    let callCount = 0;
    const candleTs = toEpochSec("2024-01-15T09:15:00Z");
    const mockFetch = asFetchFn(
      vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return okResponse([candle(candleTs)]);
        return okResponse([]);
      }),
    );

    // 31-day range with 30-day cap → 2 chunks
    const result = await fetchHistoricalCandles(null, {
      symbol: "NSE:NIFTY2412523000CE",
      resolution: "1",
      from: new Date("2024-01-01T00:00:00Z"),
      to: new Date("2024-01-31T00:00:00Z"),
      fetchFn: mockFetch,
      sleepFn: noopSleep,
    });

    expect(result.candles).toHaveLength(1);
    // One gap for the second chunk
    expect(result.gaps).toHaveLength(1);
  });

  it("returns zero gaps and all candles when no chunk is empty", async () => {
    const candleTs = toEpochSec("2024-01-10T09:15:00Z");
    const mockFetch = asFetchFn(vi.fn().mockResolvedValue(okResponse([candle(candleTs)])));

    const result = await fetchHistoricalCandles(null, {
      symbol: "NSE:NIFTY50-INDEX",
      resolution: "D",
      from: new Date("2024-01-01T00:00:00Z"),
      to: new Date("2024-01-10T00:00:00Z"),
      fetchFn: mockFetch,
      sleepFn: noopSleep,
    });

    expect(result.gaps).toHaveLength(0);
    expect(result.candles).toHaveLength(1);
  });

  it("gap result never contains fabricated or zero-filled candles", async () => {
    // Empty response — no candles should appear in result regardless
    const mockFetch = asFetchFn(vi.fn().mockResolvedValue(okResponse([])));

    const result = await fetchHistoricalCandles(null, {
      symbol: "NSE:NIFTY2412523000CE",
      resolution: "D",
      from: new Date("2024-01-01T00:00:00Z"),
      to: new Date("2024-01-10T00:00:00Z"),
      fetchFn: mockFetch,
      sleepFn: noopSleep,
    });

    // Absolutely no candles — no zero-fill
    expect(result.candles).toHaveLength(0);
    // No candle has open=0, high=0, etc. — zero-fill guard
    for (const c of result.candles) {
      expect(c.open).not.toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. No-creds loud failure
// ---------------------------------------------------------------------------

describe("fetchHistoricalCandles — no credentials loud failure", () => {
  let cleanupEnv: () => void;

  beforeEach(() => {
    cleanupEnv = clearFyersEnv();
  });

  afterEach(() => {
    cleanupEnv();
  });

  it("throws FyersNoCredentialsError when env vars are absent and db is null", async () => {
    const rawMock = vi.fn();
    const mockFetch = asFetchFn(rawMock);

    await expect(
      fetchHistoricalCandles(null, {
        symbol: "NSE:NIFTY50-INDEX",
        resolution: "D",
        from: new Date("2024-01-01T00:00:00Z"),
        to: new Date("2024-01-01T00:00:00Z"),
        fetchFn: mockFetch,
        sleepFn: noopSleep,
      }),
    ).rejects.toThrow(FyersNoCredentialsError);

    // Should fail before making any network calls
    expect(rawMock).not.toHaveBeenCalled();
  });

  it("FyersNoCredentialsError is an instance of Error", () => {
    const err = new FyersNoCredentialsError();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FyersNoCredentialsError);
    expect(err.name).toBe("FyersNoCredentialsError");
  });

  it("FyersNoCredentialsError message includes guidance on how to fix", () => {
    const err = new FyersNoCredentialsError();
    // Message should mention both credential sources
    expect(err.message).toContain("FYERS_ACCESS_TOKEN");
    expect(err.message).toContain("FYERS_APP_ID");
  });

  it("throws immediately — does NOT return empty candles silently", async () => {
    const mockFetch = asFetchFn(vi.fn().mockResolvedValue(okResponse([])));

    let threw = false;
    let result: unknown;
    try {
      result = await fetchHistoricalCandles(null, {
        symbol: "NSE:NIFTY50-INDEX",
        resolution: "D",
        from: new Date("2024-01-01T00:00:00Z"),
        to: new Date("2024-01-01T00:00:00Z"),
        fetchFn: mockFetch,
        sleepFn: noopSleep,
      });
    } catch {
      threw = true;
    }

    expect(threw).toBe(true);
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Successful multi-chunk fetch
// ---------------------------------------------------------------------------

describe("fetchHistoricalCandles — successful multi-chunk fetch", () => {
  let cleanupEnv: () => void;

  beforeEach(() => {
    cleanupEnv = setFyersEnv();
  });

  afterEach(() => {
    cleanupEnv();
  });

  it("assembles candles from two chunks correctly", async () => {
    const ts1 = toEpochSec("2024-01-15T09:15:00Z");
    const ts2 = toEpochSec("2024-02-15T09:15:00Z");

    let callCount = 0;
    const mockFetch = asFetchFn(
      vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return okResponse([candle(ts1)]);
        return okResponse([candle(ts2)]);
      }),
    );

    // 31-day range with 30-day cap → exactly 2 chunks
    const result = await fetchHistoricalCandles(null, {
      symbol: "NSE:NIFTY50-INDEX",
      resolution: "1",
      from: new Date("2024-01-01T00:00:00Z"),
      to: new Date("2024-01-31T00:00:00Z"),
      fetchFn: mockFetch,
      sleepFn: noopSleep,
    });

    expect(result.candles).toHaveLength(2);
    expect(result.candles[0]!.timestamp.getTime()).toBe(ts1 * 1000);
    expect(result.candles[1]!.timestamp.getTime()).toBe(ts2 * 1000);
    expect(result.gaps).toHaveLength(0);
  });

  it("meta.totalCandles matches actual candles returned", async () => {
    // Use mockImplementation to create a fresh Response per call (Response body
    // is a stream and can only be read once — mockResolvedValue with a single
    // Response would fail on the second chunk's res.json() call).
    const rawCandles = [
      candle(toEpochSec("2024-01-10T09:15:00Z")),
      candle(toEpochSec("2024-01-11T09:15:00Z")),
    ];
    const mockFetch = asFetchFn(
      vi.fn().mockImplementation(async () => okResponse(rawCandles)),
    );

    const result = await fetchHistoricalCandles(null, {
      symbol: "NSE:NIFTY50-INDEX",
      resolution: "D",
      from: new Date("2024-01-10T00:00:00Z"),
      to: new Date("2024-01-11T00:00:00Z"),
      fetchFn: mockFetch,
      sleepFn: noopSleep,
    });

    expect(result.meta.totalCandles).toBe(result.candles.length);
    expect(result.meta.totalCandles).toBe(2);
  });

  it("meta.requestsMade equals the number of chunks for the range", async () => {
    // Use mockImplementation to create a fresh Response for each call.
    // Response bodies are readable streams — they can only be consumed once.
    // If mockResolvedValue returns the same Response object for both chunk
    // requests, the second res.json() call will fail because the body is
    // already consumed.
    const mockFetch = asFetchFn(
      vi.fn().mockImplementation(async () =>
        okResponse([candle(toEpochSec("2024-01-15T09:15:00Z"))]),
      ),
    );

    // 31-day range with 30-day cap → 2 chunks = 2 requests
    const result = await fetchHistoricalCandles(null, {
      symbol: "NSE:NIFTY50-INDEX",
      resolution: "1",
      from: new Date("2024-01-01T00:00:00Z"),
      to: new Date("2024-01-31T00:00:00Z"),
      fetchFn: mockFetch,
      sleepFn: noopSleep,
    });

    expect(result.meta.requestsMade).toBe(2);
  });

  it("meta.adjustedDataAssumption is always present and non-empty", async () => {
    // Use a single-day range so there is only one chunk and only one res.json() call.
    // (Response body is a stream — shared across calls, so multi-chunk tests need
    // mockImplementation instead of mockResolvedValue.)
    const mockFetch = asFetchFn(
      vi.fn().mockImplementation(async () =>
        okResponse([candle(toEpochSec("2024-01-10T09:15:00Z"))]),
      ),
    );

    const result = await fetchHistoricalCandles(null, {
      symbol: "NSE:NIFTY50-INDEX",
      resolution: "D",
      from: new Date("2024-01-10T00:00:00Z"),
      to: new Date("2024-01-10T00:00:00Z"),
      fetchFn: mockFetch,
      sleepFn: noopSleep,
    });

    expect(result.meta.adjustedDataAssumption).toBeTruthy();
    expect(result.meta.adjustedDataAssumption.length).toBeGreaterThan(20);
    // Should mention "adjusted" somewhere
    expect(result.meta.adjustedDataAssumption.toLowerCase()).toContain("adjust");
  });

  it("throws on invalid date range (from > to)", async () => {
    const rawMock = vi.fn();
    const mockFetch = asFetchFn(rawMock);

    await expect(
      fetchHistoricalCandles(null, {
        symbol: "NSE:NIFTY50-INDEX",
        resolution: "D",
        from: new Date("2024-03-01T00:00:00Z"),
        to: new Date("2024-01-01T00:00:00Z"), // from > to
        fetchFn: mockFetch,
        sleepFn: noopSleep,
      }),
    ).rejects.toThrow("must not be after");

    expect(rawMock).not.toHaveBeenCalled();
  });

  it("candle timestamps are converted from epoch seconds to Date correctly", async () => {
    // Fyers returns epoch seconds; our parseCandles should multiply by 1000.
    const epochSec = toEpochSec("2024-06-15T09:15:00Z");
    const mockFetch = asFetchFn(vi.fn().mockResolvedValue(okResponse([candle(epochSec)])));

    const result = await fetchHistoricalCandles(null, {
      symbol: "NSE:NIFTY50-INDEX",
      resolution: "D",
      from: new Date("2024-06-15T00:00:00Z"),
      to: new Date("2024-06-15T00:00:00Z"),
      fetchFn: mockFetch,
      sleepFn: noopSleep,
    });

    expect(result.candles[0]!.timestamp.getTime()).toBe(epochSec * 1000);
    expect(result.candles[0]!.timestamp).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// 8. Malformed candle tuple — graceful handling
// ---------------------------------------------------------------------------

describe("fetchHistoricalCandles — malformed candle tuples", () => {
  let cleanupEnv: () => void;

  beforeEach(() => {
    cleanupEnv = setFyersEnv();
  });

  afterEach(() => {
    cleanupEnv();
  });

  it("skips candles with fewer than 6 elements without crashing", async () => {
    const goodCandleTs = toEpochSec("2024-01-15T09:15:00Z");
    // Mix of valid and invalid tuples
    const rawCandles: number[][] = [
      [goodCandleTs, 100, 105, 95, 102, 1000], // valid
      [0, 100, 105],                             // too short (only 3 elements) — skipped
      [toEpochSec("2024-01-16T09:15:00Z"), 200, 210, 190, 205, 2000], // valid
    ];

    const mockFetch = asFetchFn(vi.fn().mockResolvedValue(okResponse(rawCandles)));

    const result = await fetchHistoricalCandles(null, {
      symbol: "NSE:NIFTY50-INDEX",
      resolution: "D",
      from: new Date("2024-01-15T00:00:00Z"),
      to: new Date("2024-01-16T00:00:00Z"),
      fetchFn: mockFetch,
      sleepFn: noopSleep,
    });

    // Only 2 valid candles should be returned (malformed tuple skipped)
    expect(result.candles).toHaveLength(2);
    expect(result.candles[0]!.timestamp.getTime()).toBe(goodCandleTs * 1000);
  });

  it("handles null volume gracefully (treats as 0, does not crash)", async () => {
    // Fyers occasionally sends null for volume on illiquid instruments.
    // We need to cast here because TypeScript types say number[], but Fyers
    // can send null at the wire level.
    const rawCandles = [
      [toEpochSec("2024-01-15T09:15:00Z"), 100, 105, 95, 102, null],
    ] as unknown as number[][];

    const mockFetch = asFetchFn(vi.fn().mockResolvedValue(okResponse(rawCandles)));

    const result = await fetchHistoricalCandles(null, {
      symbol: "NSE:NIFTY50-INDEX",
      resolution: "D",
      from: new Date("2024-01-15T00:00:00Z"),
      to: new Date("2024-01-15T00:00:00Z"),
      fetchFn: mockFetch,
      sleepFn: noopSleep,
    });

    // Candle should be present with volume=0 (not crashed or skipped)
    expect(result.candles).toHaveLength(1);
    expect(result.candles[0]!.volume).toBe(0);
    // Price fields should remain intact
    expect(result.candles[0]!.open).toBe(100);
    expect(result.candles[0]!.close).toBe(102);
  });
});
