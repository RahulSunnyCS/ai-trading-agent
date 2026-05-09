import { query } from '../db/client';
import { invalidatePersonalityCache } from './personality-cache';
import type { PersonalityConfig, RetrospectionResult } from '../db/schema';
import type { EvolutionProposal } from './retrospection';

// ── Error ──────────────────────────────────────────────────────────────────────

export class FrozenPersonalityError extends Error {
  constructor(name: string) {
    super(`Personality '${name}' is frozen — evolution rules must never be applied`);
    this.name = 'FrozenPersonalityError';
  }
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Applies auto-approved rule proposals from today's retrospection result to
 * personality_configs. Guards against frozen personalities and cooldowns.
 * Called at 15:50 IST after retrospection completes.
 */
export async function applyEvolutionRules(
  personalityId: string,
  result: Pick<RetrospectionResult, 'personality_id' | 'suggested_changes'>,
): Promise<void> {
  const [personality] = await query<PersonalityConfig>(
    `SELECT * FROM personality_configs WHERE id = $1`,
    [personalityId],
  );
  if (!personality) return;

  if (personality.is_frozen) {
    throw new FrozenPersonalityError(personality.name);
  }

  const suggestedChanges = result.suggested_changes as { rules_triggered?: EvolutionProposal[] } | null;
  const proposals = suggestedChanges?.rules_triggered ?? [];

  for (const proposal of proposals) {
    const applied = applyProposal(personality, proposal);
    if (!applied) continue;

    const { parameter, new_value } = applied;
    await query(
      `UPDATE personality_configs SET ${parameter} = $1 WHERE id = $2`,
      [new_value, personalityId],
    );
    console.log(`[evolution] ${personality.name}: ${parameter} ${applied.old_value} → ${new_value} (${proposal.rule_id})`);

    // Mark retrospection result as applied
    await query(
      `UPDATE retrospection_results SET applied = TRUE, applied_at = NOW()
        WHERE personality_id = $1 AND analysis_date = CURRENT_DATE`,
      [personalityId],
    );
  }

  // Invalidate cache so new params are picked up immediately
  if (proposals.length > 0) invalidatePersonalityCache();
}

// ── Rule evaluation (exported for testing) ────────────────────────────────────

export interface RuleEvaluation {
  triggered:       boolean;
  minSamplesMet:   boolean;
  inCooldown:      boolean;
  proposal?:       { parameter: string; old_value: number; new_value: number };
}

/**
 * Pure — evaluates a single evolution proposal against personality state.
 * Returns whether it should be applied, with guards for cooldown and drift cap.
 */
export function evaluateRuleConditions(
  proposal: EvolutionProposal,
  personality: PersonalityConfig,
): RuleEvaluation {
  const today = new Date().toISOString().slice(0, 10);

  const inCooldown = proposal.cooldown_expires_at > today;
  if (inCooldown) {
    return { triggered: false, minSamplesMet: proposal.min_samples_met, inCooldown: true };
  }

  if (!proposal.min_samples_met || !proposal.condition_met) {
    return { triggered: false, minSamplesMet: proposal.min_samples_met, inCooldown: false };
  }

  if (!proposal.proposal) {
    return { triggered: false, minSamplesMet: true, inCooldown: false };
  }

  const { parameter, old_value, new_value } = proposal.proposal;

  // Max drift guard: prevent parameter drifting more than 20% from the old value
  const drift = Math.abs(new_value - old_value) / Math.max(Math.abs(old_value), 0.01);
  const clampedValue = drift > 0.20
    ? old_value + Math.sign(new_value - old_value) * Math.abs(old_value) * 0.20
    : new_value;

  return {
    triggered:     true,
    minSamplesMet: true,
    inCooldown:    false,
    proposal:      { parameter, old_value, new_value: clampedValue },
  };
}

// ── Private ────────────────────────────────────────────────────────────────────

function applyProposal(
  personality: PersonalityConfig,
  proposal: EvolutionProposal,
): { parameter: string; old_value: number; new_value: number } | null {
  if (proposal.requires_approval) {
    console.log(`[evolution] ${personality.name}: proposal '${proposal.rule_id}' requires human approval — skipped`);
    return null;
  }

  const eval_ = evaluateRuleConditions(proposal, personality);
  if (!eval_.triggered || !eval_.proposal) return null;

  return eval_.proposal;
}
