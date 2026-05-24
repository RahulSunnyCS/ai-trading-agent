/**
 * sr-levels.ts — Objective Support/Resistance level computation for the S/R signal engine.
 *
 * Computes three families of S/R levels for a given underlying + as-of date:
 *   1. Previous-week High / Low  (price memory from the prior IST calendar week)
 *   2. Monthly classic pivot: PP = (H+L+C)/3, with R1/S1/R2/S2 derived levels
 *   3. Volume Point of Control (POC): price bucket with highest cumulative volume
 *      — omitted when volume data is absent (degraded gracefully, not faked)
 *
 * Each level carries a strength score [0, 1] that combines:
 *   - proximity weight:   1 / (1 + normalised distance from current price)
 *   - confluence weight:  count of other nearby levels within a band (additive)
 *   - volume weight:      relative volume of the level's origin candle vs. session avg
 *                         When volume is NULL, a NEUTRAL weight (1.0) is used —
 *                         consistent with the pass-on-null-VIX convention in the scorer.
 *
 * IST note: IST = UTC+5:30. No DST — IST_OFFSET_MS is a fixed constant throughout.
 * All week/month boundary calculations are done in IST epoch arithmetic.
 *
 * TimescaleDB hypertable note: every SQL query MUST include a time-range WHERE
 * clause. Full-table scans on market_ticks are extremely slow (years of data).
 * Every query here asserts `time >= $from AND time < $to`.
 *
 * Named exports only. No default export (project convention).
 */

import type { Pool } from 'pg';
import type { Clock } from '../utils/clock.js';

// ---------------------------------------------------------------------------
// IST constants
// ---------------------------------------------------------------------------

/** IST = UTC+5:30. Fixed offset with no DST — safe to use as a constant. */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 19800000ms

/** One day in milliseconds. */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** One week in milliseconds (7 days). */
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The three types of levels this engine can produce. */
export type SRLevelType = 'prev_week_high' | 'prev_week_low' | 'pivot' | 'poc';

/**
 * A single computed S/R level with its price and strength score.
 *
 * poc_used: true only for levels whose type is 'poc'. Callers use this
 * to populate the poc_used column in straddle_signals without inspecting
 * the level type string themselves.
 */
export interface SRLevel {
  /** Price of the level (nominal/absolute price, not a delta). */
  price: number;
  /** Which computation produced this level. */
  type: SRLevelType;
  /**
   * Strength score in [0, 1] after confluence and volume weighting.
   * Higher = stronger / more confluent level.
   */
  strength: number;
  /** True only for POC levels — lets callers set poc_used downstream. */
  poc_used: boolean;
}

/**
 * The full output of computeSRLevels — the levels array plus metadata
 * about what actually contributed (so the caller can set poc_used and
 * level_source on the signal row without inspecting individual levels).
 */
export interface SRLevelResult {
  /** All computed levels, sorted by strength descending. */
  levels: SRLevel[];
  /**
   * Which level families contributed to this result.
   * 'poc' is absent when volume data was fully null for the lookback window.
   */
  contributed: SRLevelType[];
  /**
   * True if the POC was computed (i.e. at least one candle had non-null volume
   * in the lookback window). False when volume was universally absent.
   */
  poc_used: boolean;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Tuning parameters for the S/R engine.
 *
 * poc_bucket_pts: width (in index points) of each volume-profile bucket.
 * For NIFTY this should match the ATM strike interval (50pt);
 * for BANKNIFTY/SENSEX use 100pt. Default 50pt is safe for all — finer
 * buckets would create many small partitions with no confluence benefit.
 *
 * confluence_band_pts: distance within which two levels are considered
 * confluent (mutually reinforcing). 20pt is roughly one tick band on NIFTY;
 * this keeps confluence selective.
 *
 * proximity_reference_pts: normalisation factor for the proximity weight.
 * 100pt = "a level 100 points away gets 50% weight". Larger values make the
 * score fall off more slowly with distance.
 */
export interface SRConfig {
  poc_bucket_pts: number;
  confluence_band_pts: number;
  proximity_reference_pts: number;
}

export const DEFAULT_SR_CONFIG: SRConfig = {
  poc_bucket_pts: 50,
  confluence_band_pts: 20,
  proximity_reference_pts: 100,
};

// ---------------------------------------------------------------------------
// Error class for coverage guard
// ---------------------------------------------------------------------------

/**
 * Thrown by assertHistoryCoverage() when the DB has fewer bars than the
 * minimum expected for the lookback window.
 *
 * This mirrors the FROZEN_VIOLATION pattern: throw-don't-skip, so the caller
 * (the S/R signal engine at session start) disables S/R for the affected index
 * for the day rather than silently emitting levels from stale/zero data.
 *
 * The error carries machine-readable fields so callers can log and alert without
 * string-parsing the message.
 */
export class InsufficientHistoryCoverageError extends Error {
  readonly underlying: string;
  readonly actualBars: number;
  readonly expectedBars: number;

  constructor(underlying: string, actualBars: number, expectedBars: number) {
    super(
      `[sr-levels] Insufficient history for ${underlying}: ` +
        `got ${actualBars} bars, need >= ${expectedBars}. ` +
        `S/R disabled for this index today.`,
    );
    this.name = 'InsufficientHistoryCoverageError';
    this.underlying = underlying;
    this.actualBars = actualBars;
    this.expectedBars = expectedBars;
  }
}

// ---------------------------------------------------------------------------
// IST date/week/month arithmetic helpers
// ---------------------------------------------------------------------------

/**
 * Converts an IST date string ('YYYY-MM-DD') to the UTC epoch-ms at the
 * start of that IST calendar day (i.e. IST midnight, which is UTC 18:30 the
 * prior day).
 *
 * Example: '2026-05-18' → epoch ms for 2026-05-17T18:30:00.000Z
 *
 * We parse the date as midnight UTC, then subtract the IST offset to find the
 * UTC moment that corresponds to IST midnight. This avoids locale-dependent
 * Date formatting and the Intl/toLocaleString pitfalls.
 */
export function istDateToUtcMs(istDateStr: string): number {
  // '2026-05-18' parsed as UTC midnight = 2026-05-18T00:00:00.000Z
  const utcMidnight = new Date(`${istDateStr}T00:00:00.000Z`).getTime();
  // IST midnight = UTC midnight − IST offset (because IST is ahead of UTC,
  // IST midnight = UTC (midnight − 5:30h) of the SAME date)
  return utcMidnight - IST_OFFSET_MS;
}

/**
 * Returns the IST date string ('YYYY-MM-DD') for the given UTC epoch-ms.
 * Uses the same fixed-offset arithmetic as the Clock implementation.
 */
export function utcMsToIstDate(epochMs: number): string {
  // Add the IST offset to shift the UTC timestamp into IST, then read UTC fields
  const d = new Date(epochMs + IST_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Returns the IST day-of-week index (0=Sunday, 1=Monday, …, 6=Saturday)
 * for the given UTC epoch-ms.
 */
function istDayOfWeek(epochMs: number): number {
  const d = new Date(epochMs + IST_OFFSET_MS);
  return d.getUTCDay();
}

/**
 * Computes the [weekStart, weekEnd) window for the IST calendar week that
 * CONTAINS the given IST-epoch-ms.
 *
 * IST weeks run Monday 00:00 IST → Sunday 23:59:59 IST.
 * We return:
 *   weekStart: epoch-ms of Monday 00:00 IST of that week
 *   weekEnd  : epoch-ms of Monday 00:00 IST of the NEXT week (exclusive)
 *
 * Why Monday as week start: NSE/BSE weekly options expire on Thursday (NIFTY),
 * Wednesday (BANKNIFTY), or Friday (SENSEX). The standard "previous week"
 * concept in Indian market analysis runs Monday–Friday. Using Monday as the
 * anchor makes the previous-week H/L span the full prior trading week.
 */
export function istWeekWindow(epochMs: number): { weekStart: number; weekEnd: number } {
  // Day-of-week in IST (0=Sunday, 1=Monday…)
  const dow = istDayOfWeek(epochMs);
  // Days since Monday: Monday=0, Tuesday=1, …, Sunday=6
  // For Sunday (dow=0), daysFromMonday = 6 (it's 6 days since the previous Monday)
  const daysFromMonday = dow === 0 ? 6 : dow - 1;

  // IST midnight of the current IST day
  const todayStartMs = epochMs - ((epochMs + IST_OFFSET_MS) % ONE_DAY_MS);

  // Walk back to Monday 00:00 IST
  const weekStart = todayStartMs - daysFromMonday * ONE_DAY_MS;
  const weekEnd = weekStart + ONE_WEEK_MS;

  return { weekStart, weekEnd };
}

/**
 * Returns the [from, to) window for the previous IST calendar week
 * (Monday 00:00 IST to Sunday 24:00 IST, exclusive end = next Monday 00:00).
 *
 * If asOfMs falls on Monday it is still "in" the current week, so prevWeek
 * returns the week BEFORE the current one.
 */
export function prevIstWeekWindow(asOfMs: number): { from: number; to: number } {
  const { weekStart } = istWeekWindow(asOfMs);
  // The previous week ends where the current week starts (exclusive)
  const to = weekStart;
  const from = to - ONE_WEEK_MS;
  return { from, to };
}

/**
 * Returns the [from, to) window for the previous IST calendar month.
 *
 * "Previous month" = the full calendar month before the one containing asOfMs.
 * from: first day of that month at 00:00 IST
 * to  : first day of asOfMs's month at 00:00 IST (exclusive)
 *
 * We compute this via the IST year/month of asOfMs, subtract one month,
 * then convert back to epoch-ms. This avoids off-by-one errors at month
 * boundaries and handles December → November correctly.
 */
export function prevIstMonthWindow(asOfMs: number): { from: number; to: number } {
  // Read the IST year and month of asOfMs
  const d = new Date(asOfMs + IST_OFFSET_MS);
  const istYear = d.getUTCFullYear();
  const istMonth = d.getUTCMonth(); // 0-indexed: 0=Jan, 11=Dec

  // First day of the CURRENT month at IST midnight
  const toStr = `${istYear}-${String(istMonth + 1).padStart(2, '0')}-01`;
  const to = istDateToUtcMs(toStr);

  // First day of the PREVIOUS month at IST midnight
  const prevMonth = istMonth === 0 ? 11 : istMonth - 1;
  const prevYear = istMonth === 0 ? istYear - 1 : istYear;
  const fromStr = `${prevYear}-${String(prevMonth + 1).padStart(2, '0')}-01`;
  const from = istDateToUtcMs(fromStr);

  return { from, to };
}

// ---------------------------------------------------------------------------
// Raw history fetch helpers (thin wrappers over TimescaleDB hypertable queries)
// ---------------------------------------------------------------------------

/**
 * Represents one OHLCV candle computed from market_ticks within a time window.
 * `volume` is null when NO tick in the window had non-null volume.
 */
interface OHLCVCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  /** Sum of non-null volumes. null if every tick had null volume. */
  volume: number | null;
}

/**
 * Represents one market_tick row as fetched for volume-profile computation.
 * We only need ltp and volume; other fields are discarded at the query level.
 */
interface TickRow {
  ltp: number;
  volume: number | null;
}

/**
 * Fetches aggregate OHLCV for `underlying` over the given [from, to) window.
 *
 * Queries market_ticks with a strict time-range filter (no hypertable scan).
 * Returns null if no ticks exist in the window (prevents division by zero in
 * level calculations and lets callers decide the right fallback).
 *
 * Volume handling: we use SUM(volume) rather than AVG because the POC formula
 * needs cumulative volume per price bucket, and even a single row's volume
 * contributes to the total. SUM(volume) is null in PostgreSQL when ALL rows
 * have null volume — this propagates correctly to OHLCVCandle.volume.
 */
async function fetchOHLCV(
  pool: Pool,
  underlying: string,
  fromMs: number,
  toMs: number,
): Promise<OHLCVCandle | null> {
  // Parameterised query — no string interpolation of any user-supplied value
  const rows = await pool.query<{
    open_price: string;
    high_price: string;
    low_price: string;
    close_price: string;
    total_volume: string | null;
    row_count: string;
  }>(
    `SELECT
       FIRST(ltp, time)   AS open_price,
       MAX(ltp)           AS high_price,
       MIN(ltp)           AS low_price,
       LAST(ltp, time)    AS close_price,
       SUM(volume)        AS total_volume,
       COUNT(*)           AS row_count
     FROM market_ticks
     WHERE symbol = $1
       AND time >= $2
       AND time < $3`,
    [underlying, new Date(fromMs), new Date(toMs)],
  );

  const row = rows.rows[0];
  // COUNT(*) = 0 means no ticks in the window. Guard on row_count so we never
  // return fabricated numbers from an empty window aggregate.
  if (!row || Number(row.row_count) === 0) {
    return null;
  }

  return {
    open: Number(row.open_price),
    high: Number(row.high_price),
    low: Number(row.low_price),
    close: Number(row.close_price),
    // SUM(volume) is null in SQL when all values are null — preserve that signal
    volume: row.total_volume !== null ? Number(row.total_volume) : null,
  };
}

/**
 * Fetches raw (ltp, volume) tick pairs for the POC calculation.
 *
 * We fetch raw ticks rather than pre-aggregated data because POC bucketing
 * requires distributing volume across price buckets at the tick level.
 * Pre-aggregated OHLCV would lose the intra-bar price/volume distribution.
 *
 * The query is time-bounded (required for hypertables). `LIMIT 50000` caps
 * memory use: at 15s intervals over a full 5-day week, a typical week yields
 * ~1500 ticks per underlying — well below the limit. The limit exists as a
 * defensive cap against misconfigured windows.
 */
async function fetchTicksForPOC(
  pool: Pool,
  underlying: string,
  fromMs: number,
  toMs: number,
): Promise<TickRow[]> {
  const rows = await pool.query<{ ltp: string; volume: string | null }>(
    `SELECT ltp, volume
     FROM market_ticks
     WHERE symbol = $1
       AND time >= $2
       AND time < $3
     ORDER BY time
     LIMIT 50000`,
    [underlying, new Date(fromMs), new Date(toMs)],
  );

  return rows.rows.map((r) => ({
    ltp: Number(r.ltp),
    volume: r.volume !== null ? Number(r.volume) : null,
  }));
}

/**
 * Counts the number of market_tick rows for `underlying` in the given window.
 * Used by the coverage guard to confirm adequate data exists before computing levels.
 *
 * Time-range filter is mandatory (hypertable). COUNT(*) is efficient on hypertables
 * because TimescaleDB pushes the filter into the chunk metadata.
 */
export async function countHistoryBars(
  pool: Pool,
  underlying: string,
  fromMs: number,
  toMs: number,
): Promise<number> {
  const rows = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM market_ticks
     WHERE symbol = $1
       AND time >= $2
       AND time < $3`,
    [underlying, new Date(fromMs), new Date(toMs)],
  );

  const row = rows.rows[0];
  return row ? Number(row.cnt) : 0;
}

// ---------------------------------------------------------------------------
// POC computation (pure — operates on an array of TickRow)
// ---------------------------------------------------------------------------

/**
 * Computes the Volume Point of Control from an array of ticks.
 *
 * POC = the price bucket with the highest cumulative volume.
 * Bucket width is `bucketPts` index points, aligned to multiples of bucketPts
 * starting from 0 (e.g. for bucketPts=50: buckets [0,50), [50,100), …).
 * This alignment ensures bucket boundaries are deterministic and predictable
 * regardless of the price range — NIFTY near 22500 always produces boundaries
 * like 22450, 22500, 22550, not arbitrary offsets.
 *
 * Null-volume handling: ticks with null volume are EXCLUDED from POC computation.
 * If ALL ticks have null volume, returns null (caller omits POC from the result).
 * Partial null: ticks with actual volume still contribute normally; null-volume
 * ticks are skipped without penalty — they don't dilute the remaining volume.
 *
 * Returns the MID-POINT of the winning bucket (floor of bucket * bucketPts)
 * as the POC price, not the raw bucket key. This gives a stable price value
 * that callers can compare against spot.
 */
export function computePOC(ticks: TickRow[], bucketPts: number): number | null {
  // Accumulate volume per bucket. bucketKey = Math.floor(ltp / bucketPts)
  // so price 22517 with bucketPts=50 → bucket 450 → range [22500, 22550).
  const buckets = new Map<number, number>();

  let hasAnyVolume = false;

  for (const tick of ticks) {
    // Skip ticks with null volume — we cannot fabricate volume data.
    if (tick.volume === null || !Number.isFinite(tick.ltp) || tick.ltp <= 0) {
      continue;
    }
    hasAnyVolume = true;
    const bucketKey = Math.floor(tick.ltp / bucketPts);
    const current = buckets.get(bucketKey) ?? 0;
    buckets.set(bucketKey, current + tick.volume);
  }

  // All ticks had null volume — degrade gracefully by returning null.
  if (!hasAnyVolume) {
    return null;
  }

  // Find the bucket with maximum volume (deterministic: on ties, first encountered wins).
  let maxVolume = -Infinity;
  let pocBucket = 0;

  for (const [key, vol] of buckets) {
    if (vol > maxVolume) {
      maxVolume = vol;
      pocBucket = key;
    }
  }

  // Return the lower boundary of the winning bucket as the POC price.
  // The lower boundary is the canonical "level price" — it is a round number
  // that corresponds to a strike interval, making it easy to compare to ATM strike.
  return pocBucket * bucketPts;
}

// ---------------------------------------------------------------------------
// Pivot computation (pure math)
// ---------------------------------------------------------------------------

/**
 * Classic pivot point formula: PP = (H + L + C) / 3.
 * Standard resistance/support projections from the pivot:
 *   R1 = 2*PP - L
 *   S1 = 2*PP - H
 *   R2 = PP + (H - L)
 *   S2 = PP - (H - L)
 *
 * These are the most widely used levels in Indian options trading — NSE market
 * commentary consistently references classical pivots computed from the prior
 * month's OHLC. Using prior-MONTH (not prior-week) because weekly options
 * strategies benefit from slower-moving reference levels that don't shift every
 * Monday morning.
 *
 * All returned levels are raw prices (not rounded to strike intervals). The
 * caller may optionally snap them to strike intervals downstream; we preserve
 * full precision here so the strength score is computed on accurate distances.
 */
export interface PivotLevels {
  pp: number;
  r1: number;
  s1: number;
  r2: number;
  s2: number;
}

export function computePivotLevels(candle: OHLCVCandle): PivotLevels {
  const { high, low, close } = candle;
  const range = high - low;
  const pp = (high + low + close) / 3;
  return {
    pp,
    r1: 2 * pp - low,
    s1: 2 * pp - high,
    r2: pp + range,
    s2: pp - range,
  };
}

// ---------------------------------------------------------------------------
// Strength scoring (pure)
// ---------------------------------------------------------------------------

/**
 * Computes a strength score [0, 1] for a single level price.
 *
 * Components:
 *   1. proximity weight = 1 / (1 + |price - currentSpot| / referencePoints)
 *      A level 100pt away gets weight 0.5; 200pt away gets 0.33; at-spot = 1.0.
 *      The 1/(1+x) form ensures the score stays in (0,1] and never reaches 0.
 *
 *   2. confluence weight = 1 + confluenceCount * 0.15
 *      Each additional nearby level adds 0.15 to the multiplier, capped so the
 *      total (proximity × confluence) stays ≤ 1 after final normalisation.
 *      Confluence rewards cluster density: 4 nearby levels → 1.6× boost.
 *
 *   3. volume weight = applied only when the level type supports it (POC).
 *      For non-POC levels, volume data is unavailable at the level-type level
 *      (prev-week H/L and pivot levels are not tied to a single candle's volume),
 *      so we use NEUTRAL = 1.0 throughout. For POC, if it was produced from
 *      real volume, we assign weight 1.3 (a modest boost recognising that POC
 *      has real volume-backed confluence). If POC itself is null-volume-derived
 *      (which cannot happen since computePOC returns null in that case), this
 *      branch is unreachable.
 *
 * Final score is clamped to [0, 1] to protect callers from floating-point
 * overshoot when many confluences combine.
 */
export function scoreLevel(
  levelPrice: number,
  levelType: SRLevelType,
  currentSpot: number,
  allLevelPrices: number[],
  config: SRConfig,
  hasVolumeData: boolean,
): number {
  // 1. Proximity: normalised inverse distance
  const distance = Math.abs(levelPrice - currentSpot);
  const proximity = 1 / (1 + distance / config.proximity_reference_pts);

  // 2. Confluence: count OTHER levels within the confluence band
  let confluenceCount = 0;
  for (const other of allLevelPrices) {
    // Exclude the level itself (same price → skip)
    if (other === levelPrice) continue;
    if (Math.abs(other - levelPrice) <= config.confluence_band_pts) {
      confluenceCount++;
    }
  }
  // Each confluent neighbour adds 15% to the multiplier
  const confluenceMultiplier = 1 + confluenceCount * 0.15;

  // 3. Volume weight
  // POC levels carry a volume-backed premium when real volume was available.
  // All other level types (prev_week, pivot) are computed from OHLCV aggregates
  // with no per-level volume, so they get neutral weight = 1.0.
  // This also handles the null-volume case for non-POC levels — no boost/penalty.
  let volumeWeight: number;
  if (levelType === 'poc' && hasVolumeData) {
    volumeWeight = 1.3; // Volume-backed POC gets a modest premium
  } else {
    volumeWeight = 1.0; // Neutral (R-I consistency: no boost, no penalty)
  }

  const raw = proximity * confluenceMultiplier * volumeWeight;

  // Clamp to [0, 1] — required so consumers treat the score as a probability-like signal
  return Math.min(1, Math.max(0, raw));
}

// ---------------------------------------------------------------------------
// Session-start freshness / coverage guard
// ---------------------------------------------------------------------------

/**
 * Asserts that the market_ticks table contains at least `expectedBars` rows for
 * `underlying` in the given [fromMs, toMs) window.
 *
 * Throws InsufficientHistoryCoverageError if coverage is below threshold.
 * This is deliberately throw-not-skip: the caller (S/R signal engine at session
 * start) catches this, logs it, and disables S/R for the affected index for the
 * day. Silent emission of levels from stale/zero data is worse than a trading
 * pause — it produces false signals.
 *
 * expectedBars guidance (at 15-second snapshot interval):
 *   One full trading session (9:15–15:30 = 375 minutes) = 1500 snapshots.
 *   A 5-day previous week = ~7500 snapshots. Using a lower threshold (e.g. 500
 *   per day × 5 = 2500) allows for gaps due to holidays and early closes.
 *   Callers should set expectedBars based on the lookback window size and
 *   the minimum data density they consider trustworthy.
 *
 * @throws {InsufficientHistoryCoverageError}
 */
export async function assertHistoryCoverage(
  pool: Pool,
  underlying: string,
  fromMs: number,
  toMs: number,
  expectedBars: number,
): Promise<void> {
  const actualBars = await countHistoryBars(pool, underlying, fromMs, toMs);

  if (actualBars < expectedBars) {
    // Throw-don't-skip: mirrors FROZEN_VIOLATION pattern.
    // Callers that want a soft-disable wrap this in a try/catch and set a
    // per-underlying SR_DISABLED flag for the session.
    throw new InsufficientHistoryCoverageError(underlying, actualBars, expectedBars);
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Computes all objective S/R levels for `underlying` as of the given clock's
 * current date.
 *
 * @param pool         - pg Pool (the TimescaleDB connection pool from src/db/client.ts)
 * @param underlying   - Index symbol, e.g. 'NIFTY', 'BANKNIFTY', 'SENSEX'
 * @param currentSpot  - Current spot price (used for proximity scoring)
 * @param clock        - Injectable clock — never calls Date.now() directly
 * @param config       - Tuning parameters (defaults to DEFAULT_SR_CONFIG)
 *
 * @returns SRLevelResult containing all levels sorted by strength, the set of
 *          level families that contributed, and a poc_used flag.
 *
 * Degradation contract:
 *   - If prev-week data is absent (no ticks in the window): no H/L levels added,
 *     'prev_week_high' and 'prev_week_low' absent from contributed[].
 *   - If monthly data is absent: no pivot levels added, 'pivot' absent.
 *   - If volume is universally null: POC omitted, 'poc' absent from contributed[].
 *   - The function never throws on missing data — it returns fewer levels.
 *     (The coverage guard is a separate explicit call for session-start checks.)
 */
export async function computeSRLevels(
  pool: Pool,
  underlying: string,
  currentSpot: number,
  clock: Clock,
  config: SRConfig = DEFAULT_SR_CONFIG,
): Promise<SRLevelResult> {
  // Determine the "as of" moment in UTC-ms from the clock.
  // We use today()'s IST date string → IST midnight epoch → all comparisons
  // are in UTC-ms throughout, consistent with how TimescaleDB stores timestamps.
  const asOfMs = istDateToUtcMs(clock.today());

  // ------------------------------------------------------------------
  // 1. Previous-week High / Low
  // ------------------------------------------------------------------
  const { from: prevWeekFrom, to: prevWeekTo } = prevIstWeekWindow(asOfMs);

  const prevWeekCandle = await fetchOHLCV(pool, underlying, prevWeekFrom, prevWeekTo);

  // We accumulate all (price, type) pairs then score them together.
  // This two-pass approach lets us compute confluence AFTER all prices are known:
  // confluence requires knowing all OTHER levels' prices before scoring any one level.
  interface RawLevel {
    price: number;
    type: SRLevelType;
    isPoc: boolean;
  }
  const rawLevels: RawLevel[] = [];

  const contributed: SRLevelType[] = [];

  if (prevWeekCandle !== null) {
    rawLevels.push({ price: prevWeekCandle.high, type: 'prev_week_high', isPoc: false });
    rawLevels.push({ price: prevWeekCandle.low, type: 'prev_week_low', isPoc: false });
    // Only add to contributed once per family (both H and L = one contribution)
    if (!contributed.includes('prev_week_high')) contributed.push('prev_week_high');
    if (!contributed.includes('prev_week_low')) contributed.push('prev_week_low');
  }

  // ------------------------------------------------------------------
  // 2. Monthly classic pivot
  // ------------------------------------------------------------------
  const { from: prevMonthFrom, to: prevMonthTo } = prevIstMonthWindow(asOfMs);

  const prevMonthCandle = await fetchOHLCV(pool, underlying, prevMonthFrom, prevMonthTo);

  if (prevMonthCandle !== null) {
    const pivots = computePivotLevels(prevMonthCandle);
    // Add all 5 pivot levels; they all share the 'pivot' type family
    for (const price of [pivots.pp, pivots.r1, pivots.s1, pivots.r2, pivots.s2]) {
      rawLevels.push({ price, type: 'pivot', isPoc: false });
    }
    if (!contributed.includes('pivot')) contributed.push('pivot');
  }

  // ------------------------------------------------------------------
  // 3. Volume POC — uses the same prev-week window as prev-week H/L
  // ------------------------------------------------------------------
  const prevWeekTicks = await fetchTicksForPOC(pool, underlying, prevWeekFrom, prevWeekTo);

  const pocPrice = computePOC(prevWeekTicks, config.poc_bucket_pts);
  const hasPocVolume = pocPrice !== null;

  if (pocPrice !== null) {
    rawLevels.push({ price: pocPrice, type: 'poc', isPoc: true });
    if (!contributed.includes('poc')) contributed.push('poc');
  }

  // ------------------------------------------------------------------
  // 4. Score all levels (requires all prices to be known for confluence)
  // ------------------------------------------------------------------
  const allPrices = rawLevels.map((l) => l.price);

  const levels: SRLevel[] = rawLevels.map((raw) => ({
    price: raw.price,
    type: raw.type,
    strength: scoreLevel(
      raw.price,
      raw.type,
      currentSpot,
      allPrices,
      config,
      hasPocVolume,
    ),
    poc_used: raw.isPoc,
  }));

  // Sort strongest-first so callers can take the top-N without sorting themselves
  levels.sort((a, b) => b.strength - a.strength);

  // poc_used at the result level = true if ANY poc level contributed
  const resultPocUsed = levels.some((l) => l.poc_used);

  return { levels, contributed, poc_used: resultPocUsed };
}
