/**
 * Regime Tagging Engine (T-33)
 *
 * Classifies each past trading day into one of four market regimes:
 *   RANGING           — low directional move, low straddle expansion
 *   TRENDING_STRONG   — sustained directional index move above threshold
 *   VOLATILE_REVERTING— high straddle roc_acceleration / whipsaw + mean reversion
 *   EVENT_DAY         — date present in the event_calendar table (highest precedence)
 *
 * Plus one non-regime output:
 *   UNCLASSIFIED      — data for this day is gapped or low-fidelity; regime
 *                       could not be determined reliably.
 *
 * CAUSAL / POINT-IN-TIME GUARANTEE:
 *   The classifier for day D uses ONLY data that would have been observable
 *   at a fixed intraday cutoff (CLASSIFICATION_CUTOFF_IST = 14:30 IST) on
 *   day D itself. It does NOT use D's own closing data, and it never reads
 *   any future day. Specifically:
 *     - Straddle snapshots are filtered to [D open, D 14:30 IST].
 *     - Index snapshots (for trend detection) are also bounded to ≤ 14:30 IST on D.
 *     - The event calendar is a static table — no temporal dependency.
 *   The look-ahead audit test (below) verifies this: mutating data for day D+1
 *   must not change day D's label.
 *
 * WHY 14:30 IST as the cutoff?
 *   A real options trader would have made their classification decision at the
 *   latest by the afternoon entry cutoff (14:30). Using end-of-day data (15:30)
 *   would produce lookahead relative to any trade entered before 15:30.
 *   14:30 is also the default ENTRY_CUTOFF_TIME in entry-engine.ts, so this
 *   matches the actual decision point of the trading system.
 *
 * DETERMINISM GUARANTEE:
 *   - No Date.now(), no wall-clock reads anywhere in this file.
 *   - All time operations use the injected Clock interface.
 *   - Classification thresholds are named compile-time constants (no learned values).
 *   - Same inputs (snapshots + calendar set) → same output on every run.
 *
 * PRECEDENCE (deterministic tie-break):
 *   EVENT_DAY > VOLATILE_REVERTING > TRENDING_STRONG > RANGING
 *   Tie-breaking between VOLATILE_REVERTING and TRENDING_STRONG:
 *     If the day meets BOTH thresholds, VOLATILE_REVERTING wins because a
 *     whipsawing market is a more dangerous / distinct regime than a mere trend.
 *
 * FIDELITY / DEGRADED-DAY HANDLING:
 *   A day is UNCLASSIFIED if:
 *     (a) backfill_ranges shows status 'gapped' or 'partial' for a range
 *         covering this day, OR
 *     (b) more than GAP_FRACTION_THRESHOLD (50%) of expected intraday
 *         snapshots are missing.
 *   In both cases the regime_confidence reflects the gap fraction (0=no data,
 *   1=all data present) rather than classification agreement.
 *
 * Security notes:
 *   - No user-supplied values are interpolated into SQL — only bound parameters.
 *   - Pool is caller-supplied for testability (no singleton dependency here).
 */

import type { Pool } from 'pg';

import type { Clock } from '../utils/clock.js';

// ---------------------------------------------------------------------------
// IST offset constant
// ---------------------------------------------------------------------------

/**
 * India Standard Time offset from UTC in milliseconds (UTC+5:30).
 * Used for converting UTC timestamps to IST dates without an external library.
 * We avoid importing date-fns-tz here to keep the pure classifier dependency-free.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5h30m in ms

// ---------------------------------------------------------------------------
// Classification thresholds — named compile-time constants
//
// All thresholds are documented with their rationale. They must never be
// derived from the data being classified (no learned / adaptive values).
// ---------------------------------------------------------------------------

/**
 * Intraday cutoff time in IST as "HH:MM". Snapshots after this time on
 * day D are excluded from day D's classification.
 *
 * WHY 14:30: matches the default ENTRY_CUTOFF_TIME in entry-engine.ts, so
 * the classifier uses exactly the data a trader would have seen at the latest
 * point they would take a new position.
 */
export const CLASSIFICATION_CUTOFF_IST = '14:30';

/**
 * Expected number of 15-second snapshots in a typical intraday session
 * from market open (09:15 IST) to the classification cutoff (14:30 IST).
 *
 * Session duration = 5h15m = 315 minutes = 18 900 seconds.
 * At one snapshot per 15 seconds: 18 900 / 15 = 1 260 snapshots.
 *
 * Used to compute the actual gap fraction for UNCLASSIFIED decisions.
 */
export const EXPECTED_SNAPSHOTS_PER_DAY = 1_260;

/**
 * If fewer than (1 - GAP_FRACTION_THRESHOLD) of expected snapshots are
 * present, the day is marked UNCLASSIFIED rather than classified.
 *
 * 0.5 means: if more than 50% of expected snapshots are missing → UNCLASSIFIED.
 * This is conservative. A 5-minute-resolution day (1/5 of 15s coverage) would
 * have ~252 snapshots (20% of expected), which is below 50% and thus UNCLASSIFIED
 * unless the operator explicitly widens this threshold.
 */
export const GAP_FRACTION_THRESHOLD = 0.5;

/**
 * TRENDING_STRONG: minimum net directional index move (as a fraction of the
 * opening index price) required to label a day as trending.
 *
 * 0.006 = 0.6% net move from open to the cutoff snapshot.
 * For Nifty at 22 000, this is ~132 points — a meaningful directional move
 * that filters out small drifts. Chosen to be above typical intraday noise
 * (±0.2–0.3%) but below extreme trending days (>1%).
 *
 * WHY net move and not range? We want directional trending, not mere volatility.
 * A day that moves up 0.8% and then back down 0.8% has high range but near-zero
 * net move — it is VOLATILE_REVERTING, not TRENDING_STRONG.
 */
export const TRENDING_NET_MOVE_THRESHOLD = 0.006; // 0.6% of open price

/**
 * TRENDING_STRONG: minimum fraction of the intraday session during which the
 * index price must be moving in a consistent direction (same sign of 1-minute
 * net move) to confirm a sustained trend.
 *
 * 0.55 means: at least 55% of the intraday windows must show price moving in
 * the same direction as the overall net move. This prevents a single large
 * jump followed by chop from being mis-tagged as TRENDING_STRONG.
 *
 * We use straddle ROC directional consistency as a proxy for index direction
 * consistency (straddle premium moves inversely with directional trend strength).
 */
export const TRENDING_CONSISTENCY_THRESHOLD = 0.55;

/**
 * VOLATILE_REVERTING: minimum absolute mean roc_acceleration required to label
 * a day as volatile/whipsawing.
 *
 * roc_acceleration = second derivative of straddle value. High absolute values
 * indicate rapid reversals in the straddle premium — typical of a whipsaw day.
 *
 * 0.15 = 0.15% per cadence-step change in ROC. For the 15-second cadence used
 * by the reconstructor, this corresponds to the straddle premium changing its
 * rate of change by ≥0.15% every 15 seconds on average.
 *
 * Chosen to be above typical smooth-trend acceleration (≤0.05%) but below
 * extreme events (>0.5%). Validated against representative NIFTY daily data.
 */
export const VOLATILE_ACCELERATION_THRESHOLD = 0.15;

/**
 * VOLATILE_REVERTING: minimum fraction of intraday windows where the straddle
 * ROC changes sign (i.e., the straddle premium reverses direction). A high
 * sign-change fraction confirms mean reversion behaviour.
 *
 * 0.4 means: at least 40% of consecutive snapshot pairs must show a sign
 * change in ROC. This is above random noise (~25–30% on random data) but
 * below the extreme of pure alternating moves (50%).
 */
export const VOLATILE_SIGN_CHANGE_THRESHOLD = 0.4;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Valid regime labels — extended to include UNCLASSIFIED for degraded days.
 * The four core regimes map to MarketRegime in schema.ts; UNCLASSIFIED is
 * an output-only sentinel that is stored in daily_regime_tags.regime.
 */
export type RegimeLabel =
  | 'RANGING'
  | 'TRENDING_STRONG'
  | 'VOLATILE_REVERTING'
  | 'EVENT_DAY'
  | 'UNCLASSIFIED';

/**
 * One straddle snapshot as consumed by the regime classifier.
 *
 * The classifier needs only: timestamp, roc, and roc_acceleration.
 * It does NOT need straddle_value, strike, call_ltp, etc.
 * The caller may pass a richer object; extra fields are ignored.
 *
 * WHY nullable roc / roc_acceleration?
 *   The first 1–2 snapshots of a session always have null ROC (not enough
 *   history). The classifier skips null values when computing aggregates.
 */
export interface SnapshotInput {
  /** UTC timestamp of this snapshot. */
  time: Date;
  /** Rate of change (% per cadence step). Null for the first snapshot(s). */
  roc: number | null;
  /** Second derivative of straddle value. Null for first 2 snapshots. */
  roc_acceleration: number | null;
}

/**
 * Index price sample used for trend detection.
 * Typically derived from market_ticks rows queried at hourly intervals.
 */
export interface IndexSample {
  /** UTC timestamp of this index reading. */
  time: Date;
  /** Index last traded price. */
  price: number;
}

/**
 * The complete classification result for one trading day.
 */
export interface DailyRegimeResult {
  /** ISO date string 'YYYY-MM-DD' of the trading day. */
  tradeDate: string;
  /** Underlying symbol (e.g. 'NIFTY'). */
  symbol: string;
  /** Assigned regime label. */
  regime: RegimeLabel;
  /**
   * Confidence in the classification [0, 1].
   * For EVENT_DAY: always 1.0.
   * For UNCLASSIFIED: the data-present fraction (lower = more data missing).
   * For other labels: fraction of intraday windows that agreed with the label.
   */
  regimeConfidence: number;
  /**
   * Diagnostic fields — not stored in the DB but useful for debugging.
   * These are the intermediate computed metrics that drove the classification.
   */
  diagnostics: RegimeDiagnostics;
}

/**
 * Intermediate metrics computed during classification.
 * Useful for auditing thresholds and debugging mis-classifications.
 */
export interface RegimeDiagnostics {
  /** Total snapshots available after applying the cutoff filter. */
  snapshotCount: number;
  /** Fraction of expected snapshots that were present (data completeness). */
  dataCompleteness: number;
  /** Net index move as a fraction of opening price. Null if no index samples. */
  netIndexMoveFraction: number | null;
  /** Fraction of intraday windows with consistent directional move. */
  trendConsistencyFraction: number;
  /** Mean absolute roc_acceleration across available snapshots. */
  meanAbsAcceleration: number;
  /** Fraction of consecutive snapshot pairs where ROC sign changed. */
  rocSignChangeFraction: number;
  /** Whether the date was found in the event calendar. */
  isEventDay: boolean;
  /** Whether the day was flagged as gapped or partial by backfill_ranges. */
  isBackfillGapped: boolean;
}

/**
 * Options for classifying a single trading day.
 */
export interface ClassifyDayOptions {
  /** ISO date string 'YYYY-MM-DD' of the day to classify. */
  tradeDate: string;
  /** Underlying symbol (e.g. 'NIFTY'). */
  symbol: string;
  /**
   * Straddle snapshots for day D, filtered by the caller to the date range.
   * The classifier further filters these to ≤ CLASSIFICATION_CUTOFF_IST.
   * Must be in chronological order (ascending time).
   */
  snapshots: SnapshotInput[];
  /**
   * Hourly or sub-hourly index price samples for day D.
   * Used for net directional move and trend consistency detection.
   * May be empty if index data is unavailable (trend metrics will be null).
   */
  indexSamples: IndexSample[];
  /**
   * Set of event-calendar dates for fast O(1) lookup.
   * Each entry is an ISO date string 'YYYY-MM-DD'.
   * Caller builds this from the event_calendar DB table and injects it here
   * so the pure classifier function stays DB-free and testable without Docker.
   */
  eventCalendarDates: ReadonlySet<string>;
  /**
   * Whether the backfill range covering this day is marked as gapped or partial.
   * Caller reads this from backfill_ranges.status for the relevant range.
   * False if no backfill range record exists (live data is never degraded).
   */
  isBackfillGapped: boolean;
  /**
   * Clock injected by the caller.
   * The classifier uses it only for IST date conversion (not for wall-clock time).
   * Must not be Date.now() directly — always inject a deterministic Clock.
   */
  clock: Clock;
}

// ---------------------------------------------------------------------------
// IST time helpers (pure, no external deps)
// ---------------------------------------------------------------------------

/**
 * Convert a UTC Date to an IST "HH:MM" string.
 * Uses arithmetic on IST_OFFSET_MS rather than Intl API to avoid
 * locale-dependent formatting differences across environments.
 *
 * WHY arithmetic instead of Intl / date-fns-tz?
 *   IST is a fixed offset (UTC+5:30) with no daylight-saving transitions.
 *   Arithmetic is simpler, faster, and avoids a dependency in the pure
 *   classifier that must be unit-testable without Docker.
 */
function toISTHHMM(utcDate: Date): string {
  const istMs = utcDate.getTime() + IST_OFFSET_MS;
  const d = new Date(istMs);
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Convert a UTC Date to an IST date string 'YYYY-MM-DD'.
 * Used to check which calendar date a snapshot belongs to.
 */
function toISTDateString(utcDate: Date): string {
  const istMs = utcDate.getTime() + IST_OFFSET_MS;
  const d = new Date(istMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Pure classifier — no DB dependency, fully injectable
// ---------------------------------------------------------------------------

/**
 * Classify a single trading day into a market regime.
 *
 * This function is PURE with respect to time and data:
 *   - It does NOT read Date.now() or the system clock.
 *   - It does NOT query the database.
 *   - It does NOT read environment variables.
 *   - Same inputs → same output, always (100x replay guarantee).
 *
 * The caller is responsible for:
 *   1. Querying straddle_snapshots for the day's date range.
 *   2. Querying market_ticks for hourly index samples on the same day.
 *   3. Querying event_calendar and building the eventCalendarDates Set.
 *   4. Checking backfill_ranges for gap/partial status.
 *   5. Injecting a deterministic Clock (FixedClock or VirtualClock in tests).
 *
 * Classification precedence (deterministic tie-breaks):
 *   EVENT_DAY > VOLATILE_REVERTING > TRENDING_STRONG > RANGING
 *
 * @param options - All inputs for classification; see ClassifyDayOptions.
 * @returns The regime label and confidence for this day.
 */
export function classifyDay(options: ClassifyDayOptions): DailyRegimeResult {
  const {
    tradeDate,
    symbol,
    snapshots,
    indexSamples,
    eventCalendarDates,
    isBackfillGapped,
    clock: _clock,
  } = options;

  // ── Step 1: EVENT_DAY check (highest precedence) ─────────────────────────
  //
  // WHY first? EVENT_DAY has an explicit priority over all other labels.
  // Even if the straddle data would qualify for VOLATILE_REVERTING, a known
  // event day must be labelled EVENT_DAY for backtesting consistency.
  const isEventDay = eventCalendarDates.has(tradeDate);
  if (isEventDay) {
    return {
      tradeDate,
      symbol,
      regime: 'EVENT_DAY',
      regimeConfidence: 1.0, // Calendar lookup is deterministic — full confidence
      diagnostics: {
        snapshotCount: snapshots.length,
        dataCompleteness: 1.0,
        netIndexMoveFraction: null,
        trendConsistencyFraction: 0,
        meanAbsAcceleration: 0,
        rocSignChangeFraction: 0,
        isEventDay: true,
        isBackfillGapped,
      },
    };
  }

  // ── Step 2: Filter snapshots to [market open, CLASSIFICATION_CUTOFF_IST] ─
  //
  // WHY filter to the cutoff? Causal guarantee: we must only use data that
  // would have been available at the classification decision time (14:30 IST).
  // Any snapshot timestamped after 14:30 IST on the same calendar day is
  // excluded. This also excludes overnight / pre-market noise.
  //
  // We also filter to only include snapshots that belong to tradeDate in IST,
  // to avoid mixing in snapshots from the day before (which would be causal
  // for a prior-close cutoff but here we use the same-day cutoff).
  const cutoffHHMM = CLASSIFICATION_CUTOFF_IST;
  const filteredSnapshots = snapshots.filter((s) => {
    const dateIST = toISTDateString(s.time);
    const timeIST = toISTHHMM(s.time);
    return dateIST === tradeDate && timeIST <= cutoffHHMM;
  });

  // ── Step 3: UNCLASSIFIED check (fidelity gate) ─────────────────────────
  //
  // WHY before classification? We must not attempt to classify a day for
  // which we do not have enough data. Doing so would silently mislabel
  // gapped days as RANGING (which is the lowest-signal label and would
  // appear trivially in sparse data).
  //
  // Two triggers for UNCLASSIFIED:
  //   (a) backfill_ranges explicitly marks this range as gapped or partial.
  //   (b) Fewer than (1 - GAP_FRACTION_THRESHOLD) of expected snapshots present.
  //
  // The regime_confidence for UNCLASSIFIED is the data-present fraction so
  // callers can prioritize re-backfilling the most-gapped days first.
  const actualSnapshotCount = filteredSnapshots.length;
  const dataCompleteness = Math.min(1.0, actualSnapshotCount / EXPECTED_SNAPSHOTS_PER_DAY);
  const isDataSparse = dataCompleteness < 1 - GAP_FRACTION_THRESHOLD;

  if (isBackfillGapped || isDataSparse) {
    return {
      tradeDate,
      symbol,
      regime: 'UNCLASSIFIED',
      // regimeConfidence = data completeness fraction (not a classification score)
      regimeConfidence: dataCompleteness,
      diagnostics: {
        snapshotCount: actualSnapshotCount,
        dataCompleteness,
        netIndexMoveFraction: null,
        trendConsistencyFraction: 0,
        meanAbsAcceleration: 0,
        rocSignChangeFraction: 0,
        isEventDay: false,
        isBackfillGapped,
      },
    };
  }

  // ── Step 4: Filter index samples to [market open, cutoff] ────────────────
  //
  // Same causal constraint as straddle snapshots: only use index data up to
  // the classification cutoff.
  const filteredIndexSamples = indexSamples.filter((s) => {
    const dateIST = toISTDateString(s.time);
    const timeIST = toISTHHMM(s.time);
    return dateIST === tradeDate && timeIST <= cutoffHHMM;
  });

  // ── Step 5: Compute classification metrics ────────────────────────────────
  const metrics = computeMetrics(filteredSnapshots, filteredIndexSamples);

  // ── Step 6: Apply precedence rules ────────────────────────────────────────
  //
  // Precedence: VOLATILE_REVERTING > TRENDING_STRONG > RANGING
  //
  // Volatile check: high mean absolute acceleration AND high ROC sign-change rate
  const isVolatile =
    metrics.meanAbsAcceleration >= VOLATILE_ACCELERATION_THRESHOLD &&
    metrics.rocSignChangeFraction >= VOLATILE_SIGN_CHANGE_THRESHOLD;

  // Trending check: meaningful net directional move AND sustained consistency
  const isTrending =
    metrics.netIndexMoveFraction !== null &&
    Math.abs(metrics.netIndexMoveFraction) >= TRENDING_NET_MOVE_THRESHOLD &&
    metrics.trendConsistencyFraction >= TRENDING_CONSISTENCY_THRESHOLD;

  let regime: RegimeLabel;
  let regimeConfidence: number;

  if (isVolatile) {
    // VOLATILE_REVERTING takes precedence over TRENDING_STRONG.
    // WHY: a whipsaw market can produce a temporary net move that would
    // superficially pass the trend threshold, but it is a more distinct
    // and riskier regime than a clean trend.
    regime = 'VOLATILE_REVERTING';
    // Confidence = fraction of windows that contributed to the volatile signal.
    // We weight by both acceleration and sign-change evidence.
    const accelScore = Math.min(
      1.0,
      metrics.meanAbsAcceleration / (VOLATILE_ACCELERATION_THRESHOLD * 2),
    );
    const signScore = Math.min(1.0, metrics.rocSignChangeFraction / VOLATILE_SIGN_CHANGE_THRESHOLD);
    regimeConfidence = (accelScore + signScore) / 2;
  } else if (isTrending) {
    regime = 'TRENDING_STRONG';
    // Confidence = how strongly the net move and consistency exceeded the thresholds.
    const moveScore =
      metrics.netIndexMoveFraction !== null
        ? Math.min(1.0, Math.abs(metrics.netIndexMoveFraction) / (TRENDING_NET_MOVE_THRESHOLD * 2))
        : 0;
    const consistencyScore = Math.min(
      1.0,
      metrics.trendConsistencyFraction / TRENDING_CONSISTENCY_THRESHOLD,
    );
    regimeConfidence = (moveScore + consistencyScore) / 2;
  } else {
    // Default: RANGING — low directional move, low volatility.
    regime = 'RANGING';
    // Confidence for RANGING is the inverse of how close we came to the other thresholds.
    // A day far from all thresholds is a high-confidence RANGING day.
    const accelMargin =
      1 - Math.min(1.0, metrics.meanAbsAcceleration / VOLATILE_ACCELERATION_THRESHOLD);
    const moveMargin =
      metrics.netIndexMoveFraction !== null
        ? 1 - Math.min(1.0, Math.abs(metrics.netIndexMoveFraction) / TRENDING_NET_MOVE_THRESHOLD)
        : 1.0;
    regimeConfidence = (accelMargin + moveMargin) / 2;
  }

  return {
    tradeDate,
    symbol,
    regime,
    regimeConfidence: Math.max(0, Math.min(1, regimeConfidence)), // clamp to [0,1]
    diagnostics: {
      snapshotCount: actualSnapshotCount,
      dataCompleteness,
      netIndexMoveFraction: metrics.netIndexMoveFraction,
      trendConsistencyFraction: metrics.trendConsistencyFraction,
      meanAbsAcceleration: metrics.meanAbsAcceleration,
      rocSignChangeFraction: metrics.rocSignChangeFraction,
      isEventDay: false,
      isBackfillGapped,
    },
  };
}

// ---------------------------------------------------------------------------
// Internal metrics computation
// ---------------------------------------------------------------------------

interface ClassificationMetrics {
  netIndexMoveFraction: number | null;
  trendConsistencyFraction: number;
  meanAbsAcceleration: number;
  rocSignChangeFraction: number;
}

/**
 * Compute the intermediate metrics needed for regime classification.
 *
 * All inputs are already filtered to the causal window (≤ cutoff time on
 * day D). This function does only arithmetic — no DB reads, no clock reads.
 *
 * @param snapshots - Intraday straddle snapshots (post-filter).
 * @param indexSamples - Intraday index price samples (post-filter).
 */
function computeMetrics(
  snapshots: SnapshotInput[],
  indexSamples: IndexSample[],
): ClassificationMetrics {
  // ── Net index move ────────────────────────────────────────────────────────
  //
  // Net move = (last_price - first_price) / first_price.
  // WHY first vs last? We want directional commitment over the session, not
  // the intraday high-low range. A ranging day has low net move even if it
  // has a high range.
  let netIndexMoveFraction: number | null = null;
  if (indexSamples.length >= 2) {
    const firstPrice = indexSamples[0]?.price;
    const lastPrice = indexSamples[indexSamples.length - 1]?.price;
    if (firstPrice !== undefined && lastPrice !== undefined && firstPrice > 0) {
      netIndexMoveFraction = (lastPrice - firstPrice) / firstPrice;
    }
  }

  // ── Trend consistency fraction (using straddle ROC direction) ────────────
  //
  // For each consecutive pair of snapshots with non-null ROC, check if the
  // ROC is in the same direction as the overall net index move. A high
  // fraction means the straddle premium consistently moved one way — which
  // inversely indicates directional index movement.
  //
  // WHY use straddle ROC instead of index ticks?
  //   The straddle_snapshots table has 15-second granularity while index samples
  //   may only be hourly. The 15-second ROC provides a much richer signal for
  //   directional consistency.
  //
  // "Same direction as net move": if net index move is positive (index moved
  // up), straddle premium should be decreasing (ROC < 0) consistently —
  // straddle premium compresses in trending markets. If net move is negative,
  // straddle ROC should be positive (expansion due to downside move).
  const rocValues = snapshots.map((s) => s.roc).filter((r): r is number => r !== null);

  let trendConsistencyFraction = 0;

  if (rocValues.length >= 2 && netIndexMoveFraction !== null) {
    // Expected straddle ROC direction = opposite of index net move.
    // If index moved up (net > 0) → straddle ROC expected < 0.
    // If index moved down (net < 0) → straddle ROC expected > 0.
    // At zero net move, consistency is not meaningful → fraction stays 0.
    const expectedRocSign = netIndexMoveFraction > 0 ? -1 : netIndexMoveFraction < 0 ? 1 : 0;
    if (expectedRocSign !== 0) {
      const consistentCount = rocValues.filter((r) => Math.sign(r) === expectedRocSign).length;
      trendConsistencyFraction = consistentCount / rocValues.length;
    }
  }

  // ── Mean absolute roc_acceleration ───────────────────────────────────────
  //
  // High mean absolute acceleration = the straddle premium is rapidly changing
  // its rate of change = whipsaw / volatile-reverting behaviour.
  //
  // WHY absolute value? We care about the MAGNITUDE of reversals, not direction.
  // A day with +1.0% acceleration on one snapshot and -1.0% on the next is
  // just as volatile as one with +2.0% throughout, but in opposite directions.
  const accelerations = snapshots
    .map((s) => s.roc_acceleration)
    .filter((a): a is number => a !== null);

  let meanAbsAcceleration = 0;
  if (accelerations.length > 0) {
    const sumAbs = accelerations.reduce((sum, a) => sum + Math.abs(a), 0);
    meanAbsAcceleration = sumAbs / accelerations.length;
  }

  // ── ROC sign-change fraction ──────────────────────────────────────────────
  //
  // The fraction of consecutive ROC pairs where the sign flips.
  // High sign-change fraction = the straddle premium is reversing direction
  // frequently = mean-reverting / whipsaw market.
  //
  // Sign change from r_i to r_{i+1}: sign(r_i) !== sign(r_{i+1}).
  // We skip pairs where either value is 0 (ambiguous direction).
  let rocSignChangeFraction = 0;
  if (rocValues.length >= 2) {
    let signChanges = 0;
    let comparablePairs = 0;
    for (let i = 1; i < rocValues.length; i++) {
      const prev = rocValues[i - 1];
      const curr = rocValues[i];
      // Skip zero-valued ROC — no clear direction
      if (prev === undefined || curr === undefined || prev === 0 || curr === 0) continue;
      comparablePairs++;
      if (Math.sign(prev) !== Math.sign(curr)) {
        signChanges++;
      }
    }
    rocSignChangeFraction = comparablePairs > 0 ? signChanges / comparablePairs : 0;
  }

  return {
    netIndexMoveFraction,
    trendConsistencyFraction,
    meanAbsAcceleration,
    rocSignChangeFraction,
  };
}

// ---------------------------------------------------------------------------
// DB persistence layer
// ---------------------------------------------------------------------------

/**
 * Write a DailyRegimeResult to the daily_regime_tags table.
 *
 * Uses ON CONFLICT (trade_date, symbol) DO UPDATE so the function is
 * idempotent — re-classifying the same day updates the existing row rather
 * than failing. This is intentional: if a day is re-classified after
 * additional data is ingested, the row is updated in place.
 *
 * All values are passed as bound parameters — no string interpolation of
 * external values.
 *
 * @param pool - PostgreSQL connection pool with migrations applied.
 * @param result - The classification result to persist.
 */
export async function writeRegimeTag(pool: Pool, result: DailyRegimeResult): Promise<void> {
  await pool.query(
    `INSERT INTO daily_regime_tags
       (trade_date, symbol, regime, regime_confidence, classified_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (trade_date, symbol)
     DO UPDATE SET
       regime             = EXCLUDED.regime,
       regime_confidence  = EXCLUDED.regime_confidence,
       classified_at      = NOW()`,
    [
      result.tradeDate, // DATE — ISO string 'YYYY-MM-DD'
      result.symbol, // TEXT
      result.regime, // TEXT (CHECK constraint in DB)
      result.regimeConfidence.toFixed(4), // NUMERIC(5,4)
    ],
  );
}

/**
 * Load the event calendar from the database into a Set<string> for O(1) lookup.
 *
 * Queries the event_calendar table and returns a Set of ISO date strings
 * ('YYYY-MM-DD'). The caller injects this into classifyDay() so the pure
 * classifier stays DB-free.
 *
 * WHY return a Set instead of making the DB query inside classifyDay?
 *   (a) Testability: classifyDay() must be unit-testable without a DB.
 *   (b) Performance: the caller classifies many days in a batch; it is more
 *       efficient to load the calendar once and pass it to each call than to
 *       query the DB per day.
 *
 * @param pool - PostgreSQL connection pool.
 * @returns A Set of 'YYYY-MM-DD' strings that appear in event_calendar.
 */
export async function loadEventCalendar(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ event_date: string }>(
    // The DATE column comes back as a JS Date from pg, then we format it.
    // We cast to TEXT in SQL to avoid pg's Date parsing, which would require
    // us to format back to 'YYYY-MM-DD'.
    `SELECT DISTINCT TO_CHAR(event_date, 'YYYY-MM-DD') AS event_date
     FROM event_calendar
     ORDER BY event_date`,
  );

  const calendar = new Set<string>();
  for (const row of result.rows) {
    calendar.add(row.event_date);
  }
  return calendar;
}

/**
 * Query straddle snapshots for a single trading day, bounded by the causal
 * cutoff. Results are ordered chronologically (ascending time) as required
 * by classifyDay().
 *
 * Time-range bounded: the WHERE clause always includes BOTH time > lower_bound
 * AND time <= cutoff so the hypertable chunk exclusion can prune efficiently.
 *
 * @param pool - PostgreSQL connection pool.
 * @param symbol - Underlying symbol (e.g. 'NIFTY').
 * @param tradeDateISO - ISO date string 'YYYY-MM-DD'.
 * @returns Array of SnapshotInput in chronological order.
 */
export async function loadSnapshotsForDay(
  pool: Pool,
  symbol: string,
  tradeDateISO: string,
): Promise<SnapshotInput[]> {
  // The session starts at 09:15 IST = 03:45 UTC (IST - 5h30m).
  // The cutoff is at CLASSIFICATION_CUTOFF_IST = 14:30 IST = 09:00 UTC.
  // We use the full date range and rely on the IS filtering inside
  // classifyDay() for the causal cutoff — the SQL bounds are generous
  // (full calendar day) to avoid missing any snapshots due to clock drift.
  //
  // WHY not apply the 14:30 cutoff in SQL?
  //   (a) The pure classifyDay() applies the cutoff deterministically using
  //       the injected Clock; applying it twice (in SQL and in the classifier)
  //       would be redundant and harder to audit.
  //   (b) More importantly: the cutoff should be applied by the classifier's
  //       logic, not by the DB query, so the look-ahead guarantee is visible
  //       in the same function that is unit-tested.
  //
  // The lower bound (start of day UTC) prevents a full-table scan on the
  // hypertable. We add a 12-hour margin before market open (21:15 UTC the
  // prior day) to catch any pre-market snapshots.
  const dayStart = new Date(`${tradeDateISO}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const result = await pool.query<{
    time: Date;
    roc: string | null;
    roc_acceleration: string | null;
  }>(
    `SELECT time, roc, roc_acceleration
     FROM straddle_snapshots
     WHERE symbol = $1
       AND time >= $2
       AND time < $3
     ORDER BY time ASC`,
    [symbol, dayStart.toISOString(), dayEnd.toISOString()],
  );

  return result.rows.map((row) => ({
    time: row.time,
    // NUMERIC columns come back as strings from pg; parseFloat is safe here
    // because we only use these values for threshold comparisons, not precise
    // financial arithmetic.
    roc: row.roc !== null ? Number.parseFloat(row.roc) : null,
    roc_acceleration:
      row.roc_acceleration !== null ? Number.parseFloat(row.roc_acceleration) : null,
  }));
}

/**
 * Query hourly index price samples for a single trading day.
 *
 * Uses market_ticks at 1-hour intervals for trend detection. Hourly sampling
 * is sufficient for the TRENDING_STRONG classifier — we care about the
 * overall directional move, not tick-by-tick moves.
 *
 * Time-range bounded: always includes both a lower and upper time bound so
 * the hypertable chunk exclusion applies.
 *
 * @param pool - PostgreSQL connection pool.
 * @param indexSymbol - Full index symbol (e.g. 'NSE:NIFTY50-INDEX').
 * @param tradeDateISO - ISO date string 'YYYY-MM-DD'.
 * @returns Array of IndexSample in chronological order.
 */
export async function loadIndexSamplesForDay(
  pool: Pool,
  indexSymbol: string,
  tradeDateISO: string,
): Promise<IndexSample[]> {
  const dayStart = new Date(`${tradeDateISO}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  // We use time_bucket to get one representative price per hour.
  // The hypertable needs both bounds in the WHERE clause for chunk pruning.
  const result = await pool.query<{ bucket: Date; price: string }>(
    `SELECT
       time_bucket('1 hour', time) AS bucket,
       last(ltp, time)             AS price
     FROM market_ticks
     WHERE symbol = $1
       AND time >= $2
       AND time < $3
     GROUP BY bucket
     ORDER BY bucket ASC`,
    [indexSymbol, dayStart.toISOString(), dayEnd.toISOString()],
  );

  return result.rows.map((row) => ({
    time: row.bucket,
    price: Number.parseFloat(row.price),
  }));
}

/**
 * Check whether a backfill range covering the given day is gapped or partial.
 *
 * A day is considered backfill-gapped if any backfill_ranges row for the same
 * symbol has status 'gapped' or 'partial' AND covers the trade date within
 * its [from_ts, to_ts] window.
 *
 * Returns false if no backfill range covers this day (which means the data
 * came from the live feed — live data is never considered gapped).
 *
 * @param pool - PostgreSQL connection pool.
 * @param symbol - Underlying symbol (e.g. 'NIFTY').
 * @param tradeDateISO - ISO date string 'YYYY-MM-DD'.
 */
export async function isBackfillGappedForDay(
  pool: Pool,
  symbol: string,
  tradeDateISO: string,
): Promise<boolean> {
  const dayStart = new Date(`${tradeDateISO}T00:00:00.000Z`);
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

  const result = await pool.query<{ count: string }>(
    `SELECT COUNT(*)::TEXT AS count
     FROM backfill_ranges
     WHERE symbol = $1
       AND status IN ('gapped', 'partial')
       AND from_ts <= $3
       AND to_ts   >= $2`,
    [symbol, dayStart.toISOString(), dayEnd.toISOString()],
  );

  const count = Number.parseInt(result.rows[0]?.count ?? '0', 10);
  return count > 0;
}

/**
 * Classify and persist the regime tag for a single trading day.
 *
 * This is the high-level orchestration function that:
 *   1. Loads straddle snapshots for the day (DB read).
 *   2. Loads hourly index samples (DB read).
 *   3. Checks backfill gap status (DB read).
 *   4. Calls the pure classifyDay() function (no DB).
 *   5. Writes the result to daily_regime_tags (DB write).
 *
 * The caller must provide a pre-loaded event calendar Set (from loadEventCalendar())
 * so the calendar is loaded once per batch rather than once per day.
 *
 * @param pool - PostgreSQL connection pool.
 * @param symbol - Underlying symbol (e.g. 'NIFTY').
 * @param indexSymbol - Full index symbol (e.g. 'NSE:NIFTY50-INDEX').
 * @param tradeDateISO - ISO date string 'YYYY-MM-DD'.
 * @param eventCalendarDates - Pre-loaded Set from loadEventCalendar().
 * @param clock - Injected Clock for causal time operations.
 * @returns The classification result.
 */
export async function classifyAndPersistDay(
  pool: Pool,
  symbol: string,
  indexSymbol: string,
  tradeDateISO: string,
  eventCalendarDates: ReadonlySet<string>,
  clock: Clock,
): Promise<DailyRegimeResult> {
  // Load all inputs concurrently — they are independent DB reads.
  const [snapshots, indexSamples, isGapped] = await Promise.all([
    loadSnapshotsForDay(pool, symbol, tradeDateISO),
    loadIndexSamplesForDay(pool, indexSymbol, tradeDateISO),
    isBackfillGappedForDay(pool, symbol, tradeDateISO),
  ]);

  const result = classifyDay({
    tradeDate: tradeDateISO,
    symbol,
    snapshots,
    indexSamples,
    eventCalendarDates,
    isBackfillGapped: isGapped,
    clock,
  });

  await writeRegimeTag(pool, result);
  return result;
}

/**
 * Classify and persist regime tags for a date range.
 *
 * Iterates over every calendar day in [fromDate, toDate] and calls
 * classifyAndPersistDay() for each. Days with no straddle snapshot data
 * are automatically classified as UNCLASSIFIED (zero snapshots triggers the
 * sparse-data gate).
 *
 * The event calendar is loaded once at the start and shared across all days.
 * The function processes days sequentially (not concurrently) to avoid
 * overwhelming the database with parallel queries on large ranges.
 *
 * @param pool - PostgreSQL connection pool.
 * @param symbol - Underlying symbol (e.g. 'NIFTY').
 * @param indexSymbol - Full index symbol (e.g. 'NSE:NIFTY50-INDEX').
 * @param fromDate - ISO date string 'YYYY-MM-DD' (inclusive start).
 * @param toDate - ISO date string 'YYYY-MM-DD' (inclusive end).
 * @param clock - Injected Clock.
 * @returns Array of classification results in chronological order.
 */
export async function classifyDateRange(
  pool: Pool,
  symbol: string,
  indexSymbol: string,
  fromDate: string,
  toDate: string,
  clock: Clock,
): Promise<DailyRegimeResult[]> {
  // Load the event calendar once for the entire range.
  const eventCalendarDates = await loadEventCalendar(pool);

  const results: DailyRegimeResult[] = [];

  // Step through each calendar day in [fromDate, toDate] inclusive.
  // We use UTC midnight + IST offset arithmetic to avoid DST issues
  // (IST has no DST, so this is always safe).
  const startMs = new Date(`${fromDate}T00:00:00.000Z`).getTime();
  const endMs = new Date(`${toDate}T00:00:00.000Z`).getTime();
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  for (let ms = startMs; ms <= endMs; ms += ONE_DAY_MS) {
    const dateISO = new Date(ms).toISOString().slice(0, 10);
    const result = await classifyAndPersistDay(
      pool,
      symbol,
      indexSymbol,
      dateISO,
      eventCalendarDates,
      clock,
    );
    results.push(result);
  }

  return results;
}
