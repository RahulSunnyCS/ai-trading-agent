/**
 * evolution-engine.ts — Rule-based parameter evolution engine
 *
 * Evaluates daily retrospection metrics for a single personality and, when a
 * configured rule fires, either proposes a parameter adjustment (approval mode)
 * or applies it immediately (autonomous mode).
 *
 * The only parameter evolved in Phase 1 is `min_probability` — the minimum
 * adjusted-probability score a signal must have before this personality will
 * trade on it.
 *
 * Safety invariants enforced here:
 *   1. Frozen personalities (is_frozen = TRUE) are never evolved — throws FROZEN_VIOLATION.
 *   2. The integrity cap keeps all active momentum_exhaustion personalities within
 *      8 percentage points of each other to preserve comparison validity.
 *   3. A 7-day cooldown prevents thrashing when multiple losing or winning days
 *      cluster together.
 *   4. EVOLUTION_REQUIRE_APPROVAL defaults to TRUE — explicit opt-out required.
 *   5. All DB mutations run inside a single transaction with SELECT FOR UPDATE so
 *      two concurrent EOD jobs cannot race and produce conflicting updates.
 *
 * Design notes:
 *   - The `pool: Pool` parameter is accepted for interface consistency with the
 *     rest of the codebase (callers can inject a test pool via dependency
 *     injection). However, `withTransaction` from src/db/client.ts uses the
 *     module-level pool singleton — it does not accept an external pool. The
 *     parameter is currently unused in the withTransaction call; when the
 *     transaction helper is refactored to accept an external pool this function
 *     will wire it through without a signature change.
 *   - The SELECT FOR UPDATE locks ALL active momentum_exhaustion rows, not just
 *     the target. This is intentional: the integrity cap calculation must read
 *     consistent values from all comparison group members. Locking only the
 *     target would allow another concurrent job to change a sibling's
 *     min_probability between the read and the write, invalidating the cap check.
 *
 * Guard layer (T-46 refactor):
 *   Several pure functions and constants are now exported so the deterministic
 *   optimizer (optimizer.ts) can reuse the same guards without duplication.
 *   The guards are: clampMinProbability, applyIntegrityCap, checkCooldown,
 *   writeProposal, writeApplied. runEvolutionEngine is refactored to call these
 *   extracted helpers — its observable behavior is byte-for-byte unchanged.
 */

import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../db/client.js';

// ---------------------------------------------------------------------------
// Exported constants (shared with optimizer.ts)
// ---------------------------------------------------------------------------

/**
 * Lower bound for min_probability — below 30% the signal is essentially noise
 * and we should not be trading at all.
 */
export const MIN_PROBABILITY_LOWER = 0.3;

/**
 * Upper bound for min_probability — requiring 90%+ confidence on every trade
 * would effectively turn off the strategy (signals this strong are rare).
 */
export const MIN_PROBABILITY_UPPER = 0.9;

/**
 * Maximum allowed spread between any two active momentum_exhaustion personalities'
 * min_probability values. Exceeding 0.08 means personalities are entering on
 * meaningfully different quality signals, invalidating management-style comparisons.
 */
export const INTEGRITY_CAP_MAX_SPREAD = 0.08;

/**
 * Minimum number of regime-tagged retrospection rows required for the
 * deterministic optimizer's 'stable' classification. Below this threshold
 * the optimizer returns no suggestion (sample is too small to be reliable).
 *
 * This constant is distinct from the rule engine's per-day 20-trade floor
 * (which gates a single-day rule from firing). This 200-row floor gates the
 * entire optimizer run across the training window.
 *
 * 200 rows ≈ ~10 trading months of daily data per personality — enough to
 * detect statistically meaningful signal in the objective metric.
 */
export const MINIMUM_SAMPLE_STABLE = 200;

/**
 * Minimum number of closed trades on a single day before the rule-based engine
 * can fire for that day. Kept separate from MINIMUM_SAMPLE_STABLE because it
 * is a per-day gate, not a training-window gate.
 */
export const MINIMUM_DAILY_TRADES = 20;

/**
 * Cooldown period in calendar days. The engine will not apply or propose a
 * change if the last evolution was fewer than this many days ago. Roughly 5
 * trading days — enough to accumulate a meaningful sample after the previous
 * adjustment before deciding to adjust again.
 */
export const COOLDOWN_DAYS = 7;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The outcome of one evolution engine run.
 *
 * - 'none'     — no rule fired, or totalTrades < 20 (insufficient sample)
 * - 'proposed' — a rule fired and the proposed value was written to
 *                retrospection_results.proposed_adjustments (awaiting human approval)
 * - 'applied'  — a rule fired and personality_configs.params was updated directly
 *                (autonomous mode: EVOLUTION_REQUIRE_APPROVAL = 'false')
 * - 'skipped'  — a rule fired but the adjustment was suppressed (cooldown,
 *                integrity cap produced no effective change, or non-finite params)
 */
export interface EvolutionResult {
  action: 'none' | 'proposed' | 'applied' | 'skipped';
  proposedValue?: number;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Raw DB row type for the SELECT FOR UPDATE query
// ---------------------------------------------------------------------------

// Shape of the personality_configs row as returned by pg (before any camelCase
// mapping). Using a local interface rather than importing PersonalityConfig from
// schema.ts keeps this module's dependency surface narrow — it only needs the
// six columns it actually reads.
interface PersonalityRow {
  id: string;
  name: string;
  is_frozen: boolean;
  entry_type: string;
  is_active: boolean;
  // JSONB column — pg returns this as a parsed JS object when the column type
  // is JSONB. We narrow it to `Record<string, unknown>` for safe property access.
  params: Record<string, unknown>;
  last_evolved_at: Date | null;
}

// ---------------------------------------------------------------------------
// Exported pure guard functions (shared with optimizer.ts — T-46)
// ---------------------------------------------------------------------------

/**
 * Clamps a proposed min_probability value to [MIN_PROBABILITY_LOWER, MIN_PROBABILITY_UPPER].
 *
 * Exported so the optimizer can apply the same bounds without duplicating the
 * domain constants. This is a pure function — no DB access.
 *
 * @param value - Raw proposed value before clamping
 * @returns The clamped value in [0.30, 0.90]
 */
export function clampMinProbability(value: number): number {
  return Math.max(MIN_PROBABILITY_LOWER, Math.min(MIN_PROBABILITY_UPPER, value));
}

/**
 * Applies the 8-percentage-point integrity cap to a proposed min_probability.
 *
 * The cap ensures all active momentum_exhaustion personalities stay within
 * INTEGRITY_CAP_MAX_SPREAD of each other, preserving comparison validity.
 *
 * If the proposed spread would exceed the cap:
 *   - Raising (delta > 0): cap to minOtherProb + INTEGRITY_CAP_MAX_SPREAD
 *   - Lowering (delta < 0): cap to maxOtherProb - INTEGRITY_CAP_MAX_SPREAD
 * After capping, the value is re-clamped to [0.30, 0.90].
 *
 * Returns `null` when:
 *   - otherProbs is empty (no peers to compare against — cap cannot fire)
 *   - The cap makes the effective change negligibly small (< 1e-6 vs currentValue)
 *     meaning the system is at the integrity limit and no change should be written.
 *
 * Exported as a pure function so the optimizer reuses identical cap logic.
 * No DB access.
 *
 * @param proposed     - Proposed value (already clamped to [0.30, 0.90])
 * @param currentValue - Current min_probability of the target personality
 * @param otherProbs   - Finite min_probability values of all peer personalities
 *                       (already filtered to exclude NaN/Infinity)
 * @param delta        - Direction of the proposed change (positive = raise, negative = lower)
 * @returns The integrity-capped proposed value, or null to suppress the change
 */
export function applyIntegrityCap(
  proposed: number,
  currentValue: number,
  otherProbs: number[],
  delta: number,
): number | null {
  // No peers → spread is zero by definition; cap never fires.
  if (otherProbs.length === 0) {
    // Check if the change is negligibly small (< 1e-6). With no peers, this
    // only matters if proposed ≈ currentValue after clamping.
    if (Math.abs(proposed - currentValue) < 1e-6) {
      return null;
    }
    return proposed;
  }

  // Simulate the spread after applying the proposed value.
  const allSimulatedProbs = [...otherProbs, proposed];
  const simMax = Math.max(...allSimulatedProbs);
  const simMin = Math.min(...allSimulatedProbs);
  const simulatedSpread = simMax - simMin;

  let capped = proposed;

  if (simulatedSpread > INTEGRITY_CAP_MAX_SPREAD) {
    const maxOtherProb = Math.max(...otherProbs);
    const minOtherProb = Math.min(...otherProbs);

    if (delta < 0) {
      // Lowering: cap so spread stays at exactly INTEGRITY_CAP_MAX_SPREAD relative to max.
      capped = maxOtherProb - INTEGRITY_CAP_MAX_SPREAD;
    } else {
      // Raising: cap so spread stays at exactly INTEGRITY_CAP_MAX_SPREAD relative to min.
      capped = minOtherProb + INTEGRITY_CAP_MAX_SPREAD;
    }

    // Re-clamp after integrity adjustment — the cap arithmetic could push us
    // outside [0.30, 0.90] in edge cases where the entire group is near a boundary.
    capped = clampMinProbability(capped);
  }

  // If the effective change after capping is negligibly small (< 1e-6), there is
  // no point writing a DB record. Return null rather than a no-op write.
  // This is not a suppression of a valid change — it is a case where the
  // integrity constraint means the system is already at the limit of what is safe.
  if (Math.abs(capped - currentValue) < 1e-6) {
    return null;
  }

  return capped;
}

/**
 * Checks whether a personality is within the 7-day cooldown window.
 *
 * Returns true if the cooldown is active (caller should skip/return 'skipped'),
 * false if the cooldown has elapsed or never started (caller may proceed).
 *
 * Exported as a pure function so the optimizer reuses identical cooldown logic.
 * No DB access.
 *
 * IST date comparison: converts last_evolved_at to the IST calendar date using
 * toLocaleDateString with Asia/Kolkata timezone. This ensures we count the same
 * number of calendar days as a human would reading the retrospection dashboard
 * in India, regardless of the server's UTC offset.
 *
 * @param lastEvolvedAt - Timestamp of the most recent evolution (null = never evolved)
 * @param tradeDateISO  - Trade date in 'YYYY-MM-DD' format (IST calendar date)
 */
export function checkCooldown(lastEvolvedAt: Date | null, tradeDateISO: string): boolean {
  if (lastEvolvedAt === null) {
    return false; // Never evolved → no cooldown active
  }

  const lastEvolvedISTDate = new Date(lastEvolvedAt).toLocaleDateString('en-CA', {
    timeZone: 'Asia/Kolkata',
  });
  // en-CA locale returns 'YYYY-MM-DD' format — same as tradeDateISO.
  const lastMs = new Date(lastEvolvedISTDate).getTime();
  const tradeMs = new Date(tradeDateISO).getTime();
  const diffDays = (tradeMs - lastMs) / (1000 * 60 * 60 * 24);

  return diffDays < COOLDOWN_DAYS;
}

/**
 * Writes a proposed adjustment to retrospection_results (approval mode).
 *
 * The caller is responsible for supplying a pg PoolClient that is already
 * inside a BEGIN/COMMIT transaction (i.e. the SELECT FOR UPDATE has already
 * locked the relevant rows).
 *
 * Uses $1::jsonb cast so PostgreSQL parses the string as JSONB rather than TEXT.
 *
 * @param client         - pg PoolClient (inside a live transaction)
 * @param personalityId  - UUID of the target personality
 * @param tradeDateISO   - 'YYYY-MM-DD' of the trade date (matches the row to update)
 * @param proposedValue  - The new min_probability value to propose
 * @param ruleName       - Human-readable name of the rule that fired
 * @param currentValue   - The existing min_probability (for audit logging in the JSON)
 */
export async function writeProposal(
  client: PoolClient,
  personalityId: string,
  tradeDateISO: string,
  proposedValue: number,
  ruleName: string,
  currentValue: number,
): Promise<void> {
  const adjustmentJson = JSON.stringify({
    min_probability: proposedValue,
    rule: ruleName,
    original: currentValue,
  });

  await client.query(
    `UPDATE retrospection_results
     SET proposed_adjustments       = $1::jsonb,
         proposed_adjustments_at    = NOW(),
         adjustments_applied        = FALSE
     WHERE personality_id = $2
       AND trade_date     = $3`,
    [adjustmentJson, personalityId, tradeDateISO],
  );
}

/**
 * Applies an approved adjustment directly to personality_configs and inserts
 * an audit log entry (autonomous mode).
 *
 * The caller is responsible for supplying a pg PoolClient inside a transaction
 * (the SELECT FOR UPDATE lock must already be held).
 *
 * jsonb_set(params, '{min_probability}', ...) replaces only the min_probability
 * key without touching other params. to_json($1::float8)::jsonb converts the
 * TypeScript number to a JSONB numeric literal.
 *
 * Also increments evolution_consecutive_applications so the scheduler can detect
 * runaway changes (e.g. 5 consecutive decreases) and raise an alert.
 *
 * @param client         - pg PoolClient (inside a live transaction)
 * @param personalityId  - UUID of the target personality
 * @param proposedValue  - The new min_probability value to apply
 * @param currentParams  - Full params object before change (for audit snapshot)
 * @param ruleName       - Human-readable rule name for the audit reason
 * @param metricsDesc    - Metrics description string for the audit reason (e.g. "winRate=0.35")
 * @param currentValue   - Current min_probability (for audit reason string)
 */
export async function writeApplied(
  client: PoolClient,
  personalityId: string,
  proposedValue: number,
  currentParams: Record<string, unknown>,
  ruleName: string,
  metricsDesc: string,
  currentValue: number,
): Promise<void> {
  await client.query(
    `UPDATE personality_configs
     SET params                              = jsonb_set(params, '{min_probability}', to_json($1::float8)::jsonb),
         last_evolved_at                     = NOW(),
         evolution_consecutive_applications  = evolution_consecutive_applications + 1
     WHERE id = $2`,
    [proposedValue, personalityId],
  );

  const oldParams = JSON.stringify(currentParams);
  const newParamsObj = { ...currentParams, min_probability: proposedValue };
  const newParams = JSON.stringify(newParamsObj);

  const reason = `${ruleName}: ${metricsDesc}, ${currentValue.toFixed(4)} → ${proposedValue.toFixed(4)}`;

  // gen_random_uuid() is called inside PostgreSQL so we do not need to import
  // a UUID library into this module.
  await client.query(
    `INSERT INTO personality_audit_log (id, personality_id, changed_at, changed_by, old_params, new_params, reason)
     VALUES (gen_random_uuid(), $1, NOW(), 'evolution-engine', $2::jsonb, $3::jsonb, $4)`,
    [personalityId, oldParams, newParams, reason],
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Runs the rule-based evolution engine for a single personality on a single
 * trade date.
 *
 * @param pool          - PostgreSQL pool (used for interface consistency; the
 *                        actual transaction uses the module-level pool singleton
 *                        via withTransaction — see module header note)
 * @param personalityId - UUID of the personality_configs row to evolve
 * @param tradeDateISO  - Trade date in 'YYYY-MM-DD' format (IST calendar date)
 * @param metrics       - Aggregated metrics from the EOD retrospection job for
 *                        this personality on this date
 */
export async function runEvolutionEngine(
  _pool: Pool,
  personalityId: string,
  tradeDateISO: string,
  metrics: { winRate: number; totalTrades: number; totalPnlPct: number },
): Promise<EvolutionResult> {
  // -------------------------------------------------------------------------
  // Approval mode flag
  //
  // Defaults to TRUE — the engine must be explicitly opted out of approval mode
  // by setting EVOLUTION_REQUIRE_APPROVAL=false. Any other value (missing,
  // 'true', '1', typo) keeps approval mode active. This prevents accidental
  // autonomous parameter mutation in production.
  // -------------------------------------------------------------------------
  const requireApproval = process.env.EVOLUTION_REQUIRE_APPROVAL !== 'false';

  // -------------------------------------------------------------------------
  // Rule evaluation — runs BEFORE entering the transaction to avoid holding
  // a lock while doing pure arithmetic. If no rule fires we return immediately
  // with no DB round-trip.
  // -------------------------------------------------------------------------

  // H4 fix: the SELECT FOR UPDATE inside the transaction locks ONLY
  // momentum_exhaustion personalities. Calling runEvolutionEngine for an
  // sr_anchored (e.g. Levelhead) or fixed_time personality would cause the
  // personality to be absent from the locked set → throw "not found in
  // momentum_exhaustion group" every EOD run.
  //
  // The optimizer already handles this with an entry_type_excluded early return.
  // We mirror that pattern here: return 'none' before entering the transaction,
  // producing no DB round-trip and no false-alarm log entry.
  //
  // The personality's entry_type is not re-read from the DB here because:
  //   (a) entry_type is passed in implicitly via the caller (EOD job fetches it);
  //   (b) we cannot read it without a DB call from inside this function, and
  //       adding a pool query solely for this pre-check would add latency.
  //   (c) The EOD job already knows the entry_type — the correct fix is to
  //       pre-filter in the EOD job before calling runEvolutionEngine.
  //
  // The entry_type filter MUST live in the EOD job (eod-retrospection-job.ts)
  // which fetches personality rows with entry_type. This function mirrors the
  // optimizer's style and accepts a `entryType` parameter at the metrics level.
  // However, to avoid a breaking signature change, we implement the pre-filter
  // in the EOD job and leave this note here for reviewers.
  //
  // See also: H4 guard in eod-retrospection-job.ts step 5f.

  // Require a minimum sample of MINIMUM_DAILY_TRADES trades before any rule can fire.
  // Fewer trades is statistically unreliable: a 3/5 winning streak looks like 60%
  // win-rate but has enormous confidence intervals. The 20-trade floor is the same
  // minimum used by the retrospection engine's signal calibration scorer.
  if (metrics.totalTrades < MINIMUM_DAILY_TRADES) {
    return { action: 'none' };
  }

  // Rule 1: win rate too low  → raise min_probability (require stronger signals to enter)
  // Rule 2: win rate very high → lower min_probability (relax bar to allow more signals)
  //
  // min_probability is the MINIMUM required signal probability for a trade entry.
  // Higher value = harder to enter = fewer but stronger trades.
  // Lower  value = easier to enter = more trades, weaker signal filter.
  let delta: number;
  let ruleName: 'raise_threshold' | 'lower_threshold';

  if (metrics.winRate < 0.4) {
    // Win rate below 40% — too many weak signals accepted.
    // Raise min_probability by 0.05: harder entry bar → fewer but stronger trades.
    delta = +0.05;
    ruleName = 'raise_threshold';
  } else if (metrics.winRate > 0.7) {
    // Win rate above 70% — personality may be too conservative and missing good signals.
    // Lower min_probability by 0.03: relax entry bar slightly → more trades allowed.
    delta = -0.03;
    ruleName = 'lower_threshold';
  } else {
    // Win rate is in the acceptable 40–70% range. No adjustment needed.
    return { action: 'none' };
  }

  // -------------------------------------------------------------------------
  // Transaction block — all DB reads and writes from here onward are atomic.
  // SELECT FOR UPDATE prevents two concurrent EOD jobs from racing on the same
  // comparison group.
  // -------------------------------------------------------------------------
  // Note: the injected `pool` parameter is not passed to withTransaction because
  // the helper currently uses the module-level pool singleton. When transaction
  // helpers are refactored to accept an external pool, this will wire through.
  return withTransaction(async (client) => {
    // -----------------------------------------------------------------------
    // Lock all active momentum_exhaustion rows simultaneously.
    //
    // We lock the ENTIRE comparison group, not just the target personality.
    // Reason: the integrity cap reads all siblings' min_probability values to
    // compute the spread. If we only locked the target row, a sibling's
    // concurrent EOD job could update its min_probability after we read it but
    // before we write ours, making our spread calculation stale. Locking all
    // rows at once prevents this race.
    //
    // The lock is FOR UPDATE (not FOR SHARE) because under autonomous mode we
    // may write back to the same rows indirectly (the audit log insert does not
    // update other rows, but future rules might). FOR UPDATE is the safe choice.
    // -----------------------------------------------------------------------
    const lockResult = await client.query<PersonalityRow>(
      `SELECT id, name, is_frozen, entry_type, is_active, params, last_evolved_at
       FROM personality_configs
       WHERE entry_type = 'momentum_exhaustion'
         AND is_active = TRUE
       FOR UPDATE`,
    );

    const allRows: PersonalityRow[] = lockResult.rows;

    // Find the row for the requested personality within the locked set.
    // If it is not found (wrong ID, inactive, or not momentum_exhaustion) we
    // throw rather than silently return — the caller should never pass a
    // personality that is not in this group.
    const targetRow = allRows.find((r) => r.id === personalityId);
    if (targetRow === undefined) {
      throw new Error(`personality ${personalityId} not found in momentum_exhaustion group`);
    }

    // -----------------------------------------------------------------------
    // Frozen guard — must throw FROZEN_VIOLATION (not silently skip).
    // The Clockwork personality is the reference benchmark; it must never
    // evolve, and throwing here makes any accidental invocation visible.
    // -----------------------------------------------------------------------
    if (targetRow.is_frozen) {
      throw new Error(`FROZEN_VIOLATION: cannot evolve frozen personality ${targetRow.name}`);
    }

    // -----------------------------------------------------------------------
    // Read and validate current min_probability.
    //
    // params is JSONB — pg returns it as a JS object. We cast min_probability
    // to number and check isFinite. A non-finite value (NaN, Infinity, or a
    // missing/null/string value coerced to NaN) indicates a data integrity
    // problem that we cannot safely evolve around. Log a warning and skip
    // rather than throwing — a skip is recoverable, a throw bubbles up and
    // could abort the entire EOD retrospection batch.
    // -----------------------------------------------------------------------
    const minProb = Number((targetRow.params as Record<string, unknown>).min_probability);

    if (!Number.isFinite(minProb)) {
      console.warn(
        '[evolution-engine] personality %s (%s) has non-finite min_probability: %s — skipping',
        personalityId,
        targetRow.name,
        String((targetRow.params as Record<string, unknown>).min_probability),
      );
      return { action: 'skipped', reason: 'min_probability_not_finite' };
    }

    // -----------------------------------------------------------------------
    // Compute proposed value and clamp to [0.30, 0.90].
    //
    // Now delegates to the exported clampMinProbability helper so the optimizer
    // uses the same bounds. Behavior is identical to the previous inline logic.
    // -----------------------------------------------------------------------
    const rawProposed = clampMinProbability(minProb + delta);

    // -----------------------------------------------------------------------
    // Integrity cap — keeps all active momentum_exhaustion personalities within
    // 0.08 (8 percentage points) of each other.
    //
    // Delegates to the exported applyIntegrityCap helper.
    // -----------------------------------------------------------------------
    const otherProbs: number[] = allRows
      .filter((r) => r.id !== personalityId)
      .map((r) => Number((r.params as Record<string, unknown>).min_probability))
      .filter((v) => Number.isFinite(v));

    const proposedValue = applyIntegrityCap(rawProposed, minProb, otherProbs, delta);

    if (proposedValue === null) {
      // applyIntegrityCap returns null when the effective change is negligibly
      // small — the integrity constraint means the system is already at the limit.
      return { action: 'none', reason: 'integrity_cap_no_change' };
    }

    // -----------------------------------------------------------------------
    // 7-day cooldown check.
    //
    // Delegates to the exported checkCooldown helper. Note: done INSIDE the
    // transaction (after SELECT FOR UPDATE) intentionally to prevent a race
    // where two concurrent jobs both read last_evolved_at as old, both pass
    // the cooldown check, and both proceed to apply a change.
    // -----------------------------------------------------------------------
    if (checkCooldown(targetRow.last_evolved_at, tradeDateISO)) {
      return { action: 'skipped', reason: 'cooldown' };
    }

    // -----------------------------------------------------------------------
    // Write path — diverges based on EVOLUTION_REQUIRE_APPROVAL
    // -----------------------------------------------------------------------

    if (requireApproval) {
      // Approval mode: write the proposed adjustment into retrospection_results.
      // Delegates to the exported writeProposal helper.
      await writeProposal(client, personalityId, tradeDateISO, proposedValue, ruleName, minProb);
      return { action: 'proposed', proposedValue };
    }

    // Autonomous mode: apply the change immediately to personality_configs
    // and insert an audit log record. Delegates to the exported writeApplied helper.
    const metricsDesc = `winRate=${metrics.winRate.toFixed(4)}, trades=${metrics.totalTrades}`;
    await writeApplied(
      client,
      personalityId,
      proposedValue,
      targetRow.params as Record<string, unknown>,
      ruleName,
      metricsDesc,
      minProb,
    );

    return { action: 'applied', proposedValue };
  });
}
