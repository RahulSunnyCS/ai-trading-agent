/**
 * daily-metrics.ts — Per-personality daily P&L metrics and Beat-Clockwork delta
 *
 * Design decisions:
 *   - Pool is injected as a parameter (not imported from src/db/client.ts) so
 *     callers can substitute a test pool without module-level mocking.
 *   - All pg NUMERIC columns (pnl_pct, pnl_abs) are returned as strings by the
 *     pg client (OID 1700 parser set in src/db/client.ts). We convert each value
 *     with Number() and guard with Number.isFinite() before any arithmetic.
 *     Non-finite rows are logged and excluded rather than causing NaN to
 *     propagate silently through aggregates.
 *   - Time range boundaries are computed from tradeDateISO with pure Date
 *     arithmetic (no external libraries) to keep this module dependency-free.
 *     Start-of-day = tradeDateISO + 'T00:00:00.000Z' (midnight UTC).
 *     End-of-day = start + 86400000ms (exact 24-hour window, leap-second-free
 *     in UTC). Using UTC boundaries is intentional: the caller supplies an IST
 *     date but the DB stores entry_time as TIMESTAMPTZ (which pg returns as
 *     UTC-normalised). The EOD batch job that calls this function is responsible
 *     for deciding which date string to pass; this module only enforces that
 *     the window is a full UTC day.
 *   - The Beat-Clockwork query joins on personality_configs.is_frozen = TRUE to
 *     find Clockwork rows. If more than one frozen personality ever exists in the
 *     future (unlikely per the schema comment, but possible), their trades are
 *     summed together — this is a deliberate choice: the "Clockwork benchmark"
 *     is the aggregate of all frozen reference strategies, not a single named row.
 *   - market_regime is passed as a parameter to computeBeatClockworkDelta to
 *     ensure the Clockwork comparison is regime-filtered (comparing, e.g., a
 *     RANGING day against Clockwork's TRENDING_STRONG day would be meaningless).
 *   - Returns NULL (not 0) when Clockwork has zero trades on the given day+regime:
 *     a delta of 0 would falsely imply Clockwork also earned 0%, hiding the
 *     absence of data.
 *
 * No default exports — named exports only (project convention).
 */

import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Aggregated daily performance metrics for one personality on one trading day.
 *
 * totalPnlPct is the sum of pnl_pct across all closed trades for the day.
 * It is intentionally a simple sum (not a time-weighted or capital-weighted
 * return) because pnl_pct in the DB represents each trade's return relative
 * to its own notional — a consistent comparison unit across personalities.
 *
 * closedTradeIds preserves the list of contributing trade IDs so callers can
 * trace which trades fed into the aggregates (e.g. for audit, per-trade display,
 * or Brier score computation in later pipeline steps).
 */
export interface DailyMetrics {
  totalTrades: number;
  winningTrades: number;
  totalPnlPct: number;
  winRate: number;
  closedTradeIds: string[];
}

// ---------------------------------------------------------------------------
// computeDailyMetrics
// ---------------------------------------------------------------------------

/**
 * Computes aggregated daily P&L metrics for one personality on one trading day.
 *
 * Queries paper_trades for all closed rows whose entry_time falls within the
 * UTC calendar day matching tradeDateISO. pnl_abs IS NOT NULL is required as
 * a proxy for "the trade has a complete P&L record" — a row can be status=closed
 * but still have null pnl_abs if the exit writer crashed before computing P&L.
 *
 * @param pool         - pg Pool (injected, not a module singleton)
 * @param personalityId - UUID of the personality row in personality_configs
 * @param tradeDateISO  - Date in 'YYYY-MM-DD' format (UTC day boundary)
 */
export async function computeDailyMetrics(
  pool: Pool,
  personalityId: string,
  tradeDateISO: string,
): Promise<DailyMetrics> {
  // Build the UTC day window from the supplied date string.
  // We construct the ISO timestamp strings directly rather than using Date
  // arithmetic on a parsed object — this avoids any DST ambiguity since the
  // string is already in UTC (the 'Z' suffix is explicit).
  const dayStart = `${tradeDateISO}T00:00:00.000Z`;

  // Add exactly 86400000ms (one UTC day) to compute the exclusive upper bound.
  // Using epoch arithmetic avoids locale/DST issues entirely.
  const dayStartMs = new Date(dayStart).getTime();
  const dayEndMs = dayStartMs + 86_400_000;
  const dayEnd = new Date(dayEndMs).toISOString();

  // Parameterised query — $1 = personalityId, $2 = start (inclusive), $3 = end (exclusive).
  // The sargable time filter (>= start AND < end) allows the TimescaleDB chunk
  // exclusion to skip irrelevant time partitions. A DATE(...) cast expression
  // on entry_time would prevent index use on the hypertable.
  const result = await pool.query<{
    id: string;
    pnl_pct: string | null; // NUMERIC → string (pg custom parser)
    pnl_abs: string | null; // NUMERIC → string
  }>(
    `SELECT id, pnl_pct, pnl_abs
       FROM paper_trades
      WHERE personality_id = $1
        AND status = 'closed'
        AND pnl_abs IS NOT NULL
        AND entry_time >= $2
        AND entry_time < $3`,
    [personalityId, dayStart, dayEnd],
  );

  const rows = result.rows;

  // Zero-trade fast path: return the empty-state struct immediately.
  // This also prevents any division-by-zero in winRate further down.
  if (rows.length === 0) {
    return {
      totalTrades: 0,
      winningTrades: 0,
      totalPnlPct: 0,
      winRate: 0,
      closedTradeIds: [],
    };
  }

  let winningTrades = 0;
  let validTradeCount = 0;
  let totalPnlPct = 0;
  const closedTradeIds: string[] = [];

  for (const row of rows) {
    // pg returns NUMERIC columns as strings when the OID-1700 parser is active.
    // Number() converts a numeric string to a JS float. Non-numeric strings
    // (e.g. '' from a null coercion bug) become NaN, caught by isFinite below.
    const pnlPct = Number(row.pnl_pct);

    if (!Number.isFinite(pnlPct)) {
      // A non-finite pnl_pct means the row has corrupt or missing data.
      // Log the offending trade ID and exclude it from aggregates rather than
      // allowing NaN to silently infect totalPnlPct.
      console.warn(
        `[daily-metrics] Non-finite pnl_pct for trade ${row.id} ` +
          `(raw value: ${JSON.stringify(row.pnl_pct)}) — excluded from metrics`,
      );
      // The trade ID is still included in closedTradeIds so callers can audit
      // exactly which trades were processed (including the excluded ones).
      closedTradeIds.push(row.id);
      continue;
    }

    closedTradeIds.push(row.id);
    totalPnlPct += pnlPct;
    validTradeCount += 1;

    // A winning trade is one where pnl_pct > 0 (strictly positive).
    // Breakeven trades (pnl_pct === 0) are not counted as wins.
    if (pnlPct > 0) {
      winningTrades += 1;
    }
  }

  // totalTrades is the raw DB row count (includes non-finite/excluded rows)
  // so callers can detect how many rows were excluded by comparing
  // totalTrades to validTradeCount.
  const totalTrades = rows.length;

  // Divide by validTradeCount (finite-only) so excluded rows don't deflate winRate.
  // validTradeCount > 0 is guaranteed: the fast path handles rows.length === 0,
  // and at least one finite row must exist to reach here (non-finite rows continue).
  const winRate = validTradeCount > 0 ? winningTrades / validTradeCount : 0;

  return {
    totalTrades,
    winningTrades,
    totalPnlPct,
    winRate,
    closedTradeIds,
  };
}

// ---------------------------------------------------------------------------
// computeBeatClockworkDelta
// ---------------------------------------------------------------------------

/**
 * Computes the difference between a personality's daily total P&L% and the
 * Clockwork benchmark's daily total P&L% for the same trading day and market
 * regime.
 *
 * Returns NULL (not 0) when:
 *   - personalityTotalPnlPct is not a finite number (guard at function entry)
 *   - Clockwork had zero qualifying closed trades on the given day+regime
 *     (a delta of 0 would be misleading — it would imply Clockwork earned 0%,
 *     when the real meaning is "no data")
 *
 * When Clockwork has trades, returns:
 *   personalityTotalPnlPct - clockworkTotalPnlPct
 * Positive = personality beat Clockwork; negative = Clockwork won.
 *
 * Regime filtering: the comparison is restricted to the same market_regime so
 * that RANGING-day personality performance is not diluted by Clockwork's
 * TRENDING_STRONG trades (or vice versa).
 *
 * @param pool                    - pg Pool (injected)
 * @param personalityTotalPnlPct  - Total P&L% from computeDailyMetrics (pre-computed)
 * @param tradeDateISO            - Date in 'YYYY-MM-DD' format (UTC day boundary)
 * @param marketRegime            - Regime tag: RANGING | TRENDING_STRONG | VOLATILE_REVERTING | EVENT_DAY
 */
export async function computeBeatClockworkDelta(
  pool: Pool,
  personalityTotalPnlPct: number,
  tradeDateISO: string,
  marketRegime: string,
): Promise<number | null> {
  // Guard at function entry: if the caller passes NaN or Infinity (e.g. because
  // their computeDailyMetrics call produced a bad value), return null rather
  // than storing a corrupt delta in retrospection_results.
  if (!Number.isFinite(personalityTotalPnlPct)) {
    return null;
  }

  // Reuse the same UTC day window construction as computeDailyMetrics.
  const dayStart = `${tradeDateISO}T00:00:00.000Z`;
  const dayStartMs = new Date(dayStart).getTime();
  const dayEnd = new Date(dayStartMs + 86_400_000).toISOString();

  // Join paper_trades with personality_configs on is_frozen = TRUE to find
  // Clockwork trades. COALESCE(SUM(...), 0) returns 0 when there are no rows;
  // we distinguish "zero rows" from "rows with zero P&L" via the COUNT column.
  // pnl_pct::float8 casts the NUMERIC column to double precision inside
  // PostgreSQL before SUM, which avoids pg returning it as a NUMERIC string
  // (the aggregated SUM of float8 is returned as float8, not NUMERIC).
  const result = await pool.query<{
    count: string; // COUNT(*) → bigint → pg returns as string
    total: number; // SUM(pnl_pct::float8) → float8 → pg returns as number
  }>(
    `SELECT
        COUNT(*) AS count,
        COALESCE(SUM(pt.pnl_pct::float8), 0) AS total
       FROM paper_trades pt
       JOIN personality_configs pc ON pt.personality_id = pc.id
      WHERE pc.is_frozen = TRUE
        AND pt.status = 'closed'
        AND pt.pnl_abs IS NOT NULL
        AND pt.market_regime = $1
        AND pt.entry_time >= $2
        AND pt.entry_time < $3`,
    [marketRegime, dayStart, dayEnd],
  );

  const row = result.rows[0];

  // COUNT(*) always returns exactly one row (even when there are no matching
  // trades — it returns count='0'). parseInt is safe here.
  const clockworkCount = Number.parseInt(row?.count ?? '0', 10);

  // No Clockwork trades for this day+regime: return null, not 0.
  if (clockworkCount === 0) {
    return null;
  }

  // The SUM(pnl_pct::float8) column is already a JS number (float8 bypasses
  // the NUMERIC string parser). Guard it anyway in case pg behaves unexpectedly.
  const clockworkTotal = Number(row?.total);
  if (!Number.isFinite(clockworkTotal)) {
    console.warn(
      `[daily-metrics] Non-finite Clockwork total P&L for date=${tradeDateISO} ` +
        `regime=${marketRegime} (raw total: ${JSON.stringify(row?.total)}) — returning null`,
    );
    return null;
  }

  // Positive delta = personality beat Clockwork; negative = Clockwork won.
  return personalityTotalPnlPct - clockworkTotal;
}
