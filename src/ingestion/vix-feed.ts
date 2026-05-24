/**
 * VIX Feed
 *
 * Provides India VIX values from two sources:
 *   - Primary:  Fyers tick feed — listens to the `market.ticks` Redis Stream
 *               for ticks with symbol `NSE:INDIAVIX-INDEX` and publishes them
 *               immediately.
 *   - Fallback: NSE public API polling — every `pollIntervalMs` ms it hits the
 *               NSE allIndices endpoint. It only publishes from the poll when
 *               no tick-sourced VIX was received in the last 5 minutes, to
 *               avoid flooding the stream with duplicate data.
 *
 * Design decisions:
 * - Non-blocking XREAD loop (no BLOCK) matches the straddle-calc pattern so the
 *   `running` flag is checked on every iteration, enabling a clean shutdown.
 * - A small sleep prevents a tight CPU spin on empty polls.
 * - `fetch` is Bun-native; an AbortController gives each NSE call a 5-second
 *   deadline.
 * - Using `||` (not `??`) for the NSE_VIX_URL fallback so that an explicitly
 *   exported empty-string env var also falls back to the constant default.
 */

import type { Redis } from 'ioredis';

import type { Clock } from '../utils/clock';
import { RealClock } from '../utils/clock';

// ---------------------------------------------------------------------------
// VIX symbol on Fyers tick feed
// ---------------------------------------------------------------------------

/** The Fyers symbol for India VIX on the market.ticks stream. */
const VIX_TICK_SYMBOL = 'NSE:INDIAVIX-INDEX';

/** How long (ms) a tick-based VIX reading suppresses the poll fallback. */
const TICK_FRESHNESS_MS = 5 * 60 * 1000; // 5 minutes

/** Timeout for each NSE API fetch call. */
const NSE_FETCH_TIMEOUT_MS = 5_000;

/** Default poll interval (1 minute). */
const DEFAULT_POLL_INTERVAL_MS = 60_000;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface VixReading {
  vix: number;
  timestamp: number; // Unix ms
  source: 'tick' | 'poll';
}

export interface VixFeedConfig {
  pollIntervalMs?: number;
  pollUrl?: string;
  clock?: Clock;
}

/** Alias for backward compatibility with milestones-0-1 branch code. */
export type VixFeedOptions = VixFeedConfig & { clock: Clock };

export interface VixFeed {
  start(): Promise<void>;
  stop(): Promise<void>;
  getLatestVix(): VixReading | null;
}

// ---------------------------------------------------------------------------
// Internal NSE API response types
// ---------------------------------------------------------------------------

interface NseIndexEntry {
  index: string;
  last: number;
}

interface NseApiResponse {
  data: NseIndexEntry[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a VixFeed bound to the provided Redis client and optional config.
 *
 * No side effects until `start()` is called.
 */
export function createVixFeed(redisClient: Redis, config?: VixFeedConfig): VixFeed {
  const clock: Clock = config?.clock ?? new RealClock();

  // Use || (not ??) so an empty string also falls back to the constant default.
  // process.env dot notation required by Biome; bracket notation is disallowed.
  const pollUrl =
    config?.pollUrl || process.env.NSE_VIX_URL || 'https://www.nseindia.com/api/allIndices';

  const pollIntervalMs = config?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // Control flags.
  let running = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // Last XREAD cursor — '$' means "only new messages from now on".
  let lastId = '$';

  // The most recently received VIX reading (either source).
  let latestVix: VixReading | null = null;

  // Timestamp (Unix ms) of the last VIX reading sourced from a tick.
  // Used to gate the NSE poll fallback: if we received a tick recently we skip
  // the poll publish to avoid duplicating data on the stream.
  let lastTickVixTimestamp: number | null = null;

  // ---------------------------------------------------------------------------
  // Tick parsing
  // ---------------------------------------------------------------------------

  /**
   * Parse a raw JSON `data` field from a market.ticks stream entry.
   * Returns null and logs a warning on malformed or incomplete input.
   * Uses `unknown` then narrows — never `any`.
   */
  function parseTickJson(raw: string): { symbol: string; ltp: number; timestamp: number } | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('[vix-feed] malformed JSON in tick, skipping:', raw);
      return null;
    }

    if (typeof parsed !== 'object' || parsed === null) {
      console.warn('[vix-feed] tick is not an object, skipping:', raw);
      return null;
    }

    // Narrow to a record so we can check individual field types safely.
    const obj = parsed as Record<string, unknown>;

    if (typeof obj.symbol !== 'string' || typeof obj.ltp !== 'number') {
      console.warn('[vix-feed] tick missing required fields (symbol/ltp), skipping:', raw);
      return null;
    }

    // Accept either `timestamp` or `time` field conventions
    const timestamp =
      typeof obj.timestamp === 'number'
        ? obj.timestamp
        : typeof obj.time === 'number'
          ? obj.time
          : (clock.timestamp?.() ?? clock.now());

    return { symbol: obj.symbol, ltp: obj.ltp, timestamp };
  }

  // ---------------------------------------------------------------------------
  // Publish helper
  // ---------------------------------------------------------------------------

  /**
   * Publish a VixReading to the `market.vix` Redis stream and update latestVix.
   */
  async function publishVix(reading: VixReading): Promise<void> {
    latestVix = reading;
    try {
      await redisClient.xadd('market.vix', '*', 'data', JSON.stringify(reading));
    } catch (err) {
      console.error('[vix-feed] failed to publish VIX reading to Redis:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Tick reader loop
  // ---------------------------------------------------------------------------

  /**
   * Non-blocking XREAD loop that watches `market.ticks` for VIX ticks.
   *
   * Runs until `running` is set to false by `stop()`.  Errors are caught and
   * logged; the loop resumes after a brief pause so transient Redis hiccups do
   * not crash the feed.
   */
  async function tickReaderLoop(): Promise<void> {
    while (running) {
      try {
        // Non-blocking XREAD — no BLOCK option so we check `running` each iteration.
        const results = await redisClient.xread('COUNT', 100, 'STREAMS', 'market.ticks', lastId);

        if (!results || results.length === 0) {
          await sleep(100);
          continue;
        }

        // results shape: [ [ streamName, [ [id, [field, value, ...]], ... ] ] ]
        const streamResult = results[0];
        if (!streamResult) {
          await sleep(100);
          continue;
        }

        // Cast to the known ioredis XREAD shape.
        const entries = streamResult[1] as [string, string[]][];

        for (const entry of entries) {
          const id = entry[0];
          const rawFields = entry[1];
          if (!id || !rawFields) continue;

          // Advance cursor so we never re-read already-processed messages.
          lastId = id;

          // Extract the `data` field (linear field-value pairs).
          let rawData: string | undefined;
          for (let i = 0; i + 1 < rawFields.length; i += 2) {
            if (rawFields[i] === 'data') {
              rawData = rawFields[i + 1];
              break;
            }
          }

          if (rawData === undefined) {
            console.warn('[vix-feed] stream entry missing `data` field, id:', id);
            continue;
          }

          const tick = parseTickJson(rawData);
          if (tick === null) continue;

          // Only care about the VIX symbol.
          if (tick.symbol !== VIX_TICK_SYMBOL) continue;

          const now = clock.timestamp?.() ?? clock.now();
          const reading: VixReading = {
            vix: tick.ltp,
            timestamp: now,
            source: 'tick',
          };

          lastTickVixTimestamp = now;
          await publishVix(reading);
        }
      } catch (err) {
        // Log and resume — transient Redis errors must not crash the loop.
        console.error('[vix-feed] error in tick reader loop:', err);
        await sleep(100);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // NSE API poll fallback
  // ---------------------------------------------------------------------------

  /**
   * Validate that the parsed NSE API response has the expected shape.
   * Returns a typed NseApiResponse or null when the shape doesn't match.
   *
   * Separate from parsing so malformed but valid JSON is handled distinctly.
   */
  function parseNseResponse(body: unknown): NseApiResponse | null {
    if (typeof body !== 'object' || body === null) return null;
    const obj = body as Record<string, unknown>;
    if (!Array.isArray(obj.data)) return null;

    // Validate every element has `index` (string) and `last` (number).
    // We do a best-effort cast; elements that don't match are filtered out
    // downstream when we search for INDIA VIX.
    return { data: obj.data as NseIndexEntry[] };
  }

  /**
   * Poll the NSE API once.  Publishes to `market.vix` only when no tick-based
   * VIX was received in the last TICK_FRESHNESS_MS, preventing duplicate noise.
   *
   * Errors are caught and logged — this function must never throw.
   */
  async function pollNse(): Promise<void> {
    // If a fresh tick-based VIX arrived recently, skip the poll publish.
    const now = clock.timestamp?.() ?? clock.now();
    if (lastTickVixTimestamp !== null && now - lastTickVixTimestamp < TICK_FRESHNESS_MS) {
      return;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, NSE_FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(pollUrl, {
        signal: controller.signal,
        headers: {
          // NSE requires a Referer header to avoid bot-detection rejections.
          // Without it the request often returns a 403 or redirect.
          Referer: 'https://www.nseindia.com',
          'User-Agent': 'Mozilla/5.0 (compatible; ai-trading-agent)',
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        console.warn(`[vix-feed] NSE API returned HTTP ${response.status}, skipping poll`);
        return;
      }

      const body: unknown = await response.json();
      const parsed = parseNseResponse(body);

      if (parsed === null) {
        console.warn('[vix-feed] NSE API response has unexpected shape, skipping poll');
        return;
      }

      // Find the INDIA VIX entry in the data array.
      const vixEntry = parsed.data.find(
        (entry) => typeof entry.index === 'string' && entry.index === 'INDIA VIX',
      );

      if (vixEntry === undefined) {
        console.warn('[vix-feed] NSE API response does not contain INDIA VIX entry, skipping poll');
        return;
      }

      // Validate `last` is a finite number before publishing.
      if (typeof vixEntry.last !== 'number' || !Number.isFinite(vixEntry.last)) {
        console.warn('[vix-feed] NSE VIX entry has invalid `last` value:', vixEntry.last);
        return;
      }

      const reading: VixReading = {
        vix: vixEntry.last,
        timestamp: clock.timestamp?.() ?? clock.now(),
        source: 'poll',
      };

      await publishVix(reading);
    } catch (err) {
      // Covers AbortError (timeout) and network failures.
      console.warn('[vix-feed] NSE API fetch failed, skipping poll:', err);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    async start(): Promise<void> {
      if (running) return;
      running = true;

      // Begin the tick reader loop (non-blocking — runs concurrently).
      void tickReaderLoop();

      // Schedule periodic NSE API polling.
      pollTimer = setInterval(() => {
        void pollNse();
      }, pollIntervalMs);
    },

    async stop(): Promise<void> {
      running = false;

      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      // The tick reader loop exits naturally on the next `while (running)` check.
    },

    getLatestVix(): VixReading | null {
      return latestVix;
    },
  };
}

// ---------------------------------------------------------------------------
// Internal sleep helper
// ---------------------------------------------------------------------------

/**
 * Promise-based sleep used in the tick reader loop to avoid a tight CPU spin
 * when no new messages are present in the Redis stream.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
