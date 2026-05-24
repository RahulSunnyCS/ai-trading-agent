/**
 * Management effectiveness score computation.
 *
 * Produces a single number in [-1.0, 1.0] that summarises how well a trading
 * personality's exit management performed on a given day. Higher is better.
 *
 * The score is a weighted average of per-trade exit quality scores, where the
 * weight for each trade is its absolute P&L percentage. Weighting by |pnl_pct|
 * focuses the metric on trades that actually moved the needle — a TARGET exit
 * on a +5% trade counts for more than a TARGET exit on a +0.1% trade.
 *
 * Exit quality scores:
 *   TARGET         → +1.0  (best outcome: hit profit target)
 *   TSL            → +0.5  (good outcome: trailing stop locked in some profit)
 *   EOD            → +0.0  (neutral: held until end of day, no management action)
 *   TIME           → +0.0  (neutral: time-based exit, no management credit/blame)
 *   MANUAL         → +0.0  (neutral: manual exits can be good or bad; no assumption)
 *   DAILY_LOSS_CAP → -0.5  (bad: hit the daily loss cap, partial rescue)
 *   SL             → -1.0  (worst: stopped out at full loss)
 */

import type { Pool } from 'pg';
import type { ExitReason } from '../db/schema.js';

// ---------------------------------------------------------------------------
// Exit reason → quality score mapping
// ---------------------------------------------------------------------------

// These scores encode the domain assumption about how "good" each exit type is
// from a management perspective. Stored in a Map for O(1) lookup and to enable
// exhaustiveness checking at the call site via the unknown-reason guard below.
const EXIT_REASON_SCORES: ReadonlyMap<ExitReason, number> = new Map([
  ['TARGET', 1.0],
  ['TSL', 0.5],
  ['EOD', 0.0],
  ['TIME', 0.0],
  ['MANUAL', 0.0],
  ['DAILY_LOSS_CAP', -0.5],
  ['SL', -1.0],
]);

// ---------------------------------------------------------------------------
// Query row shape (internal — not exported)
// ---------------------------------------------------------------------------

// We only SELECT two columns, so define a minimal row type rather than
// importing the full PaperTrade interface. pg NUMERIC columns come back as
// strings (see src/db/client.ts — pg.types.setTypeParser(1700, val => val)),
// so pnl_pct is typed as string | null matching the wire format.
interface TradeRow {
  exit_reason: string; // TEXT column — pg returns as string regardless of ExitReason union
  pnl_pct: string | null; // NUMERIC — pg returns raw string due to type parser override
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Computes the management effectiveness score for one personality on one day.
 *
 * @param pool        - Injected pg Pool (never imported directly — caller owns lifecycle)
 * @param personalityId - UUID of the personality row in personality_configs
 * @param tradeDateISO  - ISO-8601 date string, e.g. "2024-11-15" (local calendar date)
 * @returns A score in [-1.0, 1.0], or null if there are no qualifying closed trades
 *          or all qualifying trades have pnl_pct = 0.
 */
export async function computeManagementEffectiveness(
  pool: Pool,
  personalityId: string,
  tradeDateISO: string,
): Promise<number | null> {
  // Build sargable UTC range bounds from the calendar date string.
  // entry_time is a TIMESTAMPTZ column — always UTC on the wire — so we compare
  // against explicit UTC midnight boundaries rather than relying on PostgreSQL's
  // AT TIME ZONE conversion, which would depend on the DB server's timezone
  // setting and could silently shift the window on different deployments.
  const startOfDay = `${tradeDateISO}T00:00:00.000Z`;

  // Next-day start is computed in JavaScript to avoid the complexity of
  // PostgreSQL interval arithmetic. We parse the date, add one day, and
  // re-serialise. This is safe for YYYY-MM-DD inputs because Date.UTC always
  // returns a valid UTC timestamp (there is no DST ambiguity in UTC).
  //
  // Strict-mode note: Array destructuring from split() yields (string | undefined)[]
  // in strict TS. We validate the format and cast explicitly so the caller gets a
  // clear error if a malformed date string (e.g. "2024/11/15") is passed instead
  // of silently computing a wrong timestamp.
  const parts = tradeDateISO.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]); // 1-indexed as in ISO-8601
  const day = Number(parts[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new Error(
      `[management-effectiveness] Invalid tradeDateISO format "${tradeDateISO}": expected YYYY-MM-DD`,
    );
  }
  const nextDayDate = new Date(Date.UTC(year, month - 1, day + 1)); // month is 0-indexed in Date.UTC
  const startOfNextDay = nextDayDate.toISOString(); // → "YYYY-MM-DDT00:00:00.000Z"

  // Parameterised query — no string interpolation of user-controlled values.
  // pnl_abs IS NOT NULL ensures we do not include trades where pnl is still
  // being computed (partially closed positions or data errors).
  const rows = await pool.query<TradeRow>(
    `SELECT exit_reason, pnl_pct
       FROM paper_trades
      WHERE personality_id = $1
        AND status = 'closed'
        AND pnl_abs IS NOT NULL
        AND exit_reason IS NOT NULL
        AND entry_time >= $2
        AND entry_time < $3`,
    [personalityId, startOfDay, startOfNextDay],
  );

  const trades = rows.rows;

  // Criterion 5: return null when there are no qualifying closed trades to
  // avoid dividing by zero on the weight sum and to communicate "no data"
  // clearly to the caller (vs. returning 0 which looks like a neutral score).
  if (trades.length === 0) {
    return null;
  }

  let weightedScoreSum = 0;
  let weightSum = 0;

  for (const trade of trades) {
    // Look up the quality score for this exit reason.
    const score = scoreForExitReason(trade.exit_reason);

    // Cast NUMERIC string to JS number. pg returns NUMERIC as a string because
    // of the pg.types.setTypeParser(1700) override in src/db/client.ts.
    // We guard with Number.isFinite to catch NaN (malformed string) and
    // Infinity (overflow — shouldn't happen for pnl_pct but defensive).
    const rawPnlPct = Number(trade.pnl_pct);
    if (!Number.isFinite(rawPnlPct)) {
      // Malformed pnl_pct: skip this trade rather than polluting the score.
      // This can only happen if the DB contains a corrupt value — log it and
      // continue so one bad row doesn't wipe out the whole day's score.
      console.warn(
        `[management-effectiveness] Skipping trade with non-finite pnl_pct: ` +
          `personality=${personalityId} date=${tradeDateISO} ` +
          `exit_reason=${trade.exit_reason} pnl_pct=${trade.pnl_pct}`,
      );
      continue;
    }

    // Weight is the absolute P&L magnitude. Math.abs(0) = 0, which means
    // zero-P&L trades contribute nothing to the weighted sum — they neither
    // help nor hurt the score. This is intentional: a trade that opens and
    // closes at exactly the same straddle value provides no evidence about
    // management quality.
    const weight = Math.abs(rawPnlPct);
    weightedScoreSum += score * weight;
    weightSum += weight;
  }

  // Criterion 6: return null when all qualifying trades have pnl_pct = 0.
  // If weightSum is 0 every trade was flat — the weighted average formula
  // 0/0 is undefined, so we return null to signal "no information".
  if (weightSum === 0) {
    return null;
  }

  // Weighted average: sum(score * |pnl_pct|) / sum(|pnl_pct|)
  // The result is in [-1.0, 1.0] because:
  //   - Each score ∈ [-1.0, 1.0]
  //   - Weights are non-negative (absolute values)
  //   - A non-negative weighted average of values in a bounded range stays
  //     within that range
  return weightedScoreSum / weightSum;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns the quality score for a given exit_reason string.
 *
 * The exit_reason column is TEXT in the DB, so at runtime we receive a plain
 * string. We cast to ExitReason after the Map lookup rather than before so
 * that unrecognised values (data migration artefacts, future enum additions
 * not yet deployed here) fall through to the default path instead of
 * producing a TypeScript type error.
 */
function scoreForExitReason(exitReason: string): number {
  const score = EXIT_REASON_SCORES.get(exitReason as ExitReason);

  if (score === undefined) {
    // Unknown exit reason: treat as neutral (0.0) and warn. This handles two
    // cases gracefully: (a) a future ExitReason value added to the DB before
    // this code is updated, and (b) data-quality issues from older migrations.
    // We do NOT throw because a single unknown reason should not abort the
    // entire retrospection run for this personality.
    console.warn(
      `[management-effectiveness] Unrecognised exit_reason "${exitReason}" — treating as 0.0`,
    );
    return 0.0;
  }

  return score;
}
