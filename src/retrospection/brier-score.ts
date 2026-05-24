/**
 * Brier score calibration for signal-driven paper trades.
 *
 * The Brier score measures how well a probability forecast is calibrated:
 *   BS = mean((probability - outcome)^2)
 *
 * Range: [0.0, 1.0] where 0.0 = perfect calibration, 1.0 = worst possible.
 * A Brier score near 0.25 is equivalent to random guessing (probability 0.5
 * on every trade). Scores below 0.25 indicate the signal has predictive power.
 *
 * Only applicable to momentum_exhaustion personalities — fixed_time entries
 * have no signal_id so there is nothing to calibrate.
 */

import type { Pool } from 'pg';

/**
 * Row type returned by the entry_type lookup query.
 * personality_configs.entry_type is a TEXT column — pg returns it as string.
 */
interface EntryTypeRow {
  entry_type: string;
}

/**
 * Row type returned by the signal-linked trade query.
 *
 * Both columns are NUMERIC in the database. Because the pg client is
 * configured with pg.types.setTypeParser(1700, val => val), NUMERIC columns
 * arrive as raw strings — NOT as JS numbers. Callers must call Number() or
 * parseFloat() before arithmetic. Typing them as string here is accurate.
 */
interface TradeSignalRow {
  adjusted_probability: string;
  pnl_abs: string;
}

/**
 * Computes the Brier score for a single personality's signal-driven trades on
 * a given trade date.
 *
 * @param pool         - Injected pg Pool (not the module-level singleton) so
 *                       callers can pass a test pool or a transactional client
 *                       without side effects on shared state.
 * @param personalityId - UUID of the personality_config row to score.
 * @param tradeDateISO  - ISO 8601 date string in "YYYY-MM-DD" format (UTC).
 *                        The function builds the time-range bounds internally.
 *
 * @returns The Brier score in [0.0, 1.0], or null when:
 *   - The personality uses fixed_time entry (signal calibration is N/A)
 *   - No closed, signal-linked trades with valid probability exist for the day
 */
export async function computeBrierScore(
  pool: Pool,
  personalityId: string,
  tradeDateISO: string,
): Promise<number | null> {
  // --- Step 1: check entry_type -----------------------------------------
  // Brier score is only meaningful for momentum_exhaustion personalities.
  // fixed_time personalities enter at a clock-based time with no associated
  // signal, so adjusted_probability would be undefined for their trades.
  // We bail out early rather than returning NaN or a misleading 0.
  const entryTypeResult = await pool.query<EntryTypeRow>(
    'SELECT entry_type FROM personality_configs WHERE id = $1',
    [personalityId],
  );

  if (entryTypeResult.rows.length === 0) {
    // Personality does not exist — nothing to compute.
    return null;
  }

  // rows[0] is guaranteed non-undefined because we checked length === 0 above.
  // TypeScript strict mode does not narrow array indexing automatically, so
  // we use the non-null assertion here rather than a redundant null check.
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const { entry_type } = entryTypeResult.rows[0]!;

  if (entry_type !== 'momentum_exhaustion') {
    // Non-signal personality: Brier score is not applicable.
    return null;
  }

  // --- Step 2: build time-range bounds for the hypertable filter ----------
  // straddle_signals is a TimescaleDB hypertable partitioned on `time`.
  // TimescaleDB can prune partitions (chunks) only when the WHERE clause
  // contains a sargable (index-friendly) inequality on the partition column.
  // Wrapping `time` in a function call (e.g. DATE(time)) defeats chunk
  // exclusion and causes a full hypertable scan across all historical data.
  //
  // We construct explicit UTC midnight bounds:
  //   lower: 2024-01-15T00:00:00.000Z  (inclusive)
  //   upper: 2024-01-16T00:00:00.000Z  (exclusive)
  //
  // This gives the planner two sargable range predicates it can satisfy with
  // a single chunk lookup covering only that trading day's data.
  const dayStart = `${tradeDateISO}T00:00:00.000Z`;
  // Next-day midnight: add one day to the ISO date string, then suffix with UTC time.
  // Parse the ISO date parts manually so we can compute next-day midnight in UTC.
  // String.split() with .map(Number) produces (number | undefined)[] under
  // strictNullChecks when destructured, because TypeScript cannot prove the
  // split will yield exactly 3 parts. We use explicit index access with fallback
  // to 1 for month/day (worst case: next-day computation is off by at most one
  // day on a malformed input, which is preferable to throwing at runtime).
  const parts = tradeDateISO.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1] ?? '1'); // 1-based month
  const day = Number(parts[2] ?? '1');
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
  const dayEnd = nextDate.toISOString(); // always "YYYY-MM-DDT00:00:00.000Z"

  // --- Step 3: fetch signal-linked closed trades for the day --------------
  // We join paper_trades to straddle_signals on signal_id so we can retrieve
  // the adjusted_probability that was used at entry time.
  //
  // Filter conditions:
  //   pt.personality_id = $1   — scope to this personality only
  //   pt.status = 'closed'     — only closed trades have a final pnl_abs
  //   pt.pnl_abs IS NOT NULL   — guard: open/aborted trades may have NULL pnl
  //   ss.time >= $2            — sargable lower bound on the hypertable column
  //   ss.time < $3             — sargable upper bound on the hypertable column
  //
  // We intentionally filter on ss.time (the signal's creation time) rather
  // than pt.entry_time. The task contract specifies this, and it is correct:
  // the signal's timestamp is the hypertable partition key and is what chunk
  // exclusion acts on. pt.entry_time is a regular column on a non-hypertable
  // and would not benefit from TimescaleDB chunk pruning.
  const tradesResult = await pool.query<TradeSignalRow>(
    `SELECT ss.adjusted_probability, pt.pnl_abs
     FROM paper_trades pt
     INNER JOIN straddle_signals ss ON pt.signal_id = ss.id
     WHERE pt.personality_id = $1
       AND pt.status = 'closed'
       AND pt.pnl_abs IS NOT NULL
       AND ss.time >= $2
       AND ss.time < $3`,
    [personalityId, dayStart, dayEnd],
  );

  const rows = tradesResult.rows;

  // No trades → return null rather than dividing by zero.
  // Returning 0.0 would be misleading (it means perfect calibration).
  if (rows.length === 0) {
    return null;
  }

  // --- Step 4: compute the Brier score ------------------------------------
  let sumSquaredErrors = 0;
  let validCount = 0;

  for (const row of rows) {
    const probability = Number(row.adjusted_probability);

    // Guard: reject rows where the probability column contains a non-finite
    // value (NaN, Infinity, -Infinity). This can happen if the column stored
    // a sentinel like 'NaN' or if the string is malformed.
    // We log and skip rather than throwing, because a single bad row should
    // not abort the entire day's retrospection calculation.
    if (!Number.isFinite(probability)) {
      console.warn(
        `[brier-score] Skipping row with non-finite adjusted_probability: ` +
          `${JSON.stringify(row.adjusted_probability)} ` +
          `(personality=${personalityId}, date=${tradeDateISO})`,
      );
      continue;
    }

    // Outcome is 1 (win) when pnl_abs > 0, and 0 (loss) otherwise.
    //
    // IMPORTANT: we use `Number(row.pnl_abs) > 0`, NOT `Boolean(row.pnl_abs)`.
    //
    // Because pg returns NUMERIC as a string, Boolean('-5.00') is TRUE (any
    // non-empty string is truthy in JavaScript). A losing trade with pnl_abs
    // of '-5.00' would be misclassified as a win if we used Boolean().
    //
    // Using Number() then comparing to 0 correctly handles:
    //   '100.00'  → Number = 100.00  → outcome = 1 (win)
    //   '-5.00'   → Number = -5.00   → outcome = 0 (loss)
    //   '0.00'    → Number = 0.0     → outcome = 0 (breakeven = not a win)
    const outcome = Number(row.pnl_abs) > 0 ? 1 : 0;

    sumSquaredErrors += (probability - outcome) ** 2;
    validCount += 1;
  }

  // All rows had non-finite probabilities — treat same as zero valid rows.
  if (validCount === 0) {
    return null;
  }

  // Mean squared error = Brier score.
  // Result is mathematically bounded to [0.0, 1.0] because:
  //   probability ∈ [0, 1] (assumed — signal engine enforces this)
  //   outcome ∈ {0, 1}
  //   (probability - outcome)^2 ∈ [0, 1] for each row
  //   mean of values in [0, 1] is also in [0, 1]
  const brierScore = sumSquaredErrors / validCount;

  return brierScore;
}
