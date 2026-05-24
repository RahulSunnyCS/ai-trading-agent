/**
 * Unit tests for brier-score.ts
 *
 * Key invariant documented here:
 *   pnl_abs arrives as a STRING from pg (due to NUMERIC type parser override).
 *   Outcome determination uses `Number(row.pnl_abs) > 0`, NOT `Boolean(row.pnl_abs)`.
 *   `Boolean('-5.00')` would be TRUE (any non-empty string is truthy), which
 *   would misclassify a losing trade as a win. The implementation deliberately
 *   avoids this trap. Test case 10 documents and verifies this behaviour.
 *
 * Formula: Brier score = mean((probability - outcome)^2)
 *   outcome = 1 when pnl_abs > 0, else 0
 */

import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { computeBrierScore } from '../brier-score.js';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Build a mock Pool that sequences responses to successive query() calls.
 * The first call returns the first response, the second call the second, etc.
 */
function makeSequencedPool(responses: Record<string, unknown>[][]): Pool {
  const queryMock = vi.fn();
  for (const rows of responses) {
    queryMock.mockResolvedValueOnce({ rows });
  }
  return { query: queryMock } as unknown as Pool;
}

/** Convenience: a pool whose first query returns entry_type rows, second returns trade rows. */
function makePool(entryType: string, tradeRows: Record<string, unknown>[]): Pool {
  return makeSequencedPool([[{ entry_type: entryType }], tradeRows]);
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('computeBrierScore', () => {
  it('returns null immediately when personality entry_type is "fixed_time" without querying trades', async () => {
    // fixed_time personalities have no signal_id so Brier score is not applicable.
    // Only the entry_type lookup query should fire — the trade query must NOT run.
    const queryMock = vi.fn().mockResolvedValue({ rows: [{ entry_type: 'fixed_time' }] });
    const pool = { query: queryMock } as unknown as Pool;

    const result = await computeBrierScore(pool, 'p-1', '2024-11-15');

    expect(result).toBeNull();
    // Only one query was issued — the entry_type check. No trade join query.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('returns null when the personality does not exist (entry_type query returns empty rows)', async () => {
    const pool = makeSequencedPool([[], []]);

    const result = await computeBrierScore(pool, 'nonexistent-uuid', '2024-11-15');

    expect(result).toBeNull();
  });

  it('returns null when there are no signal-linked closed trades for the day', async () => {
    const pool = makePool('momentum_exhaustion', []);

    const result = await computeBrierScore(pool, 'p-1', '2024-11-15');

    expect(result).toBeNull();
  });

  it('assigns outcome = 1 to a winning trade (pnl_abs = "5.00") and outcome = 0 to a losing trade (pnl_abs = "-3.00")', async () => {
    // We verify that outcome assignment is correct before testing the formula.
    // Win: probability=0.8, outcome=1 → squared error = (0.8-1)^2 = 0.04
    // Loss: probability=0.6, outcome=0 → squared error = (0.6-0)^2 = 0.36
    // Brier = mean(0.04, 0.36) = 0.20
    const tradeRows = [
      { adjusted_probability: '0.8', pnl_abs: '5.00' },
      { adjusted_probability: '0.6', pnl_abs: '-3.00' },
    ];
    const pool = makePool('momentum_exhaustion', tradeRows);

    const result = await computeBrierScore(pool, 'p-1', '2024-11-15');

    expect(result).toBeCloseTo(0.2, 10);
  });

  it('CRITICAL TRAP: pnl_abs = "-5.00" (negative string) is outcome = 0, not 1', async () => {
    // Boolean('-5.00') === true because any non-empty string is truthy.
    // The implementation must use Number('-5.00') > 0 which is false → outcome = 0.
    // If this test fails it means the implementation used Boolean() instead of Number()
    // and losing trades would be counted as wins.
    //
    // Single losing trade: probability=0.9, outcome=0
    // Brier = (0.9 - 0)^2 = 0.81
    const tradeRows = [{ adjusted_probability: '0.9', pnl_abs: '-5.00' }];
    const pool = makePool('momentum_exhaustion', tradeRows);

    const result = await computeBrierScore(pool, 'p-1', '2024-11-15');

    // 0.81 proves outcome was 0 (loss). If Boolean() was used, outcome would be 1
    // and the score would be (0.9-1)^2 = 0.01.
    expect(result).toBeCloseTo(0.81, 10);
  });

  it('treats breakeven trade (pnl_abs = "0.00") as outcome = 0 (not a win)', async () => {
    // Number('0.00') > 0 is false → outcome = 0
    // probability=0.7, outcome=0 → Brier = (0.7-0)^2 = 0.49
    const tradeRows = [{ adjusted_probability: '0.7', pnl_abs: '0.00' }];
    const pool = makePool('momentum_exhaustion', tradeRows);

    const result = await computeBrierScore(pool, 'p-1', '2024-11-15');

    expect(result).toBeCloseTo(0.49, 10);
  });

  it('computes the correct Brier score from two trades with known probabilities and outcomes', async () => {
    // Trade 1: probability=0.65, pnl_abs='10.00' (win, outcome=1)
    //   squared error = (0.65 - 1)^2 = (-0.35)^2 = 0.1225
    // Trade 2: probability=0.40, pnl_abs='-2.00' (loss, outcome=0)
    //   squared error = (0.40 - 0)^2 = 0.16
    // Brier = mean(0.1225, 0.16) = 0.14125
    const tradeRows = [
      { adjusted_probability: '0.65', pnl_abs: '10.00' },
      { adjusted_probability: '0.40', pnl_abs: '-2.00' },
    ];
    const pool = makePool('momentum_exhaustion', tradeRows);

    const result = await computeBrierScore(pool, 'p-1', '2024-11-15');

    expect(result).toBeCloseTo(0.14125, 8);
  });

  it('skips rows with non-finite adjusted_probability and returns null if no valid rows remain', async () => {
    // Both rows have corrupt probability — all are skipped, validCount stays 0.
    const tradeRows = [
      { adjusted_probability: 'NaN', pnl_abs: '5.00' },
      { adjusted_probability: 'Infinity', pnl_abs: '-2.00' },
    ];
    const pool = makePool('momentum_exhaustion', tradeRows);

    const result = await computeBrierScore(pool, 'p-1', '2024-11-15');

    expect(result).toBeNull();
  });

  it('computes correct score when only some rows have non-finite probability (valid rows are still used)', async () => {
    // One bad probability row is skipped; the valid row drives the computation.
    // probability=0.5, pnl_abs='-1.00' → outcome=0 → squared error = 0.25
    // Brier = 0.25 / 1 = 0.25
    const tradeRows = [
      { adjusted_probability: 'NaN', pnl_abs: '5.00' }, // skipped
      { adjusted_probability: '0.5', pnl_abs: '-1.00' }, // valid
    ];
    const pool = makePool('momentum_exhaustion', tradeRows);

    const result = await computeBrierScore(pool, 'p-1', '2024-11-15');

    expect(result).toBeCloseTo(0.25, 10);
  });
});
