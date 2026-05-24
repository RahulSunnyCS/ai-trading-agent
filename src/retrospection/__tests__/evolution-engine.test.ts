/**
 * Unit tests for evolution-engine.ts
 *
 * The evolution engine uses `withTransaction` from src/db/client.ts, which
 * always uses the module-level pool singleton — it cannot be replaced by
 * injecting a pool. We mock the entire `../../db/client.js` module so that
 * `withTransaction` calls our stub, which immediately invokes the callback
 * with a mock pg.PoolClient.
 *
 * The injected `pool: Pool` parameter is accepted for interface consistency
 * but is currently unused inside withTransaction (see evolution-engine.ts
 * module header). We pass a no-op mock to satisfy the type signature.
 *
 * Safety invariants tested:
 *   1. Frozen personalities → FROZEN_VIOLATION error
 *   2. Minimum sample guard: totalTrades < 20 → action: 'none'
 *   3. 7-day cooldown
 *   4. Rule 1: winRate < 0.4 → raise min_probability (+0.05)
 *   5. Rule 2: winRate > 0.7 → lower min_probability (-0.03)
 *   6. Integrity cap: proposed spread > 0.08 → cap to exactly 0.08
 *   7. Approval mode: action is 'proposed'
 *   8. Autonomous mode: action is 'applied'
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { runEvolutionEngine } from '../evolution-engine.js';

// ---------------------------------------------------------------------------
// Mock withTransaction from src/db/client.ts
//
// vi.mock hoisting: this call is hoisted to the top of the module by Vitest
// before any imports execute, so it correctly intercepts the import in
// evolution-engine.ts. The factory function returns an object whose
// `withTransaction` immediately invokes the callback with our mock client.
// ---------------------------------------------------------------------------

const mockClientQuery = vi.fn();

vi.mock('../../db/client.js', () => {
  return {
    withTransaction: vi.fn(async (fn: (client: PoolClient) => Promise<unknown>) => {
      // Create a mock PoolClient whose query() can be controlled per-test.
      const client = { query: mockClientQuery } as unknown as PoolClient;
      return fn(client);
    }),
  };
});

// ---------------------------------------------------------------------------
// Pool stub — unused by evolution-engine internals but required by the type
// ---------------------------------------------------------------------------

const noopPool = { query: vi.fn() } as unknown as Pool;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal metrics payload that will pass the totalTrades ≥ 20 guard. */
const metricsAboveMinSample = {
  winRate: 0.55, // in the 40-70% "no change" range
  totalTrades: 25,
  totalPnlPct: 10.0,
};

/** Minimal PersonalityRow returned by the SELECT FOR UPDATE query inside the transaction. */
function makePersonalityRow(overrides: Partial<{
  id: string;
  name: string;
  is_frozen: boolean;
  entry_type: string;
  is_active: boolean;
  params: Record<string, unknown>;
  last_evolved_at: Date | null;
}> = {}) {
  return {
    id: 'p-target',
    name: 'Precision',
    is_frozen: false,
    entry_type: 'momentum_exhaustion',
    is_active: true,
    params: { min_probability: 0.65 },
    last_evolved_at: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Default: EVOLUTION_REQUIRE_APPROVAL not set (defaults to require approval)
  delete process.env.EVOLUTION_REQUIRE_APPROVAL;
});

afterEach(() => {
  delete process.env.EVOLUTION_REQUIRE_APPROVAL;
});

// ---------------------------------------------------------------------------
// Guard: minimum sample (runs BEFORE the transaction)
// ---------------------------------------------------------------------------

describe('runEvolutionEngine — minimum sample guard', () => {
  it('returns action="none" when totalTrades < 20 without entering the transaction', async () => {
    // The early-return guard fires before withTransaction is called.
    // We verify the transaction is never entered by confirming mockClientQuery
    // is never called.
    const metrics = { winRate: 0.3, totalTrades: 19, totalPnlPct: -5.0 };

    const result = await runEvolutionEngine(noopPool, 'p-target', '2024-11-15', metrics);

    expect(result).toEqual({ action: 'none' });
    expect(mockClientQuery).not.toHaveBeenCalled();
  });

  it('returns action="none" when totalTrades = 0', async () => {
    const result = await runEvolutionEngine(
      noopPool,
      'p-target',
      '2024-11-15',
      { winRate: 0.0, totalTrades: 0, totalPnlPct: 0.0 },
    );

    expect(result).toEqual({ action: 'none' });
  });
});

// ---------------------------------------------------------------------------
// Guard: win rate in acceptable range (40–70%) — no rule fires
// ---------------------------------------------------------------------------

describe('runEvolutionEngine — no rule fires when winRate is in 40-70% range', () => {
  it('returns action="none" when winRate = 0.55 (no adjustment needed)', async () => {
    // winRate in [0.4, 0.7] → no rule fires → return before transaction.
    const metrics = { winRate: 0.55, totalTrades: 25, totalPnlPct: 8.0 };

    const result = await runEvolutionEngine(noopPool, 'p-target', '2024-11-15', metrics);

    expect(result).toEqual({ action: 'none' });
    expect(mockClientQuery).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Frozen personality guard (inside transaction)
// ---------------------------------------------------------------------------

describe('runEvolutionEngine — frozen personality', () => {
  it('throws an error containing "FROZEN_VIOLATION" when is_frozen = true', async () => {
    // Clockwork must never be evolved. Any attempt throws FROZEN_VIOLATION
    // rather than silently skipping — this makes the mistake visible.
    const frozenRow = makePersonalityRow({ is_frozen: true, name: 'Clockwork' });
    mockClientQuery.mockResolvedValueOnce({ rows: [frozenRow] });

    const metrics = { winRate: 0.3, totalTrades: 25, totalPnlPct: -3.0 };

    await expect(
      runEvolutionEngine(noopPool, 'p-target', '2024-11-15', metrics),
    ).rejects.toThrow('FROZEN_VIOLATION');
  });
});

// ---------------------------------------------------------------------------
// 7-day cooldown guard (inside transaction, after frozen check)
// ---------------------------------------------------------------------------

describe('runEvolutionEngine — 7-day cooldown', () => {
  it('returns action="skipped" with reason="cooldown" when last evolved 3 days ago', async () => {
    // 3 days ago = within the 7-day cooldown window.
    const lastEvolvedAt = new Date('2024-11-12T10:00:00Z'); // tradeDateISO = 2024-11-15 → 3 days diff
    const row = makePersonalityRow({ last_evolved_at: lastEvolvedAt });
    // Setup: lockResult query returns [row], subsequent queries are write stubs.
    mockClientQuery.mockResolvedValueOnce({ rows: [row] });

    const metrics = { winRate: 0.3, totalTrades: 25, totalPnlPct: -3.0 };

    const result = await runEvolutionEngine(noopPool, 'p-target', '2024-11-15', metrics);

    expect(result).toEqual({ action: 'skipped', reason: 'cooldown' });
  });

  it('proceeds past cooldown when last evolved exactly 7 days ago', async () => {
    // 7 days ago = NOT within cooldown (diffDays = 7, condition is < 7).
    const lastEvolvedAt = new Date('2024-11-08T00:00:00Z'); // tradeDateISO = 2024-11-15 → 7 days
    const row = makePersonalityRow({ last_evolved_at: lastEvolvedAt });
    // First query: SELECT FOR UPDATE (returns rows)
    mockClientQuery.mockResolvedValueOnce({ rows: [row] });
    // Second query: UPDATE retrospection_results (approval mode stub)
    mockClientQuery.mockResolvedValueOnce({ rows: [] });

    const metrics = { winRate: 0.3, totalTrades: 25, totalPnlPct: -3.0 }; // triggers raise_threshold

    const result = await runEvolutionEngine(noopPool, 'p-target', '2024-11-15', metrics);

    // Not 'skipped' — cooldown elapsed
    expect(result.action).not.toBe('skipped');
  });
});

// ---------------------------------------------------------------------------
// Rule 1: winRate < 0.4 → raise min_probability (+0.05)
// ---------------------------------------------------------------------------

describe('runEvolutionEngine — Rule 1: raise threshold when winRate < 0.4', () => {
  it('proposes a min_probability that is 0.05 higher than the current value', async () => {
    // current min_probability = 0.65, delta = +0.05 → proposed = 0.70
    const row = makePersonalityRow({ params: { min_probability: 0.65 } });
    mockClientQuery.mockResolvedValueOnce({ rows: [row] });
    mockClientQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE stub

    const metrics = { winRate: 0.35, totalTrades: 25, totalPnlPct: -5.0 };

    const result = await runEvolutionEngine(noopPool, 'p-target', '2024-11-15', metrics);

    expect(result.proposedValue).toBeCloseTo(0.70, 8);
    expect(result.proposedValue!).toBeGreaterThan(0.65);
  });

  it('clamps proposed value to 0.90 maximum when current min_probability + 0.05 would exceed 0.90', async () => {
    const row = makePersonalityRow({ params: { min_probability: 0.87 } });
    mockClientQuery.mockResolvedValueOnce({ rows: [row] });
    mockClientQuery.mockResolvedValueOnce({ rows: [] });

    const metrics = { winRate: 0.3, totalTrades: 25, totalPnlPct: -3.0 };

    const result = await runEvolutionEngine(noopPool, 'p-target', '2024-11-15', metrics);

    // 0.87 + 0.05 = 0.92 → clamped to 0.90
    expect(result.proposedValue).toBeCloseTo(0.90, 8);
  });
});

// ---------------------------------------------------------------------------
// Rule 2: winRate > 0.7 → lower min_probability (-0.03)
// ---------------------------------------------------------------------------

describe('runEvolutionEngine — Rule 2: lower threshold when winRate > 0.7', () => {
  it('proposes a min_probability that is 0.03 lower than the current value', async () => {
    // current min_probability = 0.65, delta = -0.03 → proposed = 0.62
    const row = makePersonalityRow({ params: { min_probability: 0.65 } });
    mockClientQuery.mockResolvedValueOnce({ rows: [row] });
    mockClientQuery.mockResolvedValueOnce({ rows: [] });

    const metrics = { winRate: 0.75, totalTrades: 25, totalPnlPct: 15.0 };

    const result = await runEvolutionEngine(noopPool, 'p-target', '2024-11-15', metrics);

    expect(result.proposedValue).toBeCloseTo(0.62, 8);
    expect(result.proposedValue!).toBeLessThan(0.65);
  });

  it('clamps proposed value to 0.30 minimum when current min_probability - 0.03 would go below 0.30', async () => {
    const row = makePersonalityRow({ params: { min_probability: 0.31 } });
    mockClientQuery.mockResolvedValueOnce({ rows: [row] });
    mockClientQuery.mockResolvedValueOnce({ rows: [] });

    const metrics = { winRate: 0.8, totalTrades: 25, totalPnlPct: 20.0 };

    const result = await runEvolutionEngine(noopPool, 'p-target', '2024-11-15', metrics);

    // 0.31 - 0.03 = 0.28 → clamped to 0.30
    expect(result.proposedValue).toBeCloseTo(0.30, 8);
  });
});

// ---------------------------------------------------------------------------
// Integrity cap: proposed spread > 0.08 → cap to exactly 0.08
// ---------------------------------------------------------------------------

describe('runEvolutionEngine — integrity cap', () => {
  it('caps a raise such that the spread between target and sibling stays at exactly 0.08', async () => {
    // Scenario: target = 0.65 (winRate < 0.4 → raise by 0.05 → proposed = 0.70)
    // Sibling = 0.63. After proposed raise: max=0.70, min=0.63 → spread=0.07 ≤ 0.08 → no cap needed here.
    //
    // To trigger the cap:
    //   sibling = 0.62, target = 0.65, proposed = 0.70
    //   spread = 0.70 - 0.62 = 0.08 → exactly at limit → no cap
    //
    // Let's use sibling = 0.60, target = 0.65, proposed = 0.70
    //   spread = 0.70 - 0.60 = 0.10 > 0.08 → cap fires
    //   capped = minOtherProb + 0.08 = 0.60 + 0.08 = 0.68
    const targetRow = makePersonalityRow({
      id: 'p-target',
      params: { min_probability: 0.65 },
    });
    const siblingRow = {
      id: 'p-sibling',
      name: 'Adjuster',
      is_frozen: false,
      entry_type: 'momentum_exhaustion',
      is_active: true,
      params: { min_probability: 0.60 },
      last_evolved_at: null,
    };

    // SELECT FOR UPDATE returns both rows; target is identified by id = 'p-target'
    mockClientQuery.mockResolvedValueOnce({ rows: [targetRow, siblingRow] });
    mockClientQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE stub

    const metrics = { winRate: 0.3, totalTrades: 25, totalPnlPct: -3.0 };

    const result = await runEvolutionEngine(noopPool, 'p-target', '2024-11-15', metrics);

    // The cap should clamp the proposed value to 0.60 + 0.08 = 0.68 (not 0.70)
    expect(result.proposedValue).toBeCloseTo(0.68, 8);
    // Verify the spread constraint: proposed - sibling = 0.68 - 0.60 = 0.08
    expect(result.proposedValue! - 0.60).toBeCloseTo(0.08, 8);
  });

  it('caps a lower such that the spread between target and sibling stays at exactly 0.08', async () => {
    // Scenario: winRate > 0.7 → lower by 0.03
    // sibling = 0.72, target = 0.65 → proposed = 0.62
    // spread after: max=0.72, min=0.62 → 0.10 > 0.08 → cap fires
    // capped = maxOtherProb - 0.08 = 0.72 - 0.08 = 0.64
    const targetRow = makePersonalityRow({
      id: 'p-target',
      params: { min_probability: 0.65 },
    });
    const siblingRow = {
      id: 'p-sibling',
      name: 'Reducer',
      is_frozen: false,
      entry_type: 'momentum_exhaustion',
      is_active: true,
      params: { min_probability: 0.72 },
      last_evolved_at: null,
    };

    mockClientQuery.mockResolvedValueOnce({ rows: [targetRow, siblingRow] });
    mockClientQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE stub

    const metrics = { winRate: 0.8, totalTrades: 25, totalPnlPct: 20.0 };

    const result = await runEvolutionEngine(noopPool, 'p-target', '2024-11-15', metrics);

    // capped to 0.72 - 0.08 = 0.64 (not the uncapped 0.62)
    expect(result.proposedValue).toBeCloseTo(0.64, 8);
    // Verify the spread: sibling - proposed = 0.72 - 0.64 = 0.08
    expect(0.72 - result.proposedValue!).toBeCloseTo(0.08, 8);
  });
});

// ---------------------------------------------------------------------------
// Approval mode (EVOLUTION_REQUIRE_APPROVAL = 'true' or unset)
// ---------------------------------------------------------------------------

describe('runEvolutionEngine — approval mode', () => {
  it('returns action="proposed" when EVOLUTION_REQUIRE_APPROVAL is unset (default)', async () => {
    // Default: requireApproval = true → action = 'proposed'
    delete process.env.EVOLUTION_REQUIRE_APPROVAL;

    const row = makePersonalityRow({ params: { min_probability: 0.65 } });
    mockClientQuery.mockResolvedValueOnce({ rows: [row] });
    mockClientQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE retrospection_results

    const metrics = { winRate: 0.3, totalTrades: 25, totalPnlPct: -3.0 };

    const result = await runEvolutionEngine(noopPool, 'p-target', '2024-11-15', metrics);

    expect(result.action).toBe('proposed');
    expect(result.proposedValue).toBeDefined();
  });

  it('returns action="proposed" when EVOLUTION_REQUIRE_APPROVAL = "true"', async () => {
    process.env.EVOLUTION_REQUIRE_APPROVAL = 'true';

    const row = makePersonalityRow({ params: { min_probability: 0.65 } });
    mockClientQuery.mockResolvedValueOnce({ rows: [row] });
    mockClientQuery.mockResolvedValueOnce({ rows: [] });

    const metrics = { winRate: 0.3, totalTrades: 25, totalPnlPct: -3.0 };

    const result = await runEvolutionEngine(noopPool, 'p-target', '2024-11-15', metrics);

    expect(result.action).toBe('proposed');
  });
});

// ---------------------------------------------------------------------------
// Autonomous mode (EVOLUTION_REQUIRE_APPROVAL = 'false')
// ---------------------------------------------------------------------------

describe('runEvolutionEngine — autonomous mode', () => {
  it('returns action="applied" when EVOLUTION_REQUIRE_APPROVAL = "false"', async () => {
    process.env.EVOLUTION_REQUIRE_APPROVAL = 'false';

    const row = makePersonalityRow({ params: { min_probability: 0.65 } });
    // SELECT FOR UPDATE
    mockClientQuery.mockResolvedValueOnce({ rows: [row] });
    // UPDATE personality_configs
    mockClientQuery.mockResolvedValueOnce({ rows: [] });
    // INSERT personality_audit_log
    mockClientQuery.mockResolvedValueOnce({ rows: [] });

    const metrics = { winRate: 0.3, totalTrades: 25, totalPnlPct: -3.0 };

    const result = await runEvolutionEngine(noopPool, 'p-target', '2024-11-15', metrics);

    expect(result.action).toBe('applied');
    expect(result.proposedValue).toBeDefined();
  });

  it('fires the personality_configs UPDATE query in autonomous mode', async () => {
    process.env.EVOLUTION_REQUIRE_APPROVAL = 'false';

    const row = makePersonalityRow({ params: { min_probability: 0.65 } });
    mockClientQuery.mockResolvedValueOnce({ rows: [row] });
    mockClientQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE personality_configs
    mockClientQuery.mockResolvedValueOnce({ rows: [] }); // INSERT audit_log

    const metrics = { winRate: 0.3, totalTrades: 25, totalPnlPct: -3.0 };

    await runEvolutionEngine(noopPool, 'p-target', '2024-11-15', metrics);

    // Autonomous mode issues: SELECT FOR UPDATE, UPDATE personality_configs, INSERT audit_log = 3 queries
    expect(mockClientQuery).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Non-finite min_probability in params (skipped, not thrown)
// ---------------------------------------------------------------------------

describe('runEvolutionEngine — non-finite min_probability in params', () => {
  it('returns action="skipped" when params.min_probability is the string "NaN" (coerced to NaN by Number())', async () => {
    // When JSONB params stores the literal string 'NaN' (a data-quality issue),
    // Number('NaN') produces JavaScript NaN, which is not finite → skip.
    // Note: Number(null) === 0 (finite), so null params are NOT skipped —
    // they are treated as min_probability=0.0 and clamped to 0.30 by the bounds.
    const row = makePersonalityRow({ params: { min_probability: 'NaN' } });
    mockClientQuery.mockResolvedValueOnce({ rows: [row] });

    const metrics = { winRate: 0.3, totalTrades: 25, totalPnlPct: -3.0 };

    const result = await runEvolutionEngine(noopPool, 'p-target', '2024-11-15', metrics);

    expect(result).toEqual({ action: 'skipped', reason: 'min_probability_not_finite' });
  });

  it('returns action="skipped" when params.min_probability is undefined (missing key)', async () => {
    // When the key is absent entirely, Number(undefined) === NaN → not finite → skip.
    const row = makePersonalityRow({ params: {} }); // min_probability absent → undefined
    mockClientQuery.mockResolvedValueOnce({ rows: [row] });

    const metrics = { winRate: 0.3, totalTrades: 25, totalPnlPct: -3.0 };

    const result = await runEvolutionEngine(noopPool, 'p-target', '2024-11-15', metrics);

    expect(result).toEqual({ action: 'skipped', reason: 'min_probability_not_finite' });
  });
});

// ---------------------------------------------------------------------------
// Personality not found in comparison group
// ---------------------------------------------------------------------------

describe('runEvolutionEngine — personality not in momentum_exhaustion group', () => {
  it('throws when the personality ID is not in the SELECT FOR UPDATE result', async () => {
    // The SELECT returns rows for other personalities but not the target.
    const otherRow = {
      id: 'p-other',
      name: 'Adjuster',
      is_frozen: false,
      entry_type: 'momentum_exhaustion',
      is_active: true,
      params: { min_probability: 0.65 },
      last_evolved_at: null,
    };
    mockClientQuery.mockResolvedValueOnce({ rows: [otherRow] });

    const metrics = { winRate: 0.3, totalTrades: 25, totalPnlPct: -3.0 };

    await expect(
      runEvolutionEngine(noopPool, 'p-target', '2024-11-15', metrics),
    ).rejects.toThrow('p-target');
  });
});
