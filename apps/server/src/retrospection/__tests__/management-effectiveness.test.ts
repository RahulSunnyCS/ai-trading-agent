/**
 * Unit tests for management-effectiveness.ts
 *
 * Score formula: weighted average of exit quality scores, weighted by |pnl_pct|.
 *
 * Exit quality scores:
 *   TARGET         → +1.0
 *   TSL            → +0.5
 *   EOD            → +0.0
 *   TIME           → +0.0
 *   MANUAL         → +0.0
 *   DAILY_LOSS_CAP → -0.5
 *   SL             → -1.0
 *   (unknown)      → +0.0 (warn and treat as neutral)
 */

import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { computeManagementEffectiveness } from '../management-effectiveness.js';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makePool(rows: Record<string, unknown>[]): Pool {
  return {
    query: vi.fn().mockResolvedValue({ rows }),
  } as unknown as Pool;
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('computeManagementEffectiveness', () => {
  it('returns null when there are no qualifying closed trades', async () => {
    const pool = makePool([]);

    const result = await computeManagementEffectiveness(pool, 'p-1', '2024-11-15');

    expect(result).toBeNull();
  });

  it('returns null when all trades have pnl_pct = "0.00" (weight sum = 0 avoids division-by-zero)', async () => {
    // Every trade has |pnl_pct| = 0.0, so weightSum stays at 0.
    // The function must return null rather than attempting 0/0 = NaN.
    const rows = [
      { exit_reason: 'TARGET', pnl_pct: '0.00' },
      { exit_reason: 'SL', pnl_pct: '0.00' },
    ];
    const pool = makePool(rows);

    const result = await computeManagementEffectiveness(pool, 'p-1', '2024-11-15');

    expect(result).toBeNull();
  });

  it('computes the correct weighted average for a TARGET trade and an SL trade', async () => {
    // TARGET trade: score = +1.0, pnl_pct = '2.00', weight = 2.0
    //   contribution = 1.0 * 2.0 = 2.0
    // SL trade: score = -1.0, pnl_pct = '-1.00', weight = |-1.00| = 1.0
    //   contribution = -1.0 * 1.0 = -1.0
    // weightedSum = 2.0 + (-1.0) = 1.0
    // weightSum   = 2.0 + 1.0    = 3.0
    // score = 1.0 / 3.0 ≈ 0.3333...
    const rows = [
      { exit_reason: 'TARGET', pnl_pct: '2.00' },
      { exit_reason: 'SL', pnl_pct: '-1.00' },
    ];
    const pool = makePool(rows);

    const result = await computeManagementEffectiveness(pool, 'p-1', '2024-11-15');

    expect(result).not.toBeNull();
    expect(result).toBeCloseTo(1 / 3, 8);
  });

  it('treats an unknown exit reason as 0.0 score and does not throw', async () => {
    // A future exit reason or a data-migration artefact must not blow up the
    // function. The unknown reason gets score=0.0, so it contributes 0 to the
    // weighted numerator but still adds weight to the denominator.
    //
    // 'UNKNOWN_FUTURE' → score=0.0, pnl_pct='3.00', weight=3.0 → contribution=0
    // 'TARGET'          → score=1.0, pnl_pct='1.00', weight=1.0 → contribution=1.0
    // weightedSum = 1.0, weightSum = 4.0, score = 0.25
    const rows = [
      { exit_reason: 'UNKNOWN_FUTURE', pnl_pct: '3.00' },
      { exit_reason: 'TARGET', pnl_pct: '1.00' },
    ];
    const pool = makePool(rows);

    const result = await computeManagementEffectiveness(pool, 'p-1', '2024-11-15');

    expect(result).toBeCloseTo(0.25, 8);
  });

  it('returns +1.0 when every trade exits at TARGET with equal weight', async () => {
    const rows = [
      { exit_reason: 'TARGET', pnl_pct: '2.00' },
      { exit_reason: 'TARGET', pnl_pct: '3.00' },
    ];
    const pool = makePool(rows);

    const result = await computeManagementEffectiveness(pool, 'p-1', '2024-11-15');

    expect(result).toBeCloseTo(1.0, 10);
  });

  it('returns -1.0 when every trade exits at SL with equal weight', async () => {
    const rows = [
      { exit_reason: 'SL', pnl_pct: '-2.00' },
      { exit_reason: 'SL', pnl_pct: '-1.00' },
    ];
    const pool = makePool(rows);

    const result = await computeManagementEffectiveness(pool, 'p-1', '2024-11-15');

    expect(result).toBeCloseTo(-1.0, 10);
  });

  it('returns 0.0 for a single EOD trade (neutral exit reason)', async () => {
    // EOD score = 0.0. Any non-zero |pnl_pct| gives weight > 0, so weightSum > 0,
    // but the numerator is 0. Result = 0.0 (not null).
    const rows = [{ exit_reason: 'EOD', pnl_pct: '1.50' }];
    const pool = makePool(rows);

    const result = await computeManagementEffectiveness(pool, 'p-1', '2024-11-15');

    expect(result).toBeCloseTo(0.0, 10);
  });

  it('computes the correct weighted average with TSL and DAILY_LOSS_CAP trades', async () => {
    // TSL trade:            score=+0.5, pnl_pct='4.00', weight=4.0 → contribution=2.0
    // DAILY_LOSS_CAP trade: score=-0.5, pnl_pct='-2.00', weight=2.0 → contribution=-1.0
    // weightedSum = 1.0, weightSum = 6.0, score = 1/6 ≈ 0.1667
    const rows = [
      { exit_reason: 'TSL', pnl_pct: '4.00' },
      { exit_reason: 'DAILY_LOSS_CAP', pnl_pct: '-2.00' },
    ];
    const pool = makePool(rows);

    const result = await computeManagementEffectiveness(pool, 'p-1', '2024-11-15');

    expect(result).toBeCloseTo(1 / 6, 8);
  });

  it('skips trades with non-finite pnl_pct and still computes a valid score from the rest', async () => {
    // The corrupt row (pnl_pct='NaN') must be excluded. The valid row drives the result.
    // TARGET trade: score=1.0, pnl_pct='2.00', weight=2.0 → score=1.0
    const rows = [
      { exit_reason: 'SL', pnl_pct: 'NaN' }, // corrupt — skip
      { exit_reason: 'TARGET', pnl_pct: '2.00' }, // valid
    ];
    const pool = makePool(rows);

    const result = await computeManagementEffectiveness(pool, 'p-1', '2024-11-15');

    expect(result).toBeCloseTo(1.0, 10);
  });
});
