/**
 * Fyers v3 Historical REST Client
 *
 * Fetches OHLCV candles for a symbol over a date range using the Fyers v3
 * history endpoint. Handles date-range chunking (Fyers caps candles per
 * request per resolution), exponential backoff on rate limits, and typed
 * resumable errors on auth failure so that T-55 (the backfill writer) can
 * checkpoint and resume.
 *
 * Security notes:
 *   - Outbound requests go ONLY to FYERS_HISTORY_HOST — no caller-supplied
 *     URLs to avoid SSRF.
 *   - Credentials are sourced exclusively from loadStoredToken(db) or the
 *     FYERS_ACCESS_TOKEN / FYERS_APP_ID env vars; they are never logged in
 *     full (only the first 4 chars are emitted in log lines).
 *   - The HTTP layer is injectable (fetchFn param) so unit tests can mock it
 *     without any live network calls.
 *
 * Fyers endpoint assumptions (v3 data/history — verify against live docs):
 *   URL   : https://api-t1.fyers.in/api/v3/data/history
 *   Params: symbol, resolution, date_format (1 = epoch seconds), range_from,
 *           range_to (both epoch seconds when date_format=1)
 *   Auth  : Authorization header value is "{appId}:{accessToken}"
 *   Response shape: { s: "ok"|"error", candles: number[][], message?: string }
 *     where each candle is [epochSeconds, open, high, low, close, volume]
 *   Price data: prices are adjusted (split/bonus-adjusted) unless
 *     cont_adjustment=0 is passed — see ADJUSTED_DATA_ASSUMPTION below.
 *
 * Per-resolution day caps (reverse-engineered from Fyers docs / SDK samples;
 * must be verified against live API before production use):
 *   1  (1-minute)  : 30 days per request
 *   2  (2-minute)  : 30 days per request
 *   3  (3-minute)  : 30 days per request
 *   5  (5-minute)  : 60 days per request
 *   10 (10-minute) : 60 days per request
 *   15 (15-minute) : 60 days per request
 *   D  (daily)     : 365 days per request (Fyers limit is ~1 year)
 *   W  (weekly)    : 365 days per request
 *   M  (monthly)   : 365 days per request
 */

import type { Pool } from 'pg';
import { loadStoredToken } from '../../server/services/fyers-auth.js';

// ---------------------------------------------------------------------------
// Fixed host — never allow caller-supplied URLs (SSRF guard)
// ---------------------------------------------------------------------------

/** The only host this client will ever contact. */
const FYERS_HISTORY_HOST = 'https://api-t1.fyers.in';
const FYERS_HISTORY_PATH = '/api/v3/data/history';
const FYERS_HISTORY_URL = `${FYERS_HISTORY_HOST}${FYERS_HISTORY_PATH}`;

/**
 * Metadata assumption about price data returned by Fyers v3 history.
 * Fyers returns adjusted prices (split/bonus-adjusted) by default. This is
 * recorded in every result so callers are never silently misled.
 *
 * If this assumption ever changes (e.g. Fyers changes defaults or the caller
 * needs unadjusted prices), this constant must be updated and all downstream
 * consumers re-evaluated.
 */
const ADJUSTED_DATA_ASSUMPTION =
  'Prices are split/bonus-adjusted (Fyers v3 default). ' +
  'Unadjusted prices require cont_adjustment=0 in the request. ' +
  'Assumption: adjusted data is returned.';

// ---------------------------------------------------------------------------
// Resolution type
// ---------------------------------------------------------------------------

/**
 * Valid Fyers resolution strings.
 * Intraday resolutions are 1, 2, 3, 5, 10, 15, 20, 30, 60, 120, 240.
 * Daily/weekly/monthly are 'D', 'W', 'M'.
 *
 * Only the resolutions with known per-request caps are enumerated here.
 * Add more as they are verified against live Fyers docs.
 */
export type FyersResolution =
  | '1' // 1-minute
  | '2' // 2-minute
  | '3' // 3-minute
  | '5' // 5-minute
  | '10' // 10-minute
  | '15' // 15-minute
  | '20' // 20-minute
  | '30' // 30-minute
  | '60' // 1-hour
  | '120' // 2-hour
  | '240' // 4-hour
  | 'D' // daily
  | 'W' // weekly
  | 'M'; // monthly

/**
 * Maximum date-range days per Fyers history request, keyed by resolution.
 *
 * These caps are based on Fyers v3 API documentation and SDK samples and
 * must be verified against the live API before production use. Fyers may
 * enforce tighter limits for certain account types or high-OI instruments.
 *
 * Using a smaller cap than the actual limit is safe (more requests, same
 * data). Using a larger cap risks HTTP 400 from Fyers.
 */
export const RESOLUTION_DAY_CAPS: Readonly<Record<FyersResolution, number>> = {
  '1': 30, // 1-minute: 30 days max per request
  '2': 30, // 2-minute: same cap as 1-minute (intraday)
  '3': 30, // 3-minute
  '5': 60, // 5-minute: Fyers allows up to 60 days
  '10': 60, // 10-minute
  '15': 60, // 15-minute
  '20': 60, // 20-minute
  '30': 60, // 30-minute
  '60': 60, // 1-hour
  '120': 100, // 2-hour
  '240': 100, // 4-hour
  D: 365, // daily: 1 year per request
  W: 365, // weekly
  M: 365, // monthly
} as const;

// ---------------------------------------------------------------------------
// Backoff configuration
// ---------------------------------------------------------------------------

/** Milliseconds to wait before first retry on HTTP 429. */
const INITIAL_BACKOFF_MS = 1_000;
/** Maximum wait time between retries. */
const MAX_BACKOFF_MS = 32_000;
/** Maximum number of retry attempts on HTTP 429 before giving up. */
const MAX_RETRIES = 5;
/** Jitter fraction (±20%) to spread out concurrent requests. */
const JITTER_FRACTION = 0.2;

// ---------------------------------------------------------------------------
// Public interfaces — dedicated to historical data (do NOT extend the WebSocket shim)
// ---------------------------------------------------------------------------

/**
 * A single OHLCV candle from the Fyers history endpoint.
 * All price fields are as returned by Fyers (adjusted by default — see
 * ADJUSTED_DATA_ASSUMPTION). Volume is the total volume for the candle period.
 */
export interface FyersCandle {
  /** Candle open timestamp as a JavaScript Date (UTC). */
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * A gap marker returned when candle data is missing for part of the
 * requested range (e.g. holidays, exchange halts, option expiry, or
 * the underlying strike not yet listed).
 *
 * We NEVER fabricate or zero-fill missing candles. Instead we return a
 * gap marker so callers can decide how to handle the absence of data.
 */
export interface FyersCandleGap {
  /** The start of the gap period (inclusive). */
  from: Date;
  /** The end of the gap period (inclusive). */
  to: Date;
  /** Human-readable reason, if determinable. */
  reason: string;
}

/**
 * Metadata about the fetched result set. Returned alongside candles so
 * callers always know what assumptions were in effect during the fetch.
 */
export interface FyersHistoricalMeta {
  /** Symbol that was fetched. */
  symbol: string;
  /** Resolution that was used. */
  resolution: FyersResolution;
  /** The requested start of the range (inclusive). */
  rangeFrom: Date;
  /** The requested end of the range (inclusive). */
  rangeTo: Date;
  /** Total number of candles returned across all chunks. */
  totalCandles: number;
  /** Total number of HTTP requests made to Fyers (for diagnostics). */
  requestsMade: number;
  /**
   * Explicit statement of the adjusted/unadjusted assumption.
   * Always present so downstream consumers are never silently misled.
   */
  adjustedDataAssumption: string;
}

/**
 * The successful result from fetchHistoricalCandles().
 */
export interface FyersHistoricalResult {
  candles: FyersCandle[];
  /**
   * Gaps in the requested date range where no data was returned by Fyers.
   * An empty array means the data is contiguous (no gaps detected).
   *
   * Note: gaps are detected at chunk boundaries only. Sub-chunk gaps
   * (e.g. a single missing day within a 30-day chunk) are not detected
   * here — Fyers silently omits missing days, so a contiguous candle
   * array may still have calendar-day holes.
   */
  gaps: FyersCandleGap[];
  meta: FyersHistoricalMeta;
}

/**
 * Minimal fetch signature used by the history client.
 * Using the full `typeof fetch` (which includes static members like
 * `preconnect` in bun-types) would prevent Vitest mocks from satisfying the
 * type. Using only the callable signature keeps tests clean without weakening
 * the actual implementation — the built-in `fetch` is always assignable to
 * this type, and the mock just needs to match the call signature.
 */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Options for fetchHistoricalCandles().
 */
export interface FetchHistoricalOptions {
  /** Fyers-format symbol, e.g. 'NSE:NIFTY50-INDEX'. */
  symbol: string;
  /** Candle resolution. */
  resolution: FyersResolution;
  /** Inclusive start date. Time component is ignored — requests use UTC midnight. */
  from: Date;
  /** Inclusive end date. Time component is ignored — requests use UTC midnight. */
  to: Date;
  /**
   * Injectable fetch function for testing. Defaults to the global `fetch`.
   * Only the built-in fetch (or a mock with the same interface) should be
   * passed here — this is NOT a URL or host parameter, so there is no SSRF
   * risk from injecting a custom fetch that still targets the fixed
   * FYERS_HISTORY_URL.
   */
  fetchFn?: FetchFn;
  /**
   * Injectable sleep function for testing (avoids real delays in unit tests).
   * Defaults to a real Promise-based sleep.
   */
  sleepFn?: (ms: number) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/**
 * Thrown when no Fyers credentials are available.
 *
 * Both possible credential sources are checked:
 *   1. FYERS_ACCESS_TOKEN + FYERS_APP_ID environment variables
 *   2. The broker_tokens table via loadStoredToken(db)
 *
 * If neither source provides credentials, this error is thrown immediately
 * (never silently, never zero-data). Callers must ensure credentials exist
 * before calling fetchHistoricalCandles().
 */
export class FyersNoCredentialsError extends Error {
  constructor() {
    super(
      'Fyers credentials missing: set FYERS_ACCESS_TOKEN + FYERS_APP_ID env vars, ' +
        'or store a token via the OAuth flow (broker_tokens table).',
    );
    this.name = 'FyersNoCredentialsError';
  }
}

/**
 * Thrown on HTTP 429 (rate limit) after exhausting all retry attempts.
 */
export class FyersRateLimitError extends Error {
  constructor(public readonly attemptsExhausted: number) {
    super(
      `Fyers history API rate limit hit — exhausted ${attemptsExhausted} retry attempts. Back off and retry later.`,
    );
    this.name = 'FyersRateLimitError';
  }
}

/**
 * Thrown on HTTP 401 or a Fyers-level auth failure (s !== "ok" with an
 * auth-related message) mid-fetch.
 *
 * This error is RESUMABLE: it carries the timestamp of the last candle
 * successfully fetched, so the caller (T-55 backfill writer) can checkpoint
 * and resume without re-fetching data that was already received.
 *
 * If no candles were fetched before the auth failure, lastSuccessfulCutoff
 * is null (the caller should restart from the beginning of the range).
 */
export class FyersAuthError extends Error {
  /**
   * The timestamp of the last successfully fetched candle.
   * T-55 should resume from this point (exclusive) on next run.
   * Null if no candles were fetched before the failure occurred.
   */
  readonly lastSuccessfulCutoff: Date | null;

  constructor(message: string, lastSuccessfulCutoff: Date | null) {
    super(
      `Fyers auth failure mid-fetch: ${message}. ${
        lastSuccessfulCutoff
          ? `Last successful candle at ${lastSuccessfulCutoff.toISOString()} — resume from this point.`
          : 'No candles were fetched before failure — restart from the beginning of the range.'
      }`,
    );
    this.name = 'FyersAuthError';
    this.lastSuccessfulCutoff = lastSuccessfulCutoff;
  }
}

// ---------------------------------------------------------------------------
// Fyers API response shapes (internal — not exported)
// ---------------------------------------------------------------------------

/**
 * Shape of a successful Fyers history response.
 * candles is an array of [epochSeconds, open, high, low, close, volume] tuples.
 */
interface FyersHistorySuccessResponse {
  s: 'ok';
  /** Array of OHLCV tuples: [epochSec, open, high, low, close, volume] */
  candles: number[][];
}

/**
 * Shape of a Fyers history error response.
 */
interface FyersHistoryErrorResponse {
  s: 'error' | string;
  message?: string;
  code?: number;
}

type FyersHistoryResponse = FyersHistorySuccessResponse | FyersHistoryErrorResponse;

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

/**
 * Resolved Fyers credentials for a history fetch session.
 * Both fields are required — there is no "partial credential" path.
 */
interface ResolvedCredentials {
  appId: string;
  accessToken: string;
  refreshToken: string | null;
}

/**
 * Resolve Fyers credentials from env vars first, then from the DB.
 *
 * Priority:
 *   1. FYERS_ACCESS_TOKEN + FYERS_APP_ID env vars (fast path for dev / CI)
 *   2. broker_tokens table via loadStoredToken(db) (production path)
 *
 * If db is null, only env vars are tried.
 * Throws FyersNoCredentialsError if neither source provides both fields.
 *
 * Security: we never log the full token — only the first 4 chars are
 * written to any log output.
 */
async function resolveCredentials(db: Pool | null): Promise<ResolvedCredentials> {
  const envAccessToken = process.env.FYERS_ACCESS_TOKEN;
  const envAppId = process.env.FYERS_APP_ID;

  if (envAccessToken && envAppId) {
    return {
      appId: envAppId,
      accessToken: envAccessToken,
      refreshToken: process.env.FYERS_REFRESH_TOKEN ?? null,
    };
  }

  if (db !== null) {
    const stored = await loadStoredToken(db);
    if (stored) {
      return {
        appId: stored.appId,
        accessToken: stored.accessToken,
        refreshToken: stored.refreshToken,
      };
    }
  }

  // Neither source had credentials — fail loud.
  throw new FyersNoCredentialsError();
}

// ---------------------------------------------------------------------------
// Date-range chunking
// ---------------------------------------------------------------------------

interface DateChunk {
  from: Date;
  to: Date;
}

/**
 * Splits [from, to] into non-overlapping date chunks, each at most
 * `maxDays` wide. The last chunk may be shorter.
 *
 * Dates are aligned to UTC midnight so Fyers receives clean epoch-second
 * boundaries. The returned chunks are ordered oldest-first so we can track
 * the lastSuccessfulCutoff accurately as we iterate.
 */
export function chunkDateRange(from: Date, to: Date, maxDays: number): DateChunk[] {
  const chunks: DateChunk[] = [];

  // Work at UTC-midnight granularity for clean boundaries.
  const startMs = utcMidnight(from).getTime();
  const endMs = utcMidnight(to).getTime();

  if (startMs > endMs) {
    // Degenerate range: return no chunks.
    return chunks;
  }

  const dayMs = 24 * 60 * 60 * 1000;
  const maxMs = maxDays * dayMs;

  let chunkStart = startMs;
  while (chunkStart <= endMs) {
    const chunkEnd = Math.min(chunkStart + maxMs - dayMs, endMs);
    chunks.push({
      from: new Date(chunkStart),
      to: new Date(chunkEnd),
    });
    chunkStart = chunkEnd + dayMs;
  }

  return chunks;
}

/** Returns a new Date with time zeroed to UTC midnight (00:00:00.000 UTC). */
function utcMidnight(d: Date): Date {
  const result = new Date(d.getTime());
  result.setUTCHours(0, 0, 0, 0);
  return result;
}

// ---------------------------------------------------------------------------
// Backoff helpers
// ---------------------------------------------------------------------------

/** Default sleep implementation using a real Promise timeout. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compute jittered backoff delay for attempt N (0-indexed).
 * Doubles from INITIAL_BACKOFF_MS, capped at MAX_BACKOFF_MS, with ±JITTER_FRACTION.
 */
function backoffDelay(attempt: number): number {
  const base = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  const jitter = 1 + (Math.random() * 2 - 1) * JITTER_FRACTION;
  return Math.round(base * jitter);
}

// ---------------------------------------------------------------------------
// Core fetch function (single chunk)
// ---------------------------------------------------------------------------

/**
 * Fetch one chunk of OHLCV candles from Fyers with retry on 429.
 *
 * Throws:
 *   FyersAuthError    — on HTTP 401 or Fyers-level auth error
 *   FyersRateLimitError — on HTTP 429 after MAX_RETRIES exhausted
 *   Error             — on unrecoverable HTTP errors or malformed responses
 */
async function fetchChunk(
  chunk: DateChunk,
  symbol: string,
  resolution: FyersResolution,
  creds: ResolvedCredentials,
  lastSuccessfulCutoff: Date | null,
  fetchFn: FetchFn,
  sleepFn: (ms: number) => Promise<void>,
): Promise<FyersCandle[]> {
  const params = new URLSearchParams({
    symbol,
    resolution,
    // date_format=1 tells Fyers to interpret range_from/range_to as epoch seconds
    // and to return candle timestamps as epoch seconds.
    date_format: '1',
    range_from: String(Math.floor(chunk.from.getTime() / 1000)),
    range_to: String(Math.floor(chunk.to.getTime() / 1000)),
    // cont_adjustment is intentionally omitted — we accept the Fyers default of
    // adjusted (split/bonus-adjusted) data, recorded in ADJUSTED_DATA_ASSUMPTION.
  });

  // Authorization header format for Fyers v3: "{appId}:{accessToken}"
  // This is the same combined token format used by the WebSocket adapter.
  const authHeader = `${creds.appId}:${creds.accessToken}`;

  const url = `${FYERS_HISTORY_URL}?${params.toString()}`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: 'GET',
        headers: {
          // Never log this header value in full — it contains the access token.
          Authorization: authHeader,
          'Content-Type': 'application/json',
        },
      });
    } catch (networkErr) {
      // Network-level error (DNS failure, connection refused, etc.)
      // These are not retried — they indicate infrastructure issues.
      throw new Error(
        `Fyers history fetch network error: ${networkErr instanceof Error ? networkErr.message : String(networkErr)}`,
      );
    }

    // HTTP 429: rate limited — back off and retry
    if (res.status === 429) {
      if (attempt >= MAX_RETRIES) {
        throw new FyersRateLimitError(MAX_RETRIES + 1);
      }
      const delay = backoffDelay(attempt);
      console.warn(
        `[FyersHistorical] HTTP 429 rate limit — attempt ${attempt + 1}/${MAX_RETRIES + 1}, ` +
          `backing off ${delay}ms`,
      );
      await sleepFn(delay);
      continue;
    }

    // HTTP 401: auth failure — throw resumable error immediately (no retry)
    if (res.status === 401) {
      throw new FyersAuthError(
        `HTTP 401 from Fyers history endpoint (token prefix: ${creds.accessToken.slice(0, 4)}...)`,
        lastSuccessfulCutoff,
      );
    }

    // Any other non-2xx: unrecoverable for this request
    if (!res.ok) {
      let body = '';
      try {
        body = await res.text();
      } catch {
        // swallow — we already have the status code
      }
      throw new Error(`Fyers history request failed: HTTP ${res.status} — ${body.slice(0, 200)}`);
    }

    // Parse the response body
    let body: FyersHistoryResponse;
    try {
      body = (await res.json()) as FyersHistoryResponse;
    } catch {
      throw new Error('Fyers history response was not valid JSON');
    }

    // Fyers-level auth error: s !== "ok" with an auth-related payload.
    // Fyers sometimes returns HTTP 200 with s="error" and a message indicating
    // token expiry — we treat this as an auth failure to match the WS adapter.
    if (body.s !== 'ok') {
      const errBody = body as FyersHistoryErrorResponse;
      const msg = errBody.message ?? `s=${body.s}`;
      const isAuthError =
        errBody.code === 16 || // Fyers token-expiry code (observed in SDK samples)
        msg.toLowerCase().includes('token') ||
        msg.toLowerCase().includes('auth') ||
        msg.toLowerCase().includes('unauthorized') ||
        msg.toLowerCase().includes('session');

      if (isAuthError) {
        throw new FyersAuthError(
          `Fyers API auth error: ${msg} (code=${errBody.code ?? 'n/a'})`,
          lastSuccessfulCutoff,
        );
      }

      // Non-auth Fyers error (e.g. invalid symbol)
      throw new Error(`Fyers history API error: ${msg} (code=${errBody.code ?? 'n/a'})`);
    }

    // Successfully received candles — parse and return.
    const successBody = body as FyersHistorySuccessResponse;
    return parseCandles(successBody.candles);
  }

  // Should be unreachable — the loop either returns or throws.
  throw new Error('[FyersHistorical] Exhausted retry loop unexpectedly');
}

// ---------------------------------------------------------------------------
// Candle parser
// ---------------------------------------------------------------------------

/**
 * Parse raw Fyers candle tuples into typed FyersCandle objects.
 *
 * Each raw candle is: [epochSeconds, open, high, low, close, volume]
 *
 * We validate that each tuple has at least 6 elements. Malformed tuples are
 * logged and skipped rather than causing the entire fetch to fail — a partial
 * result is better than a crash. The gap-detection logic upstream will surface
 * missing candles to the caller.
 */
function parseCandles(raw: number[][]): FyersCandle[] {
  const candles: FyersCandle[] = [];

  for (let i = 0; i < raw.length; i++) {
    const tuple = raw[i];
    if (!tuple || tuple.length < 6) {
      console.warn(
        `[FyersHistorical] Malformed candle at index ${i} — expected 6 elements, ` +
          `got ${tuple ? tuple.length : 0}. Skipping.`,
      );
      continue;
    }

    // Validate that all fields are finite numbers before trusting them.
    // Fyers occasionally sends null for volume on illiquid instruments.
    const [epochSec, open, high, low, close, volume] = tuple as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];

    if (
      !Number.isFinite(epochSec) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close)
    ) {
      console.warn(`[FyersHistorical] Candle at index ${i} has non-finite price field — skipping.`);
      continue;
    }

    candles.push({
      timestamp: new Date(epochSec * 1000),
      open,
      high,
      low,
      close,
      // Volume may be null/NaN/undefined from Fyers for illiquid instruments.
      // We treat it as 0 in that case.
      // We do NOT zero-fill price data (open/high/low/close), only volume.
      // Note: isFinite(null) returns true (null coerces to 0), so we use an
      // explicit null/undefined check before falling back to isFinite.
      volume: volume != null && Number.isFinite(volume) ? volume : 0,
    });
  }

  return candles;
}

// ---------------------------------------------------------------------------
// Gap detection
// ---------------------------------------------------------------------------

/**
 * Detect gaps between adjacent date chunks by comparing the last candle
 * timestamp from one chunk against the expected start of the next chunk.
 *
 * A gap is recorded when a chunk returns zero candles (e.g. the strike was
 * not listed on those days, or the market was closed for the entire chunk).
 *
 * NOTE: this only detects chunk-boundary gaps. Single missing days within a
 * chunk (e.g. one holiday within a 30-day window) are NOT detected here —
 * Fyers silently omits closed-market days, and we do not fabricate them.
 */
function detectGap(chunk: DateChunk, candlesInChunk: FyersCandle[]): FyersCandleGap | null {
  if (candlesInChunk.length === 0) {
    return {
      from: chunk.from,
      to: chunk.to,
      reason:
        'No candles returned by Fyers for this date range. Possible causes: ' +
        'market holiday(s), exchange halt, instrument not yet listed, or ' +
        'option strike not available for this period.',
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch OHLCV candles for a symbol over a date range using the Fyers v3
 * history API.
 *
 * Authentication:
 *   Credentials are resolved from (in priority order):
 *   1. FYERS_ACCESS_TOKEN + FYERS_APP_ID env vars
 *   2. broker_tokens table via loadStoredToken(db)
 *   If neither is available, throws FyersNoCredentialsError immediately.
 *
 * If db is null, only env vars are used. Pass the pg Pool for production.
 *
 * Date-range handling:
 *   The [from, to] range is split into chunks respecting Fyers per-resolution
 *   caps. Chunks are fetched sequentially (oldest first) to preserve
 *   lastSuccessfulCutoff accuracy. Parallel chunking is intentionally avoided
 *   to reduce rate-limit pressure.
 *
 * On auth failure mid-fetch:
 *   Throws FyersAuthError carrying lastSuccessfulCutoff — the timestamp of
 *   the last successfully fetched candle. T-55 should use this to checkpoint
 *   and resume on next run.
 *
 * On rate limit (HTTP 429):
 *   Retries with exponential backoff up to MAX_RETRIES times, then throws
 *   FyersRateLimitError.
 *
 * Missing data (gaps):
 *   Gaps are recorded in result.gaps — we NEVER fabricate or zero-fill candles
 *   for missing periods (holidays, exchange halts, unlisted strikes).
 */
export async function fetchHistoricalCandles(
  db: Pool | null,
  options: FetchHistoricalOptions,
): Promise<FyersHistoricalResult> {
  const {
    symbol,
    resolution,
    from,
    to,
    fetchFn = fetch as FetchFn,
    sleepFn = defaultSleep,
  } = options;

  // Validate the date range before making any network calls.
  if (from > to) {
    throw new Error(
      `fetchHistoricalCandles: 'from' (${from.toISOString()}) must not be after ` +
        `'to' (${to.toISOString()})`,
    );
  }

  // Resolve credentials — throws FyersNoCredentialsError if missing.
  const creds = await resolveCredentials(db);

  // Log masked credentials for diagnostics (never the full token).
  console.log(
    `[FyersHistorical] Fetching ${symbol} ${resolution} from ` +
      `${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)} ` +
      `— appId=${creds.appId.slice(0, 4)}... token=${creds.accessToken.slice(0, 4)}...`,
  );

  // Split the full range into chunks respecting the per-resolution cap.
  const maxDays = RESOLUTION_DAY_CAPS[resolution];
  const chunks = chunkDateRange(from, to, maxDays);

  const allCandles: FyersCandle[] = [];
  const gaps: FyersCandleGap[] = [];
  let requestsMade = 0;

  // Track the last candle timestamp across all chunks so that FyersAuthError
  // carries an accurate lastSuccessfulCutoff.
  let lastSuccessfulCutoff: Date | null = null;

  for (const chunk of chunks) {
    const chunkCandles = await fetchChunk(
      chunk,
      symbol,
      resolution,
      creds,
      lastSuccessfulCutoff,
      fetchFn,
      sleepFn,
    );
    requestsMade += 1;

    // Detect chunk-level gaps (zero candles returned for the chunk).
    const gap = detectGap(chunk, chunkCandles);
    if (gap !== null) {
      gaps.push(gap);
    }

    // Update the cutoff to the last candle timestamp in this chunk.
    if (chunkCandles.length > 0) {
      const lastCandle = chunkCandles[chunkCandles.length - 1];
      if (lastCandle !== undefined) {
        lastSuccessfulCutoff = lastCandle.timestamp;
      }
      allCandles.push(...chunkCandles);
    }
  }

  const meta: FyersHistoricalMeta = {
    symbol,
    resolution,
    rangeFrom: from,
    rangeTo: to,
    totalCandles: allCandles.length,
    requestsMade,
    adjustedDataAssumption: ADJUSTED_DATA_ASSUMPTION,
  };

  return { candles: allCandles, gaps, meta };
}
