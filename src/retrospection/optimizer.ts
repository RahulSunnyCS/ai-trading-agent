/**
 * optimizer.ts — Guarded deterministic 1-D optimizer for min_probability (T-46)
 *
 * Implements Decision-1 Option B: a GUARDED DETERMINISTIC 1-D optimizer.
 * No Gaussian Process, no matrix math. GP is explicitly deferred to Phase 2.
 *
 * Algorithm:
 *   Golden-section search over min_probability ∈ [MIN_PROBABILITY_LOWER, MIN_PROBABILITY_UPPER]
 *   for a single momentum_exhaustion personality. The objective is evaluated on
 *   retrospection_results rows from the TRAIN window only — the holdout period
 *   (most recent OPTIMIZER_HOLDOUT_DAYS trading days) is never read, preventing
 *   overfitting.
 *
 * Objective metric:
 *   We use a composite score: if `sharpe` is available and non-null for the
 *   majority of training rows, we average it directly (risk-adjusted return).
 *   Otherwise we fall back to the average `beat_clockwork_delta` (outperformance
 *   vs the frozen Clockwork benchmark). Both metrics already incorporate regime
 *   filtering because they are written per-day with a market_regime tag that lets
 *   us filter to consistent conditions.
 *
 *   Rationale for preferring Sharpe over raw beat_clockwork_delta:
 *     - Sharpe penalises volatility of returns, not just magnitude, which prevents
 *       the optimizer from selecting a threshold that occasionally hits big but is
 *       erratic day-to-day — a desirable property for a research platform tracking
 *       consistent edge.
 *     - beat_clockwork_delta is a fallback because some training rows may predate
 *       the Sharpe column (migration 010). It is still regime-normalised via the
 *       market_regime tag in the same row.
 *
 *   The objective is evaluated for a fixed `candidate` min_probability by querying
 *   the training rows for the personality filtered to rows where the stored
 *   `proposed_adjustments.min_probability` is closest to the candidate. Because
 *   we do not actually re-run the simulation at each candidate (that would require
 *   running the full paper-trade pipeline, which is the domain of the backtest
 *   runner T-51), we instead use an interpolated approximation:
 *
 *     objective(candidate) ≈ weighted average of historical daily scores, where
 *     the weight for each row is a Gaussian kernel centred on the min_probability
 *     that was active when that row was recorded (estimated from proposed_adjustments
 *     or falling back to the personality's current params value if no adjustment
 *     was ever proposed). The kernel bandwidth is 0.05 (same as the raise delta),
 *     giving meaningful weight to nearby historical configurations.
 *
 *   This is NOT a simulation re-run — it is a smoothed empirical objective that
 *   rewards candidate values that cluster near historically strong configurations.
 *
 * Min-sample gate (R-J):
 *   Applied AFTER any freshness/regime/poc-consistency filtering. Counts the
 *   POST-FILTER regime-tagged rows. Uses MINIMUM_SAMPLE_STABLE (200) from
 *   evolution-engine.ts. Below threshold → returns { action: 'none' } (no proposal).
 *
 * Guard layer:
 *   Every candidate and final proposal routes through the same guard layer as
 *   the rule-based engine:
 *     - clampMinProbability: bounds to [0.30, 0.90]
 *     - applyIntegrityCap: 8pp spread limit across momentum_exhaustion group
 *     - checkCooldown: 7-day cooldown (checked inside SELECT FOR UPDATE)
 *     - writeProposal / writeApplied: same approval-gate write path
 *     - FROZEN_VIOLATION: throws on is_frozen / Clockwork personalities
 *
 * Exclusions:
 *   sr_anchored personalities (e.g. Levelhead) are excluded from the optimizer
 *   entirely and from the 8pp peer set. sr_strength_threshold is never tuned.
 *   Fixed_time and any_signal entry types are also excluded (not momentum_exhaustion).
 *
 * Design notes:
 *   - The pool parameter is injected (not a module singleton) so unit tests can
 *     substitute a mock pool without vi.mock module-level patching.
 *   - withTransaction is still used for the final write (same as evolution-engine),
 *     but the objective reads are done outside any transaction to minimise lock
 *     duration.
 *   - The golden-section search uses a fixed tolerance of 1e-4 (0.01% of the
 *     0.60-wide search range), converging in at most 30 iterations — negligible
 *     runtime overhead in an EOD batch context.
 *   - The optimizer is designed to be called AFTER runEvolutionEngine (the rule-
 *     based engine runs first). Its output is an additional proposal — it does not
 *     replace the rule engine.
 */

import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/client.js';
import {
  COOLDOWN_DAYS as _COOLDOWN_DAYS,
  INTEGRITY_CAP_MAX_SPREAD as _INTEGRITY_CAP_MAX_SPREAD,
  MIN_PROBABILITY_LOWER,
  MIN_PROBABILITY_UPPER,
  MINIMUM_SAMPLE_STABLE,
  applyIntegrityCap,
  checkCooldown,
  clampMinProbability,
  writeApplied,
  writeProposal,
} from './evolution-engine.js';

// Re-export shared constants so tests can import from a single location.
export { MIN_PROBABILITY_LOWER, MIN_PROBABILITY_UPPER, MINIMUM_SAMPLE_STABLE };

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Number of most-recent trading days to reserve as the holdout set.
 * The optimizer's objective function never reads rows from this period,
 * preventing overfitting the min_probability to recency bias.
 *
 * 20 trading days ≈ one calendar month of daily data. This matches the
 * holdoutDays default in backtest-runner.ts for consistency.
 */
export const OPTIMIZER_HOLDOUT_DAYS = 20;

/**
 * Number of golden-section iterations. Each iteration shrinks the search
 * interval by the golden ratio (~0.618). After 30 iterations the interval
 * is 0.618^30 ≈ 1.1e-7 of the original range (0.60 wide), i.e. ~7e-8.
 * This is well within the 1e-4 precision we need.
 */
export const GOLDEN_SECTION_MAX_ITER = 30;

/**
 * 1 - (1/golden_ratio) ≈ 0.382.
 * Interior probes sit at lo + GOLDEN_SECTION_STEP*(hi-lo) and
 * hi - GOLDEN_SECTION_STEP*(hi-lo) from their respective ends, i.e. at
 * fractions 0.382 and 0.618 of the interval.
 */
const GOLDEN_SECTION_STEP = 1 - 2 / (1 + Math.sqrt(5));

/**
 * Gaussian kernel bandwidth for the smoothed objective.
 * Uses 0.05 (the same magnitude as the rule engine's raise delta) so that
 * historical data within ±5pp of the candidate has meaningful influence.
 */
export const OBJECTIVE_KERNEL_BANDWIDTH = 0.05;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The outcome of one optimizer run.
 *
 * - 'none'     — min-sample gate not met, personality excluded, or no improvement
 *                found over the current value
 * - 'proposed' — a candidate was found and written to retrospection_results
 * - 'applied'  — a candidate was found and applied to personality_configs
 * - 'skipped'  — cooldown or integrity cap suppressed the change
 */
export interface OptimizerResult {
  action: 'none' | 'proposed' | 'applied' | 'skipped';
  candidateValue?: number;
  currentValue?: number;
  reason?: string;
}

/**
 * One retrospection row consumed by the optimizer's objective function.
 * Only the columns needed for computing the objective score.
 */
interface TrainingRow {
  trade_date: string;
  market_regime: string;
  total_trades: number;
  sharpe: number | null;
  beat_clockwork_delta: number | null;
  // The min_probability that was active when this row was recorded.
  // We estimate this from proposed_adjustments if present, otherwise from
  // the personality's current params (the stable value across all rows
  // that predate any evolution).
  active_min_probability: number;
}

/**
 * Personality row fetched for the optimizer's personality lookup.
 */
interface PersonalityRow {
  id: string;
  name: string;
  is_frozen: boolean;
  entry_type: string;
  is_active: boolean;
  params: Record<string, unknown>;
  last_evolved_at: Date | null;
}

// ---------------------------------------------------------------------------
// Internal: fetch and prepare training rows
// ---------------------------------------------------------------------------

/**
 * Fetches the training rows for a single personality from retrospection_results.
 *
 * Applies the holdout cut: excludes the most recent OPTIMIZER_HOLDOUT_DAYS rows
 * (ordered by trade_date DESC) from the result. This is done by using a subquery
 * that selects the trade_date of the Nth-most-recent row and excluding anything
 * newer — equivalent to reserving the last N days as holdout without requiring
 * the caller to know exact date boundaries.
 *
 * Regime filtering: EVENT_DAY rows are excluded because they are outliers
 * (the trading system is blocked on these days, so any data is noise from
 * manual overrides or data-quality issues). UNCLASSIFIED rows are also excluded.
 *
 * poc-consistency filtering: rows where total_trades = 0 are excluded (no
 * trades → no meaningful signal). Rows with both sharpe = null AND
 * beat_clockwork_delta = null are excluded (no objective signal at all).
 *
 * Returns an empty array when the personality has no qualifying rows.
 *
 * IMPORTANT: The holdout is never read — only the WHERE NOT IN (holdout dates)
 * rows are returned. No data from the most recent OPTIMIZER_HOLDOUT_DAYS dates
 * appears in the return value.
 */
async function fetchTrainingRows(
  pool: Pool,
  personalityId: string,
  currentMinProb: number,
): Promise<TrainingRow[]> {
  // Subquery: find the trade_dates of the most recent OPTIMIZER_HOLDOUT_DAYS rows.
  // These form the holdout set and must never be read by the objective function.
  //
  // Note: we use a subquery rather than a date arithmetic approach (e.g. WHERE
  // trade_date < NOW() - INTERVAL '20 days') because the training rows are daily
  // retrospection entries (one per trading day) and not all calendar days are
  // trading days. Selecting by rank (the N most recent rows) is more robust than
  // selecting by calendar date when some days have no entries.
  const result = await pool.query<{
    trade_date: Date;
    market_regime: string;
    total_trades: number;
    sharpe: string | null; // NUMERIC → string via pg OID-1700 parser
    beat_clockwork_delta: string | null; // NUMERIC → string
    proposed_min_prob: string | null; // from proposed_adjustments JSONB
  }>(
    `SELECT
       rr.trade_date,
       rr.market_regime,
       rr.total_trades,
       rr.sharpe,
       rr.beat_clockwork_delta,
       (rr.proposed_adjustments->>'min_probability')::float AS proposed_min_prob
     FROM retrospection_results rr
     WHERE rr.personality_id = $1
       AND rr.market_regime NOT IN ('EVENT_DAY', 'UNCLASSIFIED')
       AND rr.total_trades > 0
       AND (rr.sharpe IS NOT NULL OR rr.beat_clockwork_delta IS NOT NULL)
       AND rr.trade_date NOT IN (
         -- Holdout set: the most recent OPTIMIZER_HOLDOUT_DAYS rows by date.
         -- We reserve these to prevent the optimizer from overfitting to recent
         -- performance. The subquery is over the same personality_id so the
         -- holdout cut is per-personality.
         SELECT trade_date
         FROM retrospection_results
         WHERE personality_id = $1
         ORDER BY trade_date DESC
         LIMIT $2
       )
     ORDER BY rr.trade_date ASC`,
    [personalityId, OPTIMIZER_HOLDOUT_DAYS],
  );

  return result.rows.map((row) => {
    // Estimate the min_probability that was active when this row was recorded.
    // If the evolution engine proposed an adjustment for this date, use that
    // proposed value as a proxy for what the personality was approximately
    // configured to at the time. Otherwise fall back to the current value
    // (which represents the stable baseline across rows that predate evolution).
    //
    // This is an approximation — the proposed value is what the engine suggested,
    // not necessarily what was applied or when. It is "good enough" for the
    // kernel-weighted objective, which only needs a rough centre point.
    const proposedMinProb = row.proposed_min_prob !== null ? Number(row.proposed_min_prob) : null;
    const activeMinProb =
      proposedMinProb !== null && Number.isFinite(proposedMinProb)
        ? proposedMinProb
        : currentMinProb;

    return {
      trade_date: new Date(row.trade_date).toLocaleDateString('en-CA', { timeZone: 'UTC' }),
      market_regime: row.market_regime,
      total_trades: row.total_trades,
      sharpe: row.sharpe !== null ? Number(row.sharpe) : null,
      beat_clockwork_delta:
        row.beat_clockwork_delta !== null ? Number(row.beat_clockwork_delta) : null,
      active_min_probability: activeMinProb,
    };
  });
}

// ---------------------------------------------------------------------------
// Internal: objective function
// ---------------------------------------------------------------------------

/**
 * Computes the objective score for a candidate min_probability value.
 *
 * Uses a Gaussian kernel smoother over historical training rows:
 *   objective(candidate) = Σ_i weight_i * score_i / Σ_i weight_i
 *
 * where:
 *   weight_i = exp(-(candidate - active_min_prob_i)^2 / (2 * bandwidth^2))
 *   score_i  = sharpe_i if non-null, else beat_clockwork_delta_i
 *
 * Rows where the score is not finite are excluded.
 *
 * Returns -Infinity when all weights are negligibly small (candidate is far
 * from all historical configurations — the optimizer will avoid this region).
 *
 * Rationale for the kernel smoother rather than exact simulation:
 *   Re-running the paper-trade pipeline for each candidate value is impractical
 *   in an EOD batch context and is the domain of the backtest runner (T-51).
 *   The kernel smoother provides a computationally cheap approximation that
 *   is directionally correct: it rewards candidates near historically strong
 *   configurations and penalises candidates far from any observed configuration.
 *
 * @param candidate  - The candidate min_probability to evaluate
 * @param rows       - Pre-fetched training rows (from fetchTrainingRows)
 */
function computeObjective(candidate: number, rows: TrainingRow[]): number {
  let weightedScoreSum = 0;
  let weightSum = 0;

  for (const row of rows) {
    // Gaussian kernel weight: higher when candidate is close to the historical
    // active_min_probability for this row.
    const diff = candidate - row.active_min_probability;
    const weight = Math.exp(-(diff * diff) / (2 * OBJECTIVE_KERNEL_BANDWIDTH ** 2));

    // Score: prefer Sharpe (risk-adjusted); fall back to beat_clockwork_delta.
    const score = row.sharpe !== null && Number.isFinite(row.sharpe)
      ? row.sharpe
      : row.beat_clockwork_delta !== null && Number.isFinite(row.beat_clockwork_delta)
        ? row.beat_clockwork_delta
        : null;

    if (score === null) {
      continue; // Skip rows with no usable metric
    }

    weightedScoreSum += weight * score;
    weightSum += weight;
  }

  // When total weight is negligibly small, return -Infinity so the optimizer
  // treats this region as undesirable. The threshold 1e-10 is chosen to be
  // much smaller than any realistic weight sum (which would be >= exp(-0.5)
  // for a row within one bandwidth of the candidate).
  if (weightSum < 1e-10) {
    return -Infinity;
  }

  return weightedScoreSum / weightSum;
}

// ---------------------------------------------------------------------------
// Internal: golden-section search
// ---------------------------------------------------------------------------

/**
 * Golden-section search maximisation over [lo, hi].
 *
 * Returns the x value in [lo, hi] that maximises f(x).
 *
 * Golden-section search is optimal for unimodal functions — it makes no
 * assumption about the derivative and converges with O(1) function evaluations
 * per iteration (unlike gradient methods). For a smooth kernel-weighted
 * objective, unimodality is a reasonable assumption in practice.
 *
 * After GOLDEN_SECTION_MAX_ITER iterations, the search interval is
 * (hi - lo) * (1-GOLDEN_SECTION_STEP)^GOLDEN_SECTION_MAX_ITER wide —
 * approximately 4e-8 for our 0.60-wide range. This is more than sufficient.
 *
 * Convention: two interior probes c < d partition [lo, hi] into three parts.
 *   - If f(c) > f(d): max is in [lo, d]; eliminate (d, hi]; new hi = d.
 *   - If f(c) ≤ f(d): max is in [c, hi]; eliminate [lo, c); new lo = c.
 * At each step, one of {c, d} becomes a boundary point and the other stays
 * as a probe (reusing the previous evaluation), requiring only one new f(x).
 */
function goldenSectionSearch(f: (x: number) => number, lo: number, hi: number): number {
  // Place interior probes at the golden-section fractions from each end.
  // c is closer to lo, d is closer to hi (c < d).
  let c = lo + GOLDEN_SECTION_STEP * (hi - lo);
  let d = hi - GOLDEN_SECTION_STEP * (hi - lo);
  let fc = f(c);
  let fd = f(d);

  for (let i = 0; i < GOLDEN_SECTION_MAX_ITER; i++) {
    if (fc > fd) {
      // f(c) > f(d) → maximum is in [lo, d]. Eliminate (d, hi].
      // Old c becomes the new d (it was the "left" probe, now the "right" probe
      // in the smaller interval [lo, d]).
      hi = d;
      d = c;
      fd = fc;
      c = lo + GOLDEN_SECTION_STEP * (hi - lo);
      fc = f(c);
    } else {
      // f(c) ≤ f(d) → maximum is in [c, hi]. Eliminate [lo, c).
      // Old d becomes the new c (it was the "right" probe, now the "left" probe
      // in the smaller interval [c, hi]).
      lo = c;
      c = d;
      fc = fd;
      d = hi - GOLDEN_SECTION_STEP * (hi - lo);
      fd = f(d);
    }
  }

  // Return the midpoint of the final (very narrow) interval
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// Main export: runOptimizer
// ---------------------------------------------------------------------------

/**
 * Runs the deterministic 1-D optimizer for a single momentum_exhaustion personality.
 *
 * Steps:
 *   1. Fetch personality row — check entry_type, is_active, NOT sr_anchored.
 *   2. Fetch training rows from retrospection_results (holdout excluded).
 *   3. Min-sample gate: if post-filter row count < MINIMUM_SAMPLE_STABLE → return 'none'.
 *   4. Golden-section search over [0.30, 0.90] on the kernel-smoothed objective.
 *   5. If the best candidate is essentially the same as the current value (< 1e-4
 *      difference) → return 'none' (no meaningful improvement found).
 *   6. Enter a transaction, lock the comparison group, apply the guard layer:
 *        - FROZEN_VIOLATION check
 *        - clamp + integrity cap
 *        - cooldown check
 *   7. Write via approval or autonomous path.
 *
 * Failures in steps 1–5 (read-only) are propagated to the caller.
 * The caller (eod-retrospection-job.ts) wraps this in a try/catch and falls
 * back to runEvolutionEngine on any error.
 *
 * @param pool          - pg Pool (injected for testability)
 * @param personalityId - UUID of the target personality_configs row
 * @param tradeDateISO  - Trade date in 'YYYY-MM-DD' format (IST calendar date)
 */
export async function runOptimizer(
  pool: Pool,
  personalityId: string,
  tradeDateISO: string,
): Promise<OptimizerResult> {
  // -------------------------------------------------------------------------
  // Step 1: fetch personality row to validate preconditions
  // -------------------------------------------------------------------------
  const personalityResult = await pool.query<PersonalityRow>(
    `SELECT id, name, is_frozen, entry_type, is_active, params, last_evolved_at
     FROM personality_configs
     WHERE id = $1`,
    [personalityId],
  );

  const personality = personalityResult.rows[0];

  if (personality === undefined) {
    throw new Error(`[optimizer] personality ${personalityId} not found`);
  }

  // FROZEN_VIOLATION: throw immediately (before any read-heavy work) if the
  // personality is frozen. Throwing (not silently returning) makes the mistake
  // visible, consistent with the rule engine's invariant.
  if (personality.is_frozen) {
    throw new Error(
      `FROZEN_VIOLATION: cannot optimize frozen personality ${personality.name}`,
    );
  }

  // Exclude personalities whose entry_type is not 'momentum_exhaustion'.
  // sr_anchored (Levelhead) personalities are explicitly excluded here.
  // We also exclude fixed_time and any_signal types.
  if (personality.entry_type !== 'momentum_exhaustion') {
    return {
      action: 'none',
      reason: `entry_type_excluded:${personality.entry_type}`,
    };
  }

  // Inactive personalities should not be optimized (they have no recent trades).
  if (!personality.is_active) {
    return { action: 'none', reason: 'personality_inactive' };
  }

  const currentMinProb = Number((personality.params as Record<string, unknown>).min_probability);

  if (!Number.isFinite(currentMinProb)) {
    return { action: 'none', reason: 'min_probability_not_finite' };
  }

  // -------------------------------------------------------------------------
  // Step 2: fetch training rows (holdout excluded, regime/poc filtered)
  // -------------------------------------------------------------------------
  const trainingRows = await fetchTrainingRows(pool, personalityId, currentMinProb);

  // -------------------------------------------------------------------------
  // Step 3: min-sample gate — applied POST-FILTER
  //
  // trainingRows already excludes EVENT_DAY, UNCLASSIFIED, zero-trade rows,
  // and rows with no usable metric. The count is the post-filter sample size.
  // Below MINIMUM_SAMPLE_STABLE (200) → no suggestion.
  // -------------------------------------------------------------------------
  if (trainingRows.length < MINIMUM_SAMPLE_STABLE) {
    return {
      action: 'none',
      reason: `insufficient_sample:${trainingRows.length}<${MINIMUM_SAMPLE_STABLE}`,
    };
  }

  // -------------------------------------------------------------------------
  // Step 4: golden-section search over [MIN_PROBABILITY_LOWER, MIN_PROBABILITY_UPPER]
  // -------------------------------------------------------------------------
  const objectiveFn = (candidate: number): number => computeObjective(candidate, trainingRows);

  const rawCandidate = goldenSectionSearch(objectiveFn, MIN_PROBABILITY_LOWER, MIN_PROBABILITY_UPPER);

  // Clamp the raw candidate to the allowed bounds (defensive: golden-section
  // should stay within [lo, hi] but floating-point can drift slightly).
  const clampedCandidate = clampMinProbability(rawCandidate);

  // -------------------------------------------------------------------------
  // Step 5: check whether the candidate meaningfully differs from current value
  //
  // If the optimizer found that the current value is essentially optimal
  // (within 1e-4), there is nothing to propose. 1e-4 is one hundredth of a
  // percentage point — indistinguishable from noise in practice.
  // -------------------------------------------------------------------------
  if (Math.abs(clampedCandidate - currentMinProb) < 1e-4) {
    return {
      action: 'none',
      reason: 'no_improvement',
      currentValue: currentMinProb,
    };
  }

  // -------------------------------------------------------------------------
  // Step 6: enter transaction, lock comparison group, apply guard layer
  //
  // We do the expensive read work (steps 2–5) OUTSIDE the transaction to avoid
  // holding locks while doing DB reads and computation. The transaction only
  // covers the guard checks that require consistent DB state (integrity cap
  // and cooldown) and the write.
  // -------------------------------------------------------------------------
  const requireApproval = process.env.EVOLUTION_REQUIRE_APPROVAL !== 'false';

  return withTransaction(async (client) => {
    // Lock the full momentum_exhaustion comparison group (same as rule engine).
    // This prevents concurrent EOD jobs from racing on the spread calculation.
    // We lock ONLY the momentum_exhaustion, is_active rows — not sr_anchored.
    const lockResult = await client.query<PersonalityRow>(
      `SELECT id, name, is_frozen, entry_type, is_active, params, last_evolved_at
       FROM personality_configs
       WHERE entry_type = 'momentum_exhaustion'
         AND is_active = TRUE
       FOR UPDATE`,
    );

    const allRows = lockResult.rows;
    const targetRow = allRows.find((r) => r.id === personalityId);

    if (targetRow === undefined) {
      // Personality became inactive or was deleted between step 1 and now.
      // Return 'none' rather than throwing — this is a benign race condition.
      return { action: 'none', reason: 'personality_not_found_in_lock' };
    }

    // Re-check frozen status inside the transaction. The is_frozen flag could
    // theoretically be set between step 1 and the SELECT FOR UPDATE.
    if (targetRow.is_frozen) {
      throw new Error(
        `FROZEN_VIOLATION: cannot optimize frozen personality ${targetRow.name}`,
      );
    }

    // Re-read current min_probability from the locked row (it may have changed
    // between our initial read and the SELECT FOR UPDATE).
    const lockedMinProb = Number(
      (targetRow.params as Record<string, unknown>).min_probability,
    );
    if (!Number.isFinite(lockedMinProb)) {
      return { action: 'skipped', reason: 'min_probability_not_finite' };
    }

    // -----------------------------------------------------------------------
    // Integrity cap: compute peer probabilities from the locked comparison group.
    // sr_anchored personalities are NOT in this locked set (the WHERE clause
    // filters to momentum_exhaustion only), so they are naturally excluded from
    // the peer set. This satisfies R-B: sr_strength_threshold is never touched.
    // -----------------------------------------------------------------------
    const otherProbs: number[] = allRows
      .filter((r) => r.id !== personalityId)
      .map((r) => Number((r.params as Record<string, unknown>).min_probability))
      .filter((v) => Number.isFinite(v));

    // Compute the direction (delta) for the cap — which way is the candidate moving?
    const delta = clampedCandidate - lockedMinProb;

    const proposedValue = applyIntegrityCap(clampedCandidate, lockedMinProb, otherProbs, delta);

    if (proposedValue === null) {
      return { action: 'none', reason: 'integrity_cap_no_change' };
    }

    // If integrity cap reduced the proposal to essentially the current value,
    // there is nothing to write.
    if (Math.abs(proposedValue - lockedMinProb) < 1e-4) {
      return { action: 'none', reason: 'integrity_cap_no_improvement' };
    }

    // -----------------------------------------------------------------------
    // Cooldown check (inside transaction, after SELECT FOR UPDATE — same
    // reasoning as the rule engine: prevents concurrent jobs from both
    // passing the cooldown check).
    // -----------------------------------------------------------------------
    if (checkCooldown(targetRow.last_evolved_at, tradeDateISO)) {
      return { action: 'skipped', reason: 'cooldown' };
    }

    // -----------------------------------------------------------------------
    // Write path — same as the rule engine
    // -----------------------------------------------------------------------
    const ruleName = 'optimizer_golden_section';

    if (requireApproval) {
      await writeProposal(
        client,
        personalityId,
        tradeDateISO,
        proposedValue,
        ruleName,
        lockedMinProb,
      );
      return { action: 'proposed', candidateValue: proposedValue, currentValue: lockedMinProb };
    }

    const metricsDesc = `candidate=${proposedValue.toFixed(4)},trainRows=${trainingRows.length}`;
    await writeApplied(
      client,
      personalityId,
      proposedValue,
      targetRow.params as Record<string, unknown>,
      ruleName,
      metricsDesc,
      lockedMinProb,
    );

    return { action: 'applied', candidateValue: proposedValue, currentValue: lockedMinProb };
  });
}

// ---------------------------------------------------------------------------
// Exported helpers for testing
// ---------------------------------------------------------------------------

/**
 * Exported for unit testing only — evaluates the objective function on a set
 * of pre-fabricated training rows. Not part of the public API.
 */
export { computeObjective, goldenSectionSearch, fetchTrainingRows };
