/**
 * Authoritative live expiry resolver for Fyers.
 *
 * Queries the Fyers option-chain endpoint to obtain the canonical list of
 * valid expiry dates per underlying and picks the nearest one that is still
 * open for trading. Falls back to the deterministic getCurrentExpiry() when
 * the network call fails (offline / sim mode / bad credentials), so the system
 * never crashes because of a missing live resolver.
 *
 * Security notes:
 *   - The endpoint URL is hardcoded (no caller-supplied URL) — SSRF guard.
 *   - Credentials are never logged (only the first 4 chars of the token).
 *   - The injectable fetchFn is for testing only; production uses the global fetch.
 *
 * Cache:
 *   A lightweight in-process cache keyed by `{underlying}:{IST-date}` ensures
 *   we call Fyers at most once per underlying per calendar day. Expiry dates do
 *   not change intraday so a per-day cache is correct and sufficient.
 *   Call clearExpiryCache() in tests to prevent cross-test pollution.
 */

import type { Clock } from '../../utils/clock';
import { RealClock } from '../../utils/clock';
import type { FetchFn } from './fyers-historical';
import { getCurrentExpiry, INDEX_SYMBOLS } from './instrument-registry';
import type { Underlying } from './types';

// ---------------------------------------------------------------------------
// Fixed endpoint — SSRF guard: never allow caller-supplied host/path
// ---------------------------------------------------------------------------

const FYERS_OPTION_CHAIN_HOST = 'https://api-t1.fyers.in';
const FYERS_OPTION_CHAIN_PATH = '/data/options-chain-v3';

// ---------------------------------------------------------------------------
// IST offset — constant, no DST in India
// ---------------------------------------------------------------------------

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// 15:30 IST cut-off — mirrors the logic in getCurrentExpiry()
// ---------------------------------------------------------------------------

/** Returns true if the given nowMs timestamp is at or past 15:30 IST. */
function isPastEOD(nowMs: number): boolean {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  return ist.getUTCHours() > 15 || (ist.getUTCHours() === 15 && ist.getUTCMinutes() >= 30);
}

/** Returns the IST calendar-date string 'YYYY-MM-DD' for the given epoch ms. */
function istDateKey(nowMs: number): string {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  // toISOString gives UTC — here we've already shifted to IST so UTC getters
  // return IST values. Build the string manually to avoid format quirks.
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------------------------------------------------------------------------
// In-process cache — keyed by "{underlying}:{IST-date}"
// ---------------------------------------------------------------------------

const _cache = new Map<string, Date>();

/**
 * Clear the expiry resolver cache.
 *
 * Call this in tests to prevent cross-test pollution from a cached expiry.
 * In production the cache is intentionally persistent for the process lifetime
 * (expiry dates do not change intraday, so a per-day key is correct).
 */
export function clearExpiryCache(): void {
  _cache.clear();
}

// ---------------------------------------------------------------------------
// Fyers option-chain response shape (internal — not exported)
// ---------------------------------------------------------------------------

interface FyersExpiryEntry {
  /** Human-readable date 'DD-MM-YYYY' */
  date?: string;
  /**
   * Expiry as epoch seconds (returned as a string by Fyers).
   * Must be parsed with Number() before use.
   */
  expiry?: string | number;
}

interface FyersOptionChainResponse {
  s?: string;
  data?: {
    expiryData?: FyersExpiryEntry[];
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Options for resolveCurrentExpiry().
 */
export interface ResolveExpiryOptions {
  /** Fyers app ID (format: XXXXXXXXXXXX-100). */
  appId: string;
  /** Fyers access token (expires daily). */
  accessToken: string;
  /** Injectable clock for deterministic test control (default: RealClock). */
  clock?: Clock;
  /**
   * Injectable fetch function for testing (default: global fetch).
   * Only the same interface as the built-in fetch is accepted — this is NOT a
   * URL or host parameter, so there is no SSRF risk from injecting a custom fetch
   * that still targets the fixed FYERS_OPTION_CHAIN_HOST.
   */
  fetchFn?: FetchFn;
}

/**
 * Resolve the current expiry date for the given underlying from Fyers' live
 * option-chain endpoint, with an offline fallback.
 *
 * Resolution logic:
 *   1. Check the in-process cache keyed by "{underlying}:{IST-date}". If hit,
 *      return the cached value immediately (at most one Fyers call per day per underlying).
 *   2. Call GET https://api-t1.fyers.in/data/options-chain-v3?symbol=<INDEX>&strikecount=1
 *      with Authorization: "{appId}:{accessToken}".
 *   3. Parse response.data.expiryData (sorted ascending by Fyers).
 *      Convert each entry's `expiry` field (epoch seconds) to a Date.
 *   4. Apply the 15:30 IST cut-off: the nearest expiry whose calendar date is
 *      today is only valid before 15:30 IST; at/after 15:30 IST, skip it.
 *   5. Return the first expiry that passes the cut-off filter.
 *   6. On ANY failure (network error, s !== "ok", empty expiryData, parse error),
 *      LOG a clear warning and fall back to getCurrentExpiry(underlying, clock).
 *      This function NEVER throws — the offline fallback guarantees the system
 *      continues to run in sim mode or when Fyers is unreachable.
 *
 * @param underlying  NIFTY, BANKNIFTY, or SENSEX
 * @param opts        Credentials + optional clock and fetchFn overrides
 * @returns           The nearest valid expiry Date (either Fyers-authoritative or fallback)
 */
export async function resolveCurrentExpiry(
  underlying: Underlying,
  opts: ResolveExpiryOptions,
): Promise<Date> {
  const clock = opts.clock ?? new RealClock();
  const nowMs = clock.timestamp?.() ?? clock.now();
  const fetchFn: FetchFn = opts.fetchFn ?? (fetch as FetchFn);

  // 1. Cache hit — return early without a network call.
  const cacheKey = `${underlying}:${istDateKey(nowMs)}`;
  const cached = _cache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  // 2. Call the Fyers option-chain endpoint.
  const indexSymbol = INDEX_SYMBOLS[underlying];
  const url = `${FYERS_OPTION_CHAIN_HOST}${FYERS_OPTION_CHAIN_PATH}?symbol=${encodeURIComponent(indexSymbol)}&strikecount=1`;
  // Authorization header format for Fyers v3: "{appId}:{accessToken}"
  // Matches the pattern used by fyers-historical.ts.
  const authHeader = `${opts.appId}:${opts.accessToken}`;

  let response: FyersOptionChainResponse;
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        // Never log this header value in full — it contains the access token.
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      console.warn(
        `[expiry-resolver] Fyers option-chain returned HTTP ${res.status} for ${underlying} — falling back to local rule`,
      );
      return getCurrentExpiry(underlying, clock);
    }

    response = (await res.json()) as FyersOptionChainResponse;
  } catch (err) {
    console.warn(
      `[expiry-resolver] Network error fetching Fyers option-chain for ${underlying} — falling back to local rule:`,
      err instanceof Error ? err.message : String(err),
    );
    return getCurrentExpiry(underlying, clock);
  }

  // 3. Validate the response.
  if (response.s !== 'ok') {
    console.warn(
      `[expiry-resolver] Fyers option-chain returned s="${response.s}" for ${underlying} — falling back to local rule`,
    );
    return getCurrentExpiry(underlying, clock);
  }

  const expiryData = response.data?.expiryData;
  if (!expiryData || expiryData.length === 0) {
    console.warn(
      `[expiry-resolver] Fyers option-chain returned empty expiryData for ${underlying} — falling back to local rule`,
    );
    return getCurrentExpiry(underlying, clock);
  }

  // 4 & 5. Parse expiry entries, apply 15:30 IST cut-off, pick the first valid one.
  //
  // Fyers returns expiryData sorted ascending by date, so the first entry that
  // passes the cut-off is the nearest valid expiry. We parse `expiry` as epoch
  // seconds (it may arrive as a string or number depending on the SDK version).
  //
  // Cut-off rule: if the nearest expiry is today and IST >= 15:30, skip it and
  // take the next entry. This exactly mirrors the getCurrentExpiry() logic.
  const todayIstKey = istDateKey(nowMs);
  const pastEOD = isPastEOD(nowMs);

  for (const entry of expiryData) {
    const epochSeconds = Number(entry.expiry);
    if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) {
      // Malformed entry — skip rather than crash
      continue;
    }

    const expiryDate = new Date(epochSeconds * 1000);
    const expiryIstKey = istDateKey(expiryDate.getTime());

    // Skip expiries that are before today in IST
    if (expiryIstKey < todayIstKey) {
      continue;
    }

    // Skip today's expiry if the market has already closed (15:30 IST cut-off)
    if (expiryIstKey === todayIstKey && pastEOD) {
      continue;
    }

    // This is the nearest valid expiry — normalise to midnight UTC for consistency
    // with getCurrentExpiry() which also returns midnight-UTC dates.
    const result = new Date(
      Date.UTC(
        expiryDate.getUTCFullYear(),
        expiryDate.getUTCMonth(),
        expiryDate.getUTCDate(),
      ),
    );

    // Store in cache so subsequent calls today return immediately.
    _cache.set(cacheKey, result);
    return result;
  }

  // 6. All entries were filtered out (unusual — e.g. very late in the day and
  //    Fyers hasn't published next-week entries yet). Fall back gracefully.
  console.warn(
    `[expiry-resolver] No valid expiry found in Fyers option-chain for ${underlying} after applying 15:30 cut-off — falling back to local rule`,
  );
  return getCurrentExpiry(underlying, clock);
}
