import { mock, describe, it, expect } from 'bun:test';

mock.module('../../db/client', () => ({
  query: mock(() => Promise.resolve([])),
}));
mock.module('../personality-cache', () => ({
  invalidatePersonalityCache: mock(() => undefined),
  loadActivePersonalities:    mock(() => Promise.resolve([])),
}));

const {
  applyEvolutionRules,
  evaluateRuleConditions,
  FrozenPersonalityError,
} = await import('../evolution-rules');

import type { PersonalityConfig, RetrospectionResult } from '../../db/schema';
import type { EvolutionProposal } from '../retrospection';

// ── Fixtures ───────────────────────────────────────────────────────────────────

const today = new Date().toISOString().slice(0, 10);
const futureDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
const pastDate   = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

function makePersonality(overrides: Partial<PersonalityConfig> = {}): PersonalityConfig {
  return {
    id: 'p1',
    name: 'precision',
    version: 1,
    is_active: true,
    is_frozen: false,
    created_at: new Date(),
    entry_type: 'MOMENTUM_EXHAUSTION',
    management_style: 'HOLD',
    phase: 1,
    min_probability: 0.70,
    max_daily_trades: 2,
    max_daily_loss: 8000,
    entry_delay_secs: 0,
    position_multiplier: 1,
    min_vix: 0,
    max_vix: 30,
    require_profit_gate: false,
    allow_reentry: false,
    ...overrides,
  };
}

function makeProposal(overrides: Partial<EvolutionProposal> = {}): EvolutionProposal {
  return {
    rule_id: 'low_win_rate',
    min_samples_met: true,
    condition_met: true,
    proposal: {
      parameter:  'min_probability',
      old_value:  0.70,
      new_value:  0.75,
      reasoning:  'win_rate=0.35 < 0.40 over 30 trades',
    },
    requires_approval:   false,
    cooldown_expires_at: pastDate, // expired → not in cooldown
    ...overrides,
  };
}

function makeResult(proposals: EvolutionProposal[] = []): Pick<RetrospectionResult, 'personality_id' | 'suggested_changes'> {
  return {
    personality_id:   'p1',
    suggested_changes: { rules_triggered: proposals },
  };
}

// ── applyEvolutionRules ────────────────────────────────────────────────────────

describe('applyEvolutionRules', () => {
  it('frozen personality → throws FrozenPersonalityError', async () => {
    const { query: mockQ } = await import('../../db/client');
    (mockQ as ReturnType<typeof mock>).mockImplementation(() =>
      Promise.resolve([makePersonality({ is_frozen: true, name: 'clockwork' })])
    );

    await expect(applyEvolutionRules('p1', makeResult())).rejects.toThrow(FrozenPersonalityError);
  });

  it('requires_approval proposal is not applied', async () => {
    const updates: string[] = [];
    const { query: mockQ } = await import('../../db/client');
    (mockQ as ReturnType<typeof mock>).mockImplementation((sql: string) => {
      if (sql.includes('UPDATE personality_configs SET')) updates.push(sql);
      return Promise.resolve([makePersonality()]);
    });

    const proposal = makeProposal({ requires_approval: true });
    await applyEvolutionRules('p1', makeResult([proposal]));
    expect(updates).toHaveLength(0);
  });

  it('in-cooldown proposal is not applied', async () => {
    const updates: string[] = [];
    const { query: mockQ } = await import('../../db/client');
    (mockQ as ReturnType<typeof mock>).mockImplementation((sql: string) => {
      if (sql.includes('UPDATE personality_configs SET')) updates.push(sql);
      return Promise.resolve([makePersonality()]);
    });

    const proposal = makeProposal({ cooldown_expires_at: futureDate });
    await applyEvolutionRules('p1', makeResult([proposal]));
    expect(updates).toHaveLength(0);
  });

  it('valid proposal is applied and UPDATE is called', async () => {
    const updates: string[] = [];
    const { query: mockQ } = await import('../../db/client');
    (mockQ as ReturnType<typeof mock>).mockImplementation((sql: string) => {
      if (typeof sql === 'string' && sql.includes('UPDATE personality_configs SET')) {
        updates.push(sql);
      }
      return Promise.resolve([makePersonality()]);
    });

    const proposal = makeProposal();
    await applyEvolutionRules('p1', makeResult([proposal]));
    expect(updates.length).toBeGreaterThanOrEqual(1);
  });
});

// ── evaluateRuleConditions ─────────────────────────────────────────────────────

describe('evaluateRuleConditions', () => {
  it('in-cooldown → not triggered', () => {
    const result = evaluateRuleConditions(makeProposal({ cooldown_expires_at: futureDate }), makePersonality());
    expect(result.triggered).toBe(false);
    expect(result.inCooldown).toBe(true);
  });

  it('min_samples_met = false → not triggered', () => {
    const result = evaluateRuleConditions(
      makeProposal({ min_samples_met: false }),
      makePersonality(),
    );
    expect(result.triggered).toBe(false);
    expect(result.minSamplesMet).toBe(false);
  });

  it('condition_met = false → not triggered', () => {
    const result = evaluateRuleConditions(
      makeProposal({ condition_met: false }),
      makePersonality(),
    );
    expect(result.triggered).toBe(false);
  });

  it('valid proposal → triggered with proposal', () => {
    const result = evaluateRuleConditions(makeProposal(), makePersonality());
    expect(result.triggered).toBe(true);
    expect(result.proposal?.parameter).toBe('min_probability');
    expect(result.proposal?.new_value).toBeCloseTo(0.75);
  });

  it('max drift guard: clamps new_value to 20% change', () => {
    const bigJump = makeProposal({
      proposal: { parameter: 'min_probability', old_value: 0.70, new_value: 0.99, reasoning: 'test' },
    });
    const result = evaluateRuleConditions(bigJump, makePersonality());
    // Max 20% of 0.70 = 0.14 → capped at 0.70 + 0.14 = 0.84
    expect(result.triggered).toBe(true);
    expect(result.proposal?.new_value).toBeCloseTo(0.84);
  });

  it('negative drift: clamps downward change to -20%', () => {
    const bigDrop = makeProposal({
      proposal: { parameter: 'min_probability', old_value: 0.70, new_value: 0.40, reasoning: 'test' },
    });
    const result = evaluateRuleConditions(bigDrop, makePersonality());
    // Max 20% of 0.70 = 0.14 → capped at 0.70 - 0.14 = 0.56
    expect(result.triggered).toBe(true);
    expect(result.proposal?.new_value).toBeCloseTo(0.56);
  });
});

// ── FrozenPersonalityError ────────────────────────────────────────────────────

describe('FrozenPersonalityError', () => {
  it('is an instance of Error', () => {
    const err = new FrozenPersonalityError('clockwork');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('FrozenPersonalityError');
    expect(err.message).toContain('clockwork');
  });
});
