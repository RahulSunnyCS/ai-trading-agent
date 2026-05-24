/**
 * optimizer.ts — Guarded deterministic 1-D optimizer for min_probability (T-46)
 *
 * Implements Decision-1 Option B: a GUARDED DETERMINISTIC 1-D HYBRID optimizer.
 * No Gaussian Process, no matrix math. GP is explicitly deferred to Phase 2.
 *
 * Algorithm (HYBRID — reworked from pure-kernel):
 *   Phase A — Shortlist (cheap, kernel-based):
 *     Golden-section search over min_probability ∈ [MIN_PROBABILITY_LOWER,
 *     MIN_PROBABILITY_UPPER] on the Gaussian kernel smoother to identify 2–3
 *     candidate values. The kernel is a fast approximation — it rewards
 *     candidates near historically strong configurations from retrospection_results.
 *
 *   Phase B — Finalist scoring (real backtest):
 *     The shortlisted candidates are scored using ONE real backtest run via
 *     createBacktestRunner(pool). The runner produces SimulatedTrade[] tagged
 *     with split ('train'|'test'|'holdout'). We take ONLY split==='train' AND
 *     signalType==='MOMENTUM_EXHAUSTION' trades and post-hoc filter them by
 *     adjustedProbability >= C for each candidate C. The winning finalist is the
 *     one with the highest Sharpe over its eligible train trades.
 *
 *   Efficiency insight:
 *     The backtest runs ONCE. Each candidate is scored by filtering the same
 *     in-memory trade array — no repeated DB calls. The holdout split trades
 *     are always filtered OUT (never scored), preventing leakage from the
 *     future. The backtest uses holdoutDays=OPTIMIZER_HOLDOUT_DAYS so its
 *     train/holdout boundary matches the retrospection holdout cut.
 *
 *   Important backtest runner observation:
 *     The current backtest runner assigns a fixed adjustedProbability = 0.7 to
 *     every MOMENTUM_EXHAUSTION signal (hardcoded in backtest-runner.ts). This
 *     means that post-hoc filtering on adjustedProbability >= C is effectively
 *     binary: candidates C <= 0.70 admit ALL momentum train trades (same Sharpe
 *     for each such candidate); candidates C > 0.70 admit ZERO trades (ineligible).
 *
 *     As a result, within the [0.30, 0.70] shortlist region all candidates share
 *     the same train Sharpe; ties are broken by the kernel value from Phase A.
 *     Any shortlisted candidate above 0.70 is immediately ineligible (no trades
 *     → below the minimum sample floor). If no candidate is eligible, the
 *     optimizer returns { action: 'none' } — consistent with the min-sample
 *     philosophy. When the backtest runner is upgraded to emit per-signal
 *     calibrated probabilities, this post-hoc filter will automatically start
 *     discriminating between candidates without any change to this file.
 *
 * Min-sample gate (R-J):
 *   Applied in two stages:
 *   - Stage 1 (retrospection rows): POST-FILTER regime-tagged retrospection_results
 *     rows must reach MINIMUM_SAMPLE_STABLE (200). Below threshold → 'none'.
 *   - Stage 2 (backtest trades): each finalist candidate C must have at least
 *     SHORTLIST_MIN_TRADES train momentum trades eligible under C. Below this
 *     floor → candidate ineligible; if all are ineligible → 'none'.
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
 * Failure handling:
 *   If the backtest call fails (DB timeout, config error, etc.), the optimizer
 *   catches the error and returns { action: 'none', reason: 'backtest_failed' }.
 *   The EOD job already handles optimizer failures via its own try/catch.
 *
 * Design notes:
 *   - The pool parameter is injected (not a module singleton) so unit tests can
 *     substitute a mock pool without vi.mock module-level patching.
 *   - createBacktestRunner is imported and also injectable for testing via the
 *     exported BACKTEST_RUNNER_FACTORY symbol (overridable in tests).
 *   - withTransaction is still used for the final write (same as evolution-engine),
 *     but the objective reads are done outside any transaction to minimise lock
 *     duration.
 *   - The golden-section search uses a fixed tolerance of 1e-4 (0.01% of the
 *     0.60-wide search range), converging in at most 30 iterations — negligible
 *     runtime overhead in an EOD batch context.
 *   - The optimizer is designed to be called AFTER runEvolutionEngine (the rule-
 *     based engine runs first). Its output is an additional proposal — it does not
 *     replace the rule engine.
 *   - Backtest config: underlying defaults to 'NSE:NIFTY50-INDEX'. The EOD job
 *     passes no override today. When multi-underlying support arrives, pass the
 *     personality's configured underlying instead.
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
import { createBacktestRunner } from '../backtesting/backtest-runner.js';
import type { BacktestConfig, SimulatedTrade } from '../backtesting/backtest-runner.js';

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

/**
 * Number of shortlisted candidates from the kernel phase passed to backtest scoring.
 *
 * 3 candidates: the kernel peak (best) + two flanking probes at ±SHORTLIST_SPREAD.
 * This is enough to detect whether the backtest favours a slightly higher or lower
 * threshold than the pure kernel peak.
 *
 * Rationale for 3 (not 2): the kernel peak is already the best kernel estimate;
 * the two flanks let us verify it is a true local maximum and not an artefact
 * of sparse historical data on one side.
 */
export const SHORTLIST_COUNT = 3;

/**
 * Spread (in probability units) between the kernel-peak shortlist candidate
 * and its two flanking candidates.
 *
 * 0.05 = one bandwidth unit. This means the flanks are one kernel bandwidth
 * away from the peak — close enough to remain in the "strong" kernel region,
 * far enough to be meaningfully distinct candidates.
 */
export const SHORTLIST_SPREAD = 0.05;

/**
 * Minimum number of eligible train-split MOMENTUM_EXHAUSTION trades required
 * for a shortlisted candidate to be scored.
 *
 * Below this floor we cannot compute a meaningful Sharpe (too few data points
 * for the ratio to be reliable). Consistent with the min-sample philosophy
 * applied to retrospection rows: reject under-sampled estimates.
 *
 * 5 trades is a deliberately conservative floor. A Sharpe over fewer than 5
 * trades carries enormous estimation error. More than 5 would be preferable
 * but we defer to the minimum given how thin intraday signals can be.
 */
export const SHORTLIST_MIN_TRADES = 5;

/**
 * The underlying symbol passed to the backtest runner.
 *
 * Hardcoded to the primary NIFTY index for now. When multi-underlying
 * support is added, this should come from the personality's configured
 * underlying field.
 */
export const BACKTEST_UNDERLYING = 'NSE:NIFTY50-INDEX';

/**
 * Backtest date window length in calendar days.
 *
 * The backtest runner's holdout/train split uses this window. We look back
 * 12 months (approximately) from tradeDateISO. Longer windows give more train
 * data but increase DB IO; 365 days is calibrated to the EOD <5 min budget.
 */
export const BACKTEST_LOOKBACK_DAYS = 365;

// ---------------------------------------------------------------------------
// Injectable backtest runner factory (overridable in tests)
//
// We export this as a module-level object so unit tests can replace
// backtestRunnerFactory.create without mocking the entire import. This avoids
// the need for vi.mock at module level (which has hoisting quirks) while still
// keeping the real createBacktestRunner as the production default.
// ---------------------------------------------------------------------------

/**
 * Injectable factory for the backtest runner. Tests replace `.create` with a
 * function that returns a mock runner (stubbed `run()`) before calling
 * runOptimizer, then restore it afterwards.
 *
 * Using a mutable object (not a direct function reference) because ES module
 * named exports cannot be reassigned from the outside. The object indirection
 * gives tests a stable handle to swap the factory without module-level mocking.
 */
export const backtestRunnerFactory = {
  create: createBacktestRunner,
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The outcome of one optimizer run.
 *
 * - 'none'     — min-sample gate not met, personality excluded, no improvement
 *                found, backtest failed, or no eligible finalist
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
 * One retrospection row consumed by the optimizer's kernel phase.
 * Only the columns needed for computing the kernel objective score.
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

/**
 * A shortlisted candidate with its kernel score (for tie-breaking in backtest phase).
 */
interface ShortlistEntry {
  candidate: number;
  kernelScore: number;
}

/**
 * Result of scoring a single shortlisted candidate against backtest trades.
 */
interface ScoredFinalist {
  candidate: number;
  kernelScore: number;
  trainSharpe: number;
  eligibleTradeCount: number;
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
    // kernel-weighted objective, which only needs a rough centre point for
    // the shortlist phase.
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
// Internal: kernel objective function (Phase A — shortlist)
// ---------------------------------------------------------------------------

/**
 * Computes the kernel objective score for a candidate min_probability value.
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
 * Role in the hybrid algorithm: this function is used ONLY in Phase A (shortlist
 * generation) and as a tie-breaker in Phase B (backtest scoring). It is no
 * longer the sole final scorer — that role belongs to train Sharpe from the
 * real backtest.
 *
 * @param candidate  - The candidate min_probability to evaluate
 * @param rows       - Pre-fetched training rows (from fetchTrainingRows)
 */
export function computeObjective(candidate: number, rows: TrainingRow[]): number {
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
// Internal: golden-section search (Phase A — kernel peak finder)
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
export function goldenSectionSearch(f: (x: number) => number, lo: number, hi: number): number {
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
// Internal: shortlist generation (Phase A output)
// ---------------------------------------------------------------------------

/**
 * Generates SHORTLIST_COUNT candidate min_probability values from the kernel peak.
 *
 * The shortlist consists of:
 *   1. The kernel peak (best kernel score from golden-section search)
 *   2. Peak − SHORTLIST_SPREAD (left flank)
 *   3. Peak + SHORTLIST_SPREAD (right flank)
 *
 * All candidates are clamped to [MIN_PROBABILITY_LOWER, MIN_PROBABILITY_UPPER].
 * Duplicates (e.g. both flanks clamped to the same bound) are deduplicated —
 * scoring a candidate twice wastes computation and distorts tie-breaking.
 *
 * Returns an array of ShortlistEntry (candidate + kernel score) sorted by
 * kernel score descending (best kernel candidate first).
 */
export function buildShortlist(kernelPeak: number, rows: TrainingRow[]): ShortlistEntry[] {
  // Generate the three raw candidate values
  const rawCandidates = [
    kernelPeak,
    kernelPeak - SHORTLIST_SPREAD,
    kernelPeak + SHORTLIST_SPREAD,
  ];

  // Clamp to valid range
  const clamped = rawCandidates.map(clampMinProbability);

  // Deduplicate: round to 6 decimal places to catch float near-duplicates
  const seen = new Set<string>();
  const unique: number[] = [];
  for (const c of clamped) {
    const key = c.toFixed(6);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(c);
    }
  }

  // Score each unique candidate with the kernel (for tie-breaking in Phase B)
  const entries: ShortlistEntry[] = unique.map((c) => ({
    candidate: c,
    kernelScore: computeObjective(c, rows),
  }));

  // Sort by kernel score descending so the best kernel candidate is first.
  // Tie-breaking order matters in scoreFinalists (first eligible wins on equal train Sharpe).
  entries.sort((a, b) => b.kernelScore - a.kernelScore);

  return entries;
}

// ---------------------------------------------------------------------------
// Internal: backtest-based finalist scoring (Phase B)
// ---------------------------------------------------------------------------

/**
 * Scores shortlisted candidates using a single real backtest run.
 *
 * Algorithm:
 *   1. Run one backtest over the train window (holdout excluded by BacktestConfig).
 *   2. Filter trades to split==='train' AND signalType==='MOMENTUM_EXHAUSTION'.
 *      Holdout and test trades are NEVER read.
 *   3. For each candidate C, filter the train momentum trades to
 *      adjustedProbability >= C.
 *   4. If the filtered count < SHORTLIST_MIN_TRADES → candidate ineligible.
 *   5. Otherwise compute Sharpe of pnlPct over the eligible trades.
 *   6. Pick the finalist with the highest train Sharpe.
 *      Ties broken by kernel score (highest kernel score wins — this preserves
 *      the Phase-A ordering when the backtest cannot discriminate).
 *
 * Sharpe computation:
 *   Sharpe = mean(pnlPct) / stddev(pnlPct). When stddev = 0 (all trades have
 *   identical pnlPct, e.g. all hit the same target) we return 0.0 rather than
 *   Infinity. A zero-volatility strategy with positive mean is still desirable
 *   but we cannot rank it against other candidates fairly via Sharpe alone —
 *   we fall back to whichever is first (highest kernel score) among ties.
 *
 * @param shortlist  - Candidate entries from buildShortlist (kernel-scored)
 * @param trades     - ALL trades from the backtest result (filtered internally)
 * @returns          - Array of ScoredFinalist (may be empty if none are eligible)
 */
export function scoreFinalists(
  shortlist: ShortlistEntry[],
  trades: SimulatedTrade[],
): ScoredFinalist[] {
  // Pre-filter once: keep only train-split MOMENTUM_EXHAUSTION trades.
  // This ensures holdout trades are NEVER read during scoring, regardless of
  // what the caller passes. The double-filter here (split AND signalType) is
  // intentional and defensive.
  const trainMomentumTrades = trades.filter(
    (t) => t.split === 'train' && t.signalType === 'MOMENTUM_EXHAUSTION',
  );

  const scored: ScoredFinalist[] = [];

  for (const entry of shortlist) {
    // Post-hoc filter: trades the personality would have taken at threshold C.
    // With the current backtest runner (fixed adjustedProbability = 0.7 for all
    // MOMENTUM_EXHAUSTION signals), this filter is effectively binary:
    //   C <= 0.70 → all trainMomentumTrades pass (full set Sharpe)
    //   C > 0.70  → zero trades pass → ineligible
    // When the runner is upgraded to emit calibrated per-signal probabilities,
    // this filter will automatically start discriminating without code changes.
    const eligibleTrades = trainMomentumTrades.filter(
      (t) => t.adjustedProbability >= entry.candidate,
    );

    if (eligibleTrades.length < SHORTLIST_MIN_TRADES) {
      // Too few trades to compute a meaningful Sharpe — skip this candidate.
      continue;
    }

    const sharpe = computeTrainSharpe(eligibleTrades);

    scored.push({
      candidate: entry.candidate,
      kernelScore: entry.kernelScore,
      trainSharpe: sharpe,
      eligibleTradeCount: eligibleTrades.length,
    });
  }

  return scored;
}

/**
 * Computes the Sharpe ratio of pnlPct over a non-empty trade array.
 *
 * Sharpe = mean(pnlPct) / stddev(pnlPct, population).
 *
 * We use population stddev (not sample stddev) because we are treating the
 * backtest trades as the full population of outcomes for this configuration,
 * not a sample from a larger distribution. The distinction is minor for
 * n >= 5 but philosophically cleaner for a post-hoc scoring context.
 *
 * Returns 0.0 when stddev is 0 (zero-variance strategy). We do NOT return
 * +Infinity because the point of Sharpe in this context is to rank candidates
 * relative to each other — a Sharpe of +∞ would dominate every comparison
 * regardless of mean, which is not the intended behavior.
 */
function computeTrainSharpe(trades: SimulatedTrade[]): number {
  const n = trades.length;

  // Mean
  let sum = 0;
  for (const t of trades) {
    sum += t.pnlPct;
  }
  const mean = sum / n;

  // Population variance
  let varSum = 0;
  for (const t of trades) {
    const diff = t.pnlPct - mean;
    varSum += diff * diff;
  }
  const stddev = Math.sqrt(varSum / n);

  if (stddev < 1e-12) {
    // Zero variance — return 0 to avoid Infinity ranking distortions.
    return 0.0;
  }

  return mean / stddev;
}

/**
 * Selects the best finalist from the scored array.
 *
 * Primary sort: highest trainSharpe.
 * Tie-breaker: highest kernelScore (preserves the Phase-A ordering).
 *
 * Returns null when the scored array is empty (no eligible finalist).
 */
export function pickBestFinalist(scored: ScoredFinalist[]): ScoredFinalist | null {
  if (scored.length === 0) return null;

  let best = scored[0]!;
  for (let i = 1; i < scored.length; i++) {
    const entry = scored[i]!;
    if (
      entry.trainSharpe > best.trainSharpe ||
      (entry.trainSharpe === best.trainSharpe && entry.kernelScore > best.kernelScore)
    ) {
      best = entry;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Internal: build backtest config for the optimizer
// ---------------------------------------------------------------------------

/**
 * Builds the BacktestConfig for the optimizer's single backtest run.
 *
 * Window: [tradeDateISO - BACKTEST_LOOKBACK_DAYS, tradeDateISO].
 * holdoutDays = OPTIMIZER_HOLDOUT_DAYS (mirrors the retrospection holdout cut).
 * trainFraction = 0.7 (70% of non-holdout days are train; 30% are test).
 *
 * We use the test split for nothing — it exists because BacktestConfig requires
 * trainFraction to be in (0, 1) and the runner always computes a test split.
 * We only score train trades; test trades are filtered out in scoreFinalists.
 */
function buildBacktestConfig(tradeDateISO: string): BacktestConfig {
  // Compute fromDate = tradeDateISO minus BACKTEST_LOOKBACK_DAYS calendar days.
  // We parse at noon UTC to avoid DST edge cases.
  const toMs = new Date(`${tradeDateISO}T12:00:00Z`).getTime();
  const fromMs = toMs - BACKTEST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  const fromDate = new Date(fromMs)
    .toLocaleDateString('en-CA', { timeZone: 'UTC' });

  return {
    underlying: BACKTEST_UNDERLYING,
    fromDate,
    toDate: tradeDateISO,
    holdoutDays: OPTIMIZER_HOLDOUT_DAYS,
    trainFraction: 0.7,
    // Signal detection and trigger config are left as defaults (production values).
    // We do not override them here — the optimizer scores the same signal-detection
    // configuration that is in production, not a tuned variant.
  };
}

// ---------------------------------------------------------------------------
// Main export: runOptimizer
// ---------------------------------------------------------------------------

/**
 * Runs the hybrid 1-D optimizer for a single momentum_exhaustion personality.
 *
 * Phase A (Shortlist — kernel-based, cheap):
 *   1. Fetch personality row — check entry_type, is_active, NOT sr_anchored.
 *   2. Fetch training rows from retrospection_results (holdout excluded).
 *   3. Min-sample gate: if post-filter row count < MINIMUM_SAMPLE_STABLE → 'none'.
 *   4. Golden-section search on the kernel objective → kernel peak.
 *   5. Build shortlist of SHORTLIST_COUNT candidates centred on the kernel peak.
 *
 * Phase B (Finalist scoring — real backtest, one run):
 *   6. Run ONE backtest over the train window (holdoutDays = OPTIMIZER_HOLDOUT_DAYS).
 *      Wrapped in try/catch: backtest failure → 'none' (EOD job continues).
 *   7. Score each shortlisted candidate by Sharpe of its eligible train trades.
 *      Holdout trades are NEVER read (filtered in scoreFinalists).
 *   8. Pick the finalist with the best train Sharpe (kernel as tie-breaker).
 *   9. If no finalist is eligible (all below SHORTLIST_MIN_TRADES) → 'none'.
 *
 * Guard layer (same as rule engine):
 *  10. If finalist is essentially the same as current value (< 1e-4) → 'none'.
 *  11. Enter transaction, lock comparison group:
 *        - FROZEN_VIOLATION re-check
 *        - clamp + integrity cap
 *        - cooldown check
 *  12. Write via approval or autonomous path.
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
  // =========================================================================
  // PHASE A — SHORTLIST (kernel-based, cheap)
  // =========================================================================

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
  // Step 3: min-sample gate (Stage 1) — applied POST-FILTER
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
  // Step 4: golden-section search on the kernel objective → kernel peak
  // -------------------------------------------------------------------------
  const objectiveFn = (candidate: number): number => computeObjective(candidate, trainingRows);

  const rawKernelPeak = goldenSectionSearch(objectiveFn, MIN_PROBABILITY_LOWER, MIN_PROBABILITY_UPPER);

  // Clamp the raw peak to the allowed bounds (defensive: golden-section
  // should stay within [lo, hi] but floating-point can drift slightly).
  const kernelPeak = clampMinProbability(rawKernelPeak);

  // -------------------------------------------------------------------------
  // Step 5: build shortlist of candidates centred on the kernel peak
  // -------------------------------------------------------------------------
  const shortlist = buildShortlist(kernelPeak, trainingRows);

  // =========================================================================
  // PHASE B — FINALIST SCORING (real backtest, one run)
  // =========================================================================

  // -------------------------------------------------------------------------
  // Step 6: run ONE backtest over the train window
  //
  // Wrapped in try/catch: any backtest failure (DB timeout, config error,
  // empty underlying data) is caught and the optimizer falls back to 'none'.
  // The EOD job's outer try/catch also catches optimizer failures, but we
  // want to return a structured 'none' rather than throwing.
  // -------------------------------------------------------------------------
  let backtestTrades: SimulatedTrade[];
  try {
    const runner = backtestRunnerFactory.create(pool);
    const backtestConfig = buildBacktestConfig(tradeDateISO);
    const backtestResult = await runner.run(backtestConfig);
    backtestTrades = backtestResult.trades;
  } catch (backtestErr) {
    // Log at warn level (not error) — backtest failure is a known-possible
    // transient state (e.g. no snapshot data for the lookback window on a
    // freshly set-up instance). The rule engine has already run (step 5f of
    // the EOD job) so no signal is lost.
    console.warn(
      '[optimizer] backtest failed for personality %s on %s — returning no suggestion:',
      personalityId,
      tradeDateISO,
      backtestErr,
    );
    return { action: 'none', reason: 'backtest_failed' };
  }

  // -------------------------------------------------------------------------
  // Step 7: score each shortlisted candidate against train trades
  //
  // scoreFinalists internally filters to split==='train' AND
  // signalType==='MOMENTUM_EXHAUSTION'. Holdout trades are never read.
  // -------------------------------------------------------------------------
  const scored = scoreFinalists(shortlist, backtestTrades);

  // -------------------------------------------------------------------------
  // Step 8: pick the finalist with the best train Sharpe
  // -------------------------------------------------------------------------
  const bestFinalist = pickBestFinalist(scored);

  // -------------------------------------------------------------------------
  // Step 9: min-sample gate (Stage 2) — no eligible finalist
  //
  // If no candidate had enough eligible train trades, return 'none'.
  // This is consistent with the Phase-A min-sample philosophy: we only act
  // when we have enough evidence.
  // -------------------------------------------------------------------------
  if (bestFinalist === null) {
    return {
      action: 'none',
      reason: 'no_eligible_finalist',
    };
  }

  const clampedCandidate = clampMinProbability(bestFinalist.candidate);

  // =========================================================================
  // GUARD LAYER + WRITE (same as original optimizer)
  // =========================================================================

  // -------------------------------------------------------------------------
  // Step 10: check whether the candidate meaningfully differs from current value
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
  // Step 11: enter transaction, lock comparison group, apply guard layer
  //
  // We do the expensive work (steps 2–9) OUTSIDE the transaction to avoid
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
    const ruleName = 'optimizer_hybrid';

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

    const metricsDesc = [
      `candidate=${proposedValue.toFixed(4)}`,
      `trainSharpe=${bestFinalist.trainSharpe.toFixed(4)}`,
      `eligibleTrades=${bestFinalist.eligibleTradeCount}`,
      `trainRows=${trainingRows.length}`,
    ].join(',');

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
 * Exported for unit testing only — evaluates the kernel objective function on
 * a set of pre-fabricated training rows. Not part of the public API.
 */
export { fetchTrainingRows };
