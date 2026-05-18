/**
 * VixFeed — NSE public API polling fallback for India VIX.
 *
 * The primary VIX source is the broker WebSocket tick for
 * 'NSE:INDIAVIX-INDEX'. This module provides a polling fallback that
 * queries the NSE public API directly. It fills gaps when the broker feed
 * is stale or disconnected (e.g. pre-market, post-market, or during
 * connection interruptions).
 *
 * Caller contract:
 *   - latestVix may be up to pollIntervalMs stale at any point in time.
 *   - latestVix is null until the first successful poll completes.
 *   - Callers must handle null — VIX is best-effort; trading continues
 *     without it.
 *
 * NEVER call setInterval, setTimeout, or Date.now() directly in this file.
 * All time operations must go through the injected Clock instance.
 */

import type { ClockWithTick } from "../utils/clock.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Alias kept for backward compatibility — use ClockWithTick from utils/clock.ts. */
export type VixClock = ClockWithTick;

/** Constructor options for VixFeed. */
export interface VixFeedOptions {
  /** Clock used for all time access and tick scheduling. */
  clock: VixClock;
  /**
   * How often (in milliseconds) to poll the NSE public API.
   * Defaults to 60_000ms (1 minute) — NSE VIX moves slowly enough that
   * 1-minute resolution is sufficient for signal probability adjustments.
   */
  pollIntervalMs?: number;
}

/**
 * Shape of one entry in the NSE allIndices API response array.
 * We only declare the fields we use to avoid coupling to undocumented fields
 * that NSE may add or rename without notice.
 */
interface NseIndexEntry {
  indexSymbol: string;
  last: string; // NSE returns the value as a string, not a number
}

/** Shape of the NSE allIndices API response envelope. */
interface NseAllIndicesResponse {
  data: NseIndexEntry[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * NSE public API endpoint for all indices, including India VIX.
 * This endpoint is unauthenticated but requires a User-Agent header and
 * is rate-limited by NSE. One request per minute is well within limits.
 */
const NSE_ALL_INDICES_URL = "https://www.nseindia.com/api/allIndices";

/**
 * The indexSymbol value for India VIX in the NSE API response.
 * Used for exact-match lookup in the returned array.
 */
const INDIA_VIX_SYMBOL = "INDIA VIX";

/**
 * HTTP headers required by the NSE public API.
 * NSE blocks requests without a browser-like User-Agent (returns 401/403).
 * Including Accept: application/json is good practice even though NSE
 * always returns JSON from this endpoint.
 */
// Using Record<string, string> rather than HeadersInit because HeadersInit is
// a browser DOM type that is not guaranteed to be in scope under Bun's strict
// TypeScript config. Record<string, string> is equally correct for a plain
// header object passed to fetch().
const NSE_HEADERS: Record<string, string> = {
  "User-Agent": "Mozilla/5.0",
  Accept: "application/json",
};

// ---------------------------------------------------------------------------
// VixFeed
// ---------------------------------------------------------------------------

/**
 * Polls the NSE public API for the India VIX value at a configurable interval.
 *
 * Usage (production):
 *   const clock = new RealClockWithTick(); // or any Clock & { tick() }
 *   const feed = new VixFeed({ clock });
 *   feed.start();
 *   // later:
 *   const vix = feed.getVix(); // string | null
 *   feed.stop();
 *
 * Usage (testing with VirtualClock):
 *   const clock = new VirtualClock(Date.now());
 *   const feed = new VixFeed({ clock, pollIntervalMs: 1000 });
 *   feed.start();
 *   clock.advance(1000); // triggers one poll (against a mocked fetch)
 */
export class VixFeed {
  private readonly _clock: VixClock;
  private readonly _pollIntervalMs: number;

  /**
   * The most recently received India VIX value from the NSE API.
   * Null until the first successful poll, or after a parse/network failure
   * clears it (we preserve the last good value on failure — see _poll()).
   */
  private _latestVix: string | null = null;

  /**
   * Running flag — prevents double-start and allows stop() to suppress
   * callbacks after the polling loop is cancelled.
   *
   * VirtualClock has no tick deregistration API, so the same guard-flag
   * pattern used in MarketDataSimulator is used here: the callback checks
   * _running before doing any work, meaning clock.advance() after stop()
   * will fire the callback but it will exit immediately.
   */
  private _running = false;

  constructor(options: VixFeedOptions) {
    this._clock = options.clock;
    // Default to 1 minute — India VIX moves slowly; 1-minute granularity
    // is sufficient for probability score adjustments and does not hammer NSE.
    this._pollIntervalMs = options.pollIntervalMs ?? 60_000;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Starts the VIX polling loop.
   * Idempotent — calling start() on an already-running feed is a no-op.
   */
  start(): void {
    if (this._running) {
      return;
    }
    this._running = true;

    // Register a recurring tick with the injected clock.
    // The clock fires the callback each time pollIntervalMs elapses.
    // We do NOT fire an immediate poll here on purpose: the first poll fires
    // after one interval, giving the caller time to set up consumers before
    // data arrives — mirroring the MarketDataSimulator pattern.
    this._clock.tick(this._pollIntervalMs, () => {
      // Guard: if stop() was called after this tick was registered, ignore
      // the callback. VirtualClock cannot deregister ticks, so this flag is
      // the only cancellation mechanism available.
      if (!this._running) {
        return;
      }
      // _poll() returns a Promise but we intentionally do not await it here.
      // The tick callback is synchronous; we fire-and-forget the async HTTP
      // request. Errors are caught inside _poll() and logged as warnings —
      // they never propagate to the clock's tick mechanism.
      void this._poll();
    });
  }

  /**
   * Stops the VIX polling loop.
   * After stop(), no further polls are performed even if the clock advances.
   * The last known VIX value is preserved in latestVix.
   * Idempotent — safe to call multiple times.
   */
  stop(): void {
    this._running = false;
  }

  /**
   * Returns the most recently received India VIX value, or null if no
   * successful poll has completed yet (or if the feed has never been started).
   *
   * The returned value is a string — NSE returns VIX as a string (e.g. "14.75")
   * and we preserve it as-is to avoid precision loss from float parsing.
   * Callers that need numeric comparison should parse with parseFloat().
   */
  getVix(): string | null {
    return this._latestVix;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Performs a single HTTP GET to the NSE allIndices endpoint, parses the
   * response, and updates latestVix.
   *
   * Error handling policy:
   *   - Any HTTP error (4xx, 5xx, network failure) → log warning, preserve
   *     last known VIX value, return without throwing.
   *   - Any parse error (malformed JSON, missing field) → same: log warning,
   *     preserve last known value, return without throwing.
   *
   * VIX is best-effort: the trading loop must never depend on VIX being
   * non-null. A stale or null VIX falls back to the baseline probability
   * adjustment (no VIX modifier applied).
   *
   * We preserve the last good value on failure rather than resetting to null
   * so that a single network blip doesn't cause probability scores to
   * momentarily lose their VIX modifier — a stale value is more useful than
   * null when the failure is transient.
   */
  private async _poll(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(NSE_ALL_INDICES_URL, {
        headers: NSE_HEADERS,
      });
    } catch (err) {
      // Network error (DNS failure, connection refused, timeout, etc.)
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`VIX poll failed: ${message}`);
      return;
    }

    if (!response.ok) {
      // HTTP error — NSE sometimes returns 401/403 when cookies are missing.
      // Log and return; preserve last known value.
      console.warn(`VIX poll failed: HTTP ${response.status} ${response.statusText}`);
      return;
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`VIX poll failed: JSON parse error — ${message}`);
      return;
    }

    // Validate top-level shape. We cannot trust external API responses to be
    // well-formed, so we narrow the type defensively before accessing fields.
    if (
      typeof json !== "object" ||
      json === null ||
      !("data" in json) ||
      !Array.isArray((json as { data: unknown }).data)
    ) {
      console.warn("VIX poll failed: unexpected response shape (missing data array)");
      return;
    }

    const body = json as NseAllIndicesResponse;

    // Find the India VIX entry in the array by exact symbol match.
    const vixEntry = body.data.find(
      (entry) =>
        typeof entry === "object" && entry !== null && entry.indexSymbol === INDIA_VIX_SYMBOL,
    );

    if (vixEntry === undefined) {
      console.warn(`VIX poll failed: '${INDIA_VIX_SYMBOL}' not found in response`);
      return;
    }

    if (typeof vixEntry.last !== "string" || vixEntry.last.trim() === "") {
      console.warn(`VIX poll failed: 'last' field is missing or empty for '${INDIA_VIX_SYMBOL}'`);
      return;
    }

    // Successful poll — update the stored value.
    this._latestVix = vixEntry.last;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Convenience factory for creating a VixFeed instance.
 * Equivalent to `new VixFeed(opts)` — provided as a named export to satisfy
 * the acceptance criterion for a static factory pattern without requiring
 * a static class method (which would complicate testing via constructor mocks).
 */
export function createVixFeed(opts: VixFeedOptions): VixFeed {
  return new VixFeed(opts);
}
