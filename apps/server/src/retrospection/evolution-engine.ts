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
 */

import type { Pool } from 'pg';
import { withTransaction } from '../db/client.js';

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

  // Require a minimum sample of 20 trades before any rule can fire.
  // Fewer than 20 trades is statistically unreliable: a 3/5 winning streak
  // looks like 60% win-rate but has enormous confidence intervals. The 20-trade
  // floor is the same minimum used by the retrospection engine's signal
  // calibration scorer.
  if (metrics.totalTrades < 20) {
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
    // The clamp bounds are domain constants for this strategy type:
    //   - 0.30 lower bound: below 30% probability the signal is essentially
    //     noise and we should not be trading at all regardless of win rate.
    //   - 0.90 upper bound: requiring 90%+ confidence on every trade would
    //     effectively turn off the strategy (signals this strong are rare).
    // -----------------------------------------------------------------------
    let proposedValue = Math.max(0.3, Math.min(0.9, minProb + delta));

    // -----------------------------------------------------------------------
    // Integrity cap — keeps all active momentum_exhaustion personalities within
    // 0.08 (8 percentage points) of each other.
    //
    // This preserves the comparison validity between Precision, Adjuster, and
    // Reducer. If they drift beyond 8pp they are entering on meaningfully
    // different quality signals and we can no longer attribute P&L differences
    // to management style alone.
    //
    // The cap works by simulating what the spread would be AFTER this proposed
    // change, and if it would exceed 0.08, we compute the tightest proposed
    // value that keeps the spread at exactly 0.08.
    //
    // This is a CAP, not a BLOCK. We find the best value we can apply within
    // constraints rather than refusing to evolve at all. The only exception is
    // when the cap makes the effective change so small it rounds to zero (< 1e-6
    // difference), in which case we return 'none' to avoid writing a no-op.
    // -----------------------------------------------------------------------
    const otherProbs: number[] = allRows
      .filter((r) => r.id !== personalityId)
      .map((r) => Number((r.params as Record<string, unknown>).min_probability))
      .filter((v) => Number.isFinite(v));
    // Note: if all other personalities have non-finite min_probability, otherProbs
    // is empty. In that case the spread is 0 and the cap never fires — which is
    // the correct behaviour: we cannot compute a meaningful spread without peers.

    if (otherProbs.length > 0) {
      // Simulate the spread after applying proposedValue to the target.
      const allSimulatedProbs = [...otherProbs, proposedValue];
      const simMax = Math.max(...allSimulatedProbs);
      const simMin = Math.min(...allSimulatedProbs);
      const simulatedSpread = simMax - simMin;

      if (simulatedSpread > 0.08) {
        const maxOtherProb = Math.max(...otherProbs);
        const minOtherProb = Math.min(...otherProbs);

        if (delta < 0) {
          // We are lowering proposedValue (lowering min_probability = accepting weaker signals).
          // The new proposed value is pulling the spread too wide at the bottom.
          // Cap it so the spread stays at exactly 0.08 relative to the current max.
          proposedValue = maxOtherProb - 0.08;
        } else {
          // We are raising proposedValue (raising min_probability = being more selective).
          // The new proposed value is pulling the spread too wide at the top.
          // Cap it so the spread stays at exactly 0.08 relative to the current min.
          proposedValue = minOtherProb + 0.08;
        }

        // Re-clamp after integrity adjustment — the cap arithmetic could push us
        // outside [0.30, 0.90] in edge cases where the entire group is near a boundary.
        proposedValue = Math.max(0.3, Math.min(0.9, proposedValue));
      }
    }

    // If the effective change after capping is negligibly small (< 1e-6), there is
    // no point writing a DB record. Return 'none' rather than 'skipped' because
    // this is not a suppression of a valid change — it is a case where the
    // integrity constraint means the system is already at the limit of what is
    // safe to change.
    if (Math.abs(proposedValue - minProb) < 1e-6) {
      return { action: 'none', reason: 'integrity_cap_no_change' };
    }

    // -----------------------------------------------------------------------
    // 7-day cooldown check.
    //
    // The cooldown prevents the engine from applying multiple adjustments in
    // quick succession before we can observe whether the previous change had
    // any effect. 7 calendar days corresponds to roughly 5 trading days —
    // enough to accumulate a meaningful sample after the previous adjustment.
    //
    // IST date comparison: we convert last_evolved_at to the IST calendar date
    // using toLocaleDateString with the Asia/Kolkata timezone. This ensures we
    // count the same number of calendar days as a human would reading the
    // retrospection dashboard in India, regardless of the server's UTC offset.
    //
    // Note: The cooldown check is done INSIDE the transaction (after the
    // SELECT FOR UPDATE) intentionally. This prevents a race where two
    // concurrent jobs both read last_evolved_at as old, both pass the cooldown
    // check, and both proceed to apply a change.
    // -----------------------------------------------------------------------
    if (targetRow.last_evolved_at !== null) {
      const lastEvolvedISTDate = new Date(targetRow.last_evolved_at).toLocaleDateString('en-CA', {
        timeZone: 'Asia/Kolkata',
      });
      // en-CA locale returns 'YYYY-MM-DD' format — the same format as tradeDateISO.
      // We parse both as dates at midnight UTC and compute the difference in days.
      const lastMs = new Date(lastEvolvedISTDate).getTime();
      const tradeMs = new Date(tradeDateISO).getTime();
      const diffDays = (tradeMs - lastMs) / (1000 * 60 * 60 * 24);

      if (diffDays < 7) {
        return { action: 'skipped', reason: 'cooldown' };
      }
    }

    // -----------------------------------------------------------------------
    // Write path — diverges based on EVOLUTION_REQUIRE_APPROVAL
    // -----------------------------------------------------------------------

    const adjustmentJson = JSON.stringify({
      min_probability: proposedValue,
      rule: ruleName,
      original: minProb,
    });

    if (requireApproval) {
      // -------------------------------------------------------------------
      // Approval mode: write the proposed adjustment into retrospection_results.
      // A human (or an API endpoint) reviews the proposal and applies it via
      // a separate code path when ready.
      //
      // We use $1::jsonb cast so PostgreSQL parses the string as JSONB rather
      // than treating it as TEXT. Not using a JS object directly because the
      // pg driver would serialise it as TEXT for a JSONB column without the cast.
      // -------------------------------------------------------------------
      await client.query(
        `UPDATE retrospection_results
         SET proposed_adjustments       = $1::jsonb,
             proposed_adjustments_at    = NOW(),
             adjustments_applied        = FALSE
         WHERE personality_id = $2
           AND trade_date     = $3`,
        [adjustmentJson, personalityId, tradeDateISO],
      );

      return { action: 'proposed', proposedValue };
    }
    // -------------------------------------------------------------------
    // Autonomous mode: apply the change immediately to personality_configs.
    //
    // jsonb_set(params, '{min_probability}', ...) creates or replaces the
    // min_probability key inside the params JSONB object without touching
    // any other keys. to_json($1::float8)::jsonb converts the TypeScript
    // number to a JSONB numeric literal.
    //
    // We also increment evolution_consecutive_applications so the evolution
    // scheduler can detect runaway changes (e.g. 5 consecutive decreases)
    // and raise an alert.
    // -------------------------------------------------------------------
    await client.query(
      `UPDATE personality_configs
       SET params                              = jsonb_set(params, '{min_probability}', to_json($1::float8)::jsonb),
           last_evolved_at                     = NOW(),
           evolution_consecutive_applications  = evolution_consecutive_applications + 1
       WHERE id = $2`,
      [proposedValue, personalityId],
    );

    // Build old_params and new_params snapshots for the audit log.
    // We construct new_params by shallow-merging the updated field rather
    // than re-querying — the transaction has not committed yet so a
    // re-SELECT would return the updated row, making old_params identical.
    const oldParams = JSON.stringify(targetRow.params);
    const newParamsObj = {
      ...(targetRow.params as Record<string, unknown>),
      min_probability: proposedValue,
    };
    const newParams = JSON.stringify(newParamsObj);

    // Insert an immutable audit record. gen_random_uuid() is called inside
    // PostgreSQL so we do not need to import a UUID library into this module.
    // The reason string is human-readable and includes the rule name and the
    // numeric values so it is self-contained — someone reading the audit log
    // in 6 months does not need to cross-reference the evolution engine source.
    const reason = `${ruleName}: winRate=${metrics.winRate.toFixed(4)}, trades=${metrics.totalTrades}, ${minProb.toFixed(4)} → ${proposedValue.toFixed(4)}`;

    await client.query(
      `INSERT INTO personality_audit_log (id, personality_id, changed_at, changed_by, old_params, new_params, reason)
       VALUES (gen_random_uuid(), $1, NOW(), 'evolution-engine', $2::jsonb, $3::jsonb, $4)`,
      [personalityId, oldParams, newParams, reason],
    );

    return { action: 'applied', proposedValue };
  });
}
