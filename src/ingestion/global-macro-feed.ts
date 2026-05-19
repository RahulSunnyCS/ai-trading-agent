/**
 * GlobalMacroFeed — polls Yahoo Finance for global macro context data.
 *
 * Fetches five instruments every MACRO_POLL_INTERVAL_MS (default 5 minutes):
 *   US VIX (^VIX), S&P 500 (^GSPC), DAX (^GDAXI), Crude Oil (CL=F), Gold (GC=F)
 *
 * Results are stored in Redis with a 15-minute TTL. getMacroContext() reads
 * from Redis and returns null for any instrument whose data has expired or
 * was never fetched.
 *
 * Poll window is restricted to IST hours (default 08:00–23:00) to avoid
 * burning network calls when US/EU markets are completely closed overnight.
 *
 * Note on clock usage:
 *   clock.now() is used ONLY for the poll-window time-of-day check (IST hour/minute).
 *   The actual poll interval timer uses setInterval (native Bun/Node timers),
 *   not clock.tick(), because this feed is designed for production use — it does
 *   not need VirtualClock-driven tests since we mock fetch() directly.
 */

import type { Redis } from "ioredis";
import type { Clock } from "../utils/clock.js";

// ---------------------------------------------------------------------------
// Re-export Clock so callers can reference it without reaching into utils/
// ---------------------------------------------------------------------------

export type { Clock };

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One instrument's current market data snapshot. */
export interface MacroDataPoint {
  /** Current market price. */
  value: number;
  /** Percentage change from the previous session close: ((price - prevClose) / prevClose) * 100 */
  change_pct: number;
  /** Epoch milliseconds at which this data point was recorded by our poll. */
  timestamp: number;
}

/**
 * Snapshot of all global macro instruments.
 * A field is null when the Redis key is absent (TTL expired or never populated).
 */
export interface MacroContext {
  us_vix: MacroDataPoint | null;
  sp500: MacroDataPoint | null;
  dax: MacroDataPoint | null;
  crude_oil: MacroDataPoint | null;
  gold: MacroDataPoint | null;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * The slice of the Yahoo Finance /v8/finance/chart response we need.
 * Only the fields we access are typed — YF adds many more fields that we ignore.
 */
interface YFResponse {
  chart: {
    result: Array<{
      meta: {
        regularMarketPrice: number;
        regularMarketPreviousClose: number;
      };
    }> | null;
    error: unknown;
  };
}

/** Mapping from our internal instrument key to the Yahoo Finance ticker symbol. */
interface InstrumentDef {
  key: keyof MacroContext;
  symbol: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The five instruments we poll. Order does not matter — all are fetched in
 * parallel via Promise.allSettled, so no instrument blocks another.
 */
const INSTRUMENTS: InstrumentDef[] = [
  { key: "us_vix", symbol: "^VIX" },
  { key: "sp500", symbol: "^GSPC" },
  { key: "dax", symbol: "^GDAXI" },
  { key: "crude_oil", symbol: "CL=F" },
  { key: "gold", symbol: "GC=F" },
];

/**
 * Base URL for Yahoo Finance chart API.
 * interval=5m&range=1d gives us today's intraday data; we only read `meta`
 * fields (regularMarketPrice, regularMarketPreviousClose) which are always
 * present even on the 1d range. The 5m interval is the minimum that makes
 * the endpoint reliable — 1m is frequently throttled.
 */
const YF_BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart";

/**
 * Redis TTL for each stored macro data point.
 * 900 seconds (15 minutes) — data older than this is considered stale and
 * will be returned as null from getMacroContext(). The poll interval is
 * 5 minutes by default, so valid data is refreshed well before TTL expires.
 */
const REDIS_TTL_SECONDS = 900;

/**
 * HTTP request timeout: 5 seconds per instrument.
 * AbortSignal.timeout() is supported in Bun and modern Node.js environments.
 * If a single fetch hangs, we abort it and log a warning rather than blocking
 * the entire poll cycle.
 */
const FETCH_TIMEOUT_MS = 5000;

/** Maximum number of attempts per instrument (1 initial + 1 retry). */
const MAX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parses the poll window env vars once at module load.
 * Returns { startHour, startMinute, endHour, endMinute }.
 *
 * We parse at module load (not inside the class) so misconfigured env vars
 * surface at startup rather than being silently swallowed at poll time.
 */
function parsePollWindow(): {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
} {
  const startStr = process.env["MACRO_POLL_START"] ?? "08:00";
  const endStr = process.env["MACRO_POLL_END"] ?? "23:00";

  const [startHour = 8, startMinute = 0] = startStr.split(":").map(Number);
  const [endHour = 23, endMinute = 0] = endStr.split(":").map(Number);

  return { startHour, startMinute, endHour, endMinute };
}

const POLL_WINDOW = parsePollWindow();

/**
 * Returns true if the given epoch-ms timestamp falls within the configured
 * IST poll window.
 *
 * We use toLocaleString with Asia/Kolkata to get local IST time parts.
 * This correctly handles daylight saving (IST has no DST, but the Kolkata
 * zone entry is authoritative for the +05:30 offset).
 *
 * Exported for unit testing without instantiating the full class.
 */
export function isWithinPollWindow(nowMs: number): boolean {
  // toLocaleString returns e.g. "5/19/2026, 9:30:00 AM"
  // We parse hour and minute from the time portion.
  const istString = new Date(nowMs).toLocaleString("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  });

  // Format produced by hour12:false is e.g. "09:30" or "23:00"
  // Some runtimes may produce "24:00" for midnight — clamp to 23:59.
  const parts = istString.split(":");
  let hour = parseInt(parts[0] ?? "0", 10);
  const minute = parseInt(parts[1] ?? "0", 10);

  // Normalise "24" (rare but possible in some locale implementations)
  if (hour === 24) {
    hour = 0;
  }

  const nowMinutes = hour * 60 + minute;
  const startMinutes = POLL_WINDOW.startHour * 60 + POLL_WINDOW.startMinute;
  const endMinutes = POLL_WINDOW.endHour * 60 + POLL_WINDOW.endMinute;

  return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
}

/**
 * Fetches a single Yahoo Finance instrument with one retry on network error.
 *
 * Returns a MacroDataPoint on success or null on failure (logs a warning).
 * This function never throws — all errors are caught and returned as null.
 *
 * Retry policy: we retry only on network-level errors (fetch throws), not on
 * HTTP error status codes. A 429 (rate limit) or 404 (bad symbol) is not
 * retriable — retrying immediately would just trigger another rate-limit hit.
 */
async function fetchInstrument(
  symbol: string,
  nowMs: number,
): Promise<MacroDataPoint | null> {
  const url = `${YF_BASE_URL}/${encodeURIComponent(symbol)}?interval=5m&range=1d`;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;

    try {
      response = await fetch(url, {
        // AbortSignal.timeout is available in Bun and Node 18+.
        // It cancels the request if no response is received within FETCH_TIMEOUT_MS.
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          // Yahoo Finance rejects requests without a User-Agent.
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
        },
      });
    } catch (err) {
      // Network-level error: DNS failure, connection refused, timeout, etc.
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < MAX_ATTEMPTS) {
        // Retry once on transient network errors.
        console.warn(`[GlobalMacroFeed] ${symbol} fetch attempt ${attempt} failed: ${msg} — retrying`);
        continue;
      }
      console.warn(`[GlobalMacroFeed] ${symbol} fetch failed after ${MAX_ATTEMPTS} attempts: ${msg}`);
      return null;
    }

    // HTTP-level error: don't retry (rate limits, bad symbols are not transient).
    if (!response.ok) {
      console.warn(
        `[GlobalMacroFeed] ${symbol} HTTP ${response.status} ${response.statusText} — skipping`,
      );
      return null;
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[GlobalMacroFeed] ${symbol} JSON parse error: ${msg} — skipping`);
      return null;
    }

    // Defensive shape validation — external APIs can change their response
    // structure without notice.
    if (
      typeof json !== "object" ||
      json === null ||
      !("chart" in json)
    ) {
      console.warn(`[GlobalMacroFeed] ${symbol} unexpected response shape — skipping`);
      return null;
    }

    const yfResp = json as YFResponse;
    const result = yfResp.chart?.result;

    if (!Array.isArray(result) || result.length === 0) {
      console.warn(`[GlobalMacroFeed] ${symbol} empty or null result array — skipping`);
      return null;
    }

    const meta = result[0]?.meta;
    if (
      typeof meta?.regularMarketPrice !== "number" ||
      typeof meta?.regularMarketPreviousClose !== "number"
    ) {
      console.warn(`[GlobalMacroFeed] ${symbol} missing price fields in meta — skipping`);
      return null;
    }

    const price = meta.regularMarketPrice;
    const prevClose = meta.regularMarketPreviousClose;

    // Guard against divide-by-zero if prevClose is somehow 0.
    const change_pct =
      prevClose !== 0 ? ((price - prevClose) / prevClose) * 100 : 0;

    return {
      value: price,
      change_pct,
      timestamp: nowMs,
    };
  }

  // Should never reach here (loop always returns or continues), but TypeScript
  // requires a return statement after the loop.
  return null;
}

// ---------------------------------------------------------------------------
// GlobalMacroFeed
// ---------------------------------------------------------------------------

/**
 * Polls Yahoo Finance for global macro context and stores results in Redis.
 *
 * Usage (production):
 *   const feed = new GlobalMacroFeed(redisClient);
 *   feed.start();
 *   // later:
 *   const ctx = await getMacroContext(redisClient);
 *   feed.stop();
 *
 * Usage (testing):
 *   const fakeClock = { now: () => FIXED_EPOCH_MS };
 *   const feed = new GlobalMacroFeed(mockRedis, fakeClock);
 *   // Call _pollOnce() directly (or stub setInterval) to trigger one poll.
 */
export class GlobalMacroFeed {
  private _timer: ReturnType<typeof setInterval> | null = null;
  private readonly _intervalMs: number;

  constructor(
    private readonly redis: Redis,
    // Clock is injected for testability — the poll-window check calls clock.now().
    // We default to Date.now() so production callers don't need to pass anything.
    private readonly clock: Clock = { now: () => Date.now(), today: () => "", toISTDate: () => "", toISTTime: () => "" },
  ) {
    this._intervalMs = parseInt(
      process.env["MACRO_POLL_INTERVAL_MS"] ?? "300000",
      10,
    );

    // Validate interval to avoid creating a near-zero setInterval that floods
    // Yahoo Finance. Minimum 10 seconds; anything lower is a misconfiguration.
    if (isNaN(this._intervalMs) || this._intervalMs < 10_000) {
      console.warn(
        `[GlobalMacroFeed] MACRO_POLL_INTERVAL_MS invalid or too low — defaulting to 300000ms`,
      );
      // Reset to safe default. We reassign by casting through unknown because
      // _intervalMs is readonly and TypeScript enforces that in normal assignments.
      // Safe here: this is an initialisation-time guard only (constructor scope).
      (this as unknown as { _intervalMs: number })._intervalMs = 300_000;
    }
  }

  /**
   * Starts the poll loop using a real setInterval timer.
   * Idempotent — calling start() on an already-running feed is a no-op.
   *
   * Note: the first poll fires after one full interval (not immediately) to
   * avoid a burst of HTTP requests at startup. If the caller needs data
   * immediately, they should call getMacroContext() and handle the null case
   * while the first poll is pending.
   */
  start(): void {
    if (this._timer !== null) {
      return;
    }

    this._timer = setInterval(() => {
      // _doPoll() is async; we fire-and-forget intentionally.
      // Errors are caught inside _doPoll() and logged as warnings.
      void this._doPoll();
    }, this._intervalMs);
  }

  /**
   * Stops the poll loop.
   * Safe to call multiple times (idempotent).
   * Any poll already in-flight will complete normally; stop() only prevents
   * future polls from starting.
   */
  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Exposed for testing: trigger one poll cycle without waiting for the timer.
   * This is intentionally a public method rather than a private one so tests
   * can call it directly instead of needing to manipulate setInterval timing.
   */
  async _doPoll(): Promise<void> {
    // Skip silently outside the configured IST window.
    if (!isWithinPollWindow(this.clock.now())) {
      return;
    }

    const nowMs = this.clock.now();

    // Fetch all instruments in parallel. Promise.allSettled ensures that a
    // failure on one instrument does not prevent others from being stored.
    const results = await Promise.allSettled(
      INSTRUMENTS.map((inst) => fetchInstrument(inst.symbol, nowMs).then((dp) => ({ inst, dp }))),
    );

    // Store successful results in Redis.
    for (const settled of results) {
      if (settled.status === "rejected") {
        // fetchInstrument never rejects (all errors become null), but if
        // something unexpected propagates, log it.
        console.warn(
          `[GlobalMacroFeed] unexpected rejection in poll: ${settled.reason}`,
        );
        continue;
      }

      const { inst, dp } = settled.value;
      if (dp === null) {
        // Already warned inside fetchInstrument — skip silently here.
        continue;
      }

      try {
        await this.redis.set(
          `macro:${inst.key}`,
          JSON.stringify(dp),
          "EX",
          REDIS_TTL_SECONDS,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[GlobalMacroFeed] Redis set failed for ${inst.key}: ${msg}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// getMacroContext
// ---------------------------------------------------------------------------

/**
 * Reads all five macro instrument keys from Redis and returns a MacroContext.
 *
 * Any key that is absent (TTL expired or never populated) returns null for
 * that field — the caller must handle nulls gracefully.
 *
 * This function never throws: any Redis or parse error for an individual key
 * is caught, logged as a warning, and returned as null for that field.
 */
export async function getMacroContext(redis: Redis): Promise<MacroContext> {
  const context: MacroContext = {
    us_vix: null,
    sp500: null,
    dax: null,
    crude_oil: null,
    gold: null,
  };

  // Fetch all five Redis keys in parallel. Each promise writes to a different
  // key on the shared context object — no write races because each iteration
  // targets a unique inst.key field. Promise.all is used (not allSettled)
  // because each callback already catches its own errors and never rejects.
  await Promise.all(
    INSTRUMENTS.map(async (inst) => {
      try {
        const raw = await redis.get(`macro:${inst.key}`);
        if (raw === null) {
          // Key not present in Redis (never set or TTL expired) — null is valid.
          return;
        }

        const parsed = JSON.parse(raw) as MacroDataPoint;

        // Basic shape check to guard against corrupted Redis values.
        if (
          typeof parsed.value !== "number" ||
          typeof parsed.change_pct !== "number" ||
          typeof parsed.timestamp !== "number"
        ) {
          console.warn(
            `[GlobalMacroFeed] getMacroContext: invalid shape for macro:${inst.key} — skipping`,
          );
          return;
        }

        context[inst.key] = parsed;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[GlobalMacroFeed] getMacroContext failed for ${inst.key}: ${msg}`);
      }
    }),
  );

  return context;
}
