/**
 * personality-filter.ts — 5-stage personality decision filter
 *
 * This module provides pure filter functions and a DB-backed state fetcher.
 * The core filter function (runPersonalityFilter) is intentionally pure and
 * synchronous so each stage is independently unit-testable without mocks.
 *
 * Design decisions:
 *   - No I/O inside the filter stages. All context is pre-fetched and passed in.
 *     This makes the filter deterministic and avoids N*M DB queries when routing
 *     one signal to 10 personalities simultaneously.
 *   - netPnl is typed as `string` (not `number`) to match the `pg` NUMERIC wire
 *     format (see src/db/schema.ts header). Callers comparing it to a loss limit
 *     must use parseFloat() or a decimal library — this is documented below.
 *   - fetchDailyState runs two queries in a single DB call using a UNION ALL so
 *     it doesn't need two round-trips. The queries are structurally different
 *     (SUM vs COUNT with different WHERE clauses), so a single query + UNION ALL
 *     or two separate pool.query calls both work. Two separate calls are used here
 *     for clarity and to avoid a fragile UNION ALL column-alignment dependency.
 *   - Stage 3 VIX-null pass: if VIX data is unavailable we don't block entry —
 *     missing data should never silently disable strategies that would otherwise
 *     trade. An explicit "skip-on-null" policy is stated in comments so future
 *     maintainers don't accidentally change it.
 *   - Stage 5 profit gate is implemented but off by default (require_profit_gate
 *     absent or falsy). When active it only blocks entry when today's net P&L is
 *     already above the profit gate amount — i.e. a "don't over-trade a winning
 *     day" guard.
 *   - Regime check is explicitly deferred: per the task contract, regime tagging
 *     is not available in Phase 1. The comment ensures reviewers can find the
 *     deferral when Phase 2 / T-33 is implemented.
 */

import type { Pool } from "pg";
import type { PersonalityConfig } from "../db/schema.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The signal input that the personality filter evaluates.
 *
 * vix and adjustedProbability are number types here (not string) because the
 * caller (PersonalityRouter, T-27) will have parsed them from the Redis stream
 * message before invoking this function. Keeping them as numbers avoids
 * repeated parseFloat() inside every stage call.
 */
export interface StraddleSignalInput {
  signalType: "MOMENTUM_EXHAUSTION" | "SCHEDULED" | "PULLBACK";
  signalId: string;
  underlying: string;
  atmStrike: number;
  spot: number;
  straddleValue: number;
  /** null when the VIX feed has not produced a value yet */
  vix: number | null;
  /** Final probability score after VIX/time-of-day adjustments (0–1 range) */
  adjustedProbability: number;
  confidenceTier: "HIGH" | "MEDIUM" | "LOW";
  /** Epoch milliseconds of signal creation */
  signalTimeMs: number;
}

/**
 * Pre-fetched daily state for one personality.
 *
 * netPnl is typed as `string` to match the pg NUMERIC wire format — the
 * `pg` library returns NUMERIC columns as strings when the custom type parser
 * is set (see src/db/client.ts). Callers that need numeric comparisons must use
 * parseFloat(). The filter stages handle this internally.
 */
export interface DailyState {
  /** Count of trades with status='closed' today for this personality */
  tradeCount: number;
  /** Sum of net_pnl for closed trades today; '0' if none (NUMERIC → string) */
  netPnl: string;
  /** Count of trades with status='open' today for this personality */
  openPositions: number;
}

/**
 * Outcome of the 5-stage filter.
 *
 * When pass=true, stage is always 6 (meaning "cleared all 5 stages").
 * When pass=false, stage identifies which stage rejected (1–5) and reason
 * is a machine-readable snake_case token suitable for logging or metrics.
 */
export type FilterResult =
  | { pass: true; stage: 6; reason: "PASS" }
  | { pass: false; stage: 1 | 2 | 3 | 4 | 5; reason: string };

/**
 * Return type for checkComparisonIntegrity.
 */
export interface ComparisonIntegrityResult {
  valid: boolean;
  /** Name of the outlier personality (first one found), or undefined if valid */
  offender?: string;
  /** Human-readable explanation of the violation, or undefined if valid */
  message?: string;
}

// ---------------------------------------------------------------------------
// fetchDailyState
// ---------------------------------------------------------------------------

/**
 * Fetches today's trade count, net P&L, and open-position count for one
 * personality from the database.
 *
 * todayIST must be in 'YYYY-MM-DD' format (India Standard Time date). The
 * query uses DATE(entry_time AT TIME ZONE 'Asia/Kolkata') for the filter to
 * match trades entered on the given IST date regardless of the server timezone.
 *
 * Two separate queries are used (not a UNION ALL) because they aggregate
 * different status values — closed trades for P&L/count and open trades for
 * position count. Merging them into one query would require a subquery or
 * conditional aggregation that is harder to read and maintain.
 *
 * This fixes the known todayNetPnl='0' bug in M1 PositionMonitor: the
 * PositionMonitor hardcodes '0' because it doesn't know the real cumulative
 * P&L. This function computes the correct sum from closed trades.
 *
 * @param db - pg Pool (not the module-level pool, so callers can inject a test pool)
 * @param personalityId - UUID of the personality row
 * @param todayIST - date string in 'YYYY-MM-DD' format, in IST
 */
export async function fetchDailyState(
  db: Pool,
  personalityId: string,
  todayIST: string,
): Promise<DailyState> {
  // Query 1: closed-trade count and net P&L for today
  // Using parameterised $1/$2 to prevent SQL injection — personalityId is
  // a UUID from the DB but we never assume caller input is safe.
  const closedResult = await db.query<{
    today_trade_count: string;
    today_net_pnl: string;
  }>(
    `SELECT
       COUNT(*)::text              AS today_trade_count,
       COALESCE(SUM(net_pnl), 0)  AS today_net_pnl
     FROM paper_trades
     WHERE personality_id = $1
       AND status = 'closed'
       AND DATE(entry_time AT TIME ZONE 'Asia/Kolkata') = $2::date`,
    [personalityId, todayIST],
  );

  // Query 2: count of currently open legs for this personality (not date-filtered:
  // open trades from a prior day that were not closed at EOD are still "open").
  // In normal operation this should never happen, but we count all open rows to
  // be safe rather than missing a stale open position.
  const openResult = await db.query<{ open_legs: string }>(
    `SELECT COUNT(*)::text AS open_legs
     FROM paper_trades
     WHERE personality_id = $1
       AND status = 'open'`,
    [personalityId],
  );

  // pg returns COUNT(*) as a string when custom type parsers are active
  // (the NUMERIC parser coerces OID 1700 to string; COUNT returns OID 20 bigint
  // which pg also renders as string). parseInt is safe here.
  const row = closedResult.rows[0];
  const openRow = openResult.rows[0];

  return {
    tradeCount: parseInt(row?.today_trade_count ?? "0", 10),
    netPnl: String(row?.today_net_pnl ?? "0"),
    openPositions: parseInt(openRow?.open_legs ?? "0", 10),
  };
}

// ---------------------------------------------------------------------------
// runPersonalityFilter
// ---------------------------------------------------------------------------

/**
 * Runs the 5-stage personality decision filter synchronously.
 *
 * All inputs are pre-fetched so this function is pure — it has no I/O side
 * effects and is independently testable at each stage.
 *
 * Stage execution order: 1 → 2 → 3 → 4 → 5. Returns on the first rejection.
 *
 * @param signal     - The incoming straddle signal
 * @param personality - Full personality config row from personality_configs
 * @param dailyState - Pre-fetched daily state (from fetchDailyState)
 * @param nowMs      - Current epoch ms (injected for testability — not Date.now())
 */
export function runPersonalityFilter(
  signal: StraddleSignalInput,
  personality: PersonalityConfig,
  dailyState: DailyState,
  nowMs: number,
): FilterResult {
  // -------------------------------------------------------------------------
  // Stage 1 — Hard filters
  // -------------------------------------------------------------------------
  // Signal-type compatibility and personality active status.
  // These are cheap O(1) checks that catch the most common rejections early.

  // (a) Personality must be active
  if (!personality.isActive) {
    return { pass: false, stage: 1, reason: "PERSONALITY_INACTIVE" };
  }

  // (b) Signal type must match the personality's accepted signal types.
  //   - fixed_time personalities (Clockwork, Learners) only accept SCHEDULED
  //   - momentum_exhaustion personalities only accept MOMENTUM_EXHAUSTION or PULLBACK
  //   - any_signal personalities (Scanner, Blitz) accept all three types
  //   - sr_anchored (Levelhead, Phase 2) treated like any_signal for now since
  //     the S/R signal type is not yet emitted — it won't match real traffic
  if (personality.entryType === "fixed_time" && signal.signalType !== "SCHEDULED") {
    return {
      pass: false,
      stage: 1,
      reason: "ENTRY_TYPE_MISMATCH: fixed_time personality only accepts SCHEDULED signals",
    };
  }

  if (
    personality.entryType === "momentum_exhaustion" &&
    signal.signalType === "SCHEDULED"
  ) {
    return {
      pass: false,
      stage: 1,
      reason:
        "ENTRY_TYPE_MISMATCH: momentum_exhaustion personality does not accept SCHEDULED signals",
    };
  }

  // (c) Time-window gate: signal must be within the configured trading hours.
  // ENTRY_START_TIME and ENTRY_CUTOFF_TIME are read from env. Defaults match
  // NSE morning open and pre-expiry cutoff for weekly options.
  // nowMs is used (not signalTimeMs) so a stale signal in the queue does not
  // slip through a time gate that has already closed.
  const istHHMM = toISTHHMM(nowMs);
  const entryStart = process.env["ENTRY_START_TIME"] ?? "09:20";
  const entryCutoff = process.env["ENTRY_CUTOFF_TIME"] ?? "15:00";

  if (istHHMM < entryStart || istHHMM > entryCutoff) {
    return {
      pass: false,
      stage: 1,
      reason: `OUTSIDE_TRADING_HOURS: current IST time ${istHHMM} is outside [${entryStart}, ${entryCutoff}]`,
    };
  }

  // (d) Blocked-dates guard: today must not be in the BLOCKED_DATES list.
  // BLOCKED_DATES is a JSON array of 'YYYY-MM-DD' strings (e.g. RBI policy days).
  const todayIST = toISTDate(nowMs);
  const blockedDates = parseBlockedDates();
  if (blockedDates.includes(todayIST)) {
    return {
      pass: false,
      stage: 1,
      reason: `BLOCKED_DATE: ${todayIST} is a blocked trading date`,
    };
  }

  // -------------------------------------------------------------------------
  // Stage 2 — State checks
  // -------------------------------------------------------------------------
  // Uses pre-fetched DailyState to enforce per-personality daily limits.

  const maxDailyTrades = (personality.params["max_daily_trades"] as number | undefined) ?? Infinity;
  if (dailyState.tradeCount >= maxDailyTrades) {
    return { pass: false, stage: 2, reason: "MAX_DAILY_TRADES_REACHED" };
  }

  const maxDailyLoss = personality.params["max_daily_loss"] as number | undefined;
  if (maxDailyLoss !== undefined) {
    // netPnl is a NUMERIC-as-string from pg; parseFloat converts it to a JS number.
    // Negative P&L means a loss — we compare against -maxDailyLoss.
    if (parseFloat(dailyState.netPnl) <= -maxDailyLoss) {
      return { pass: false, stage: 2, reason: "DAILY_LOSS_LIMIT_REACHED" };
    }
  }

  // Open-legs check: each straddle uses two legs. max_open_legs is the total
  // number of individual option legs allowed to be open simultaneously.
  // openPositions represents open straddle counts (each = 2 legs conceptually,
  // but we store one paper_trades row per straddle, not per leg).
  // The check is: openPositions < max_open_legs / 2
  // (i.e. count of open straddles < half the leg limit).
  const maxOpenLegs = personality.params["max_open_legs"] as number | undefined;
  if (maxOpenLegs !== undefined) {
    const maxOpenStraddles = maxOpenLegs / 2;
    if (dailyState.openPositions >= maxOpenStraddles) {
      return { pass: false, stage: 2, reason: "MAX_OPEN_POSITIONS_REACHED" };
    }
  }

  // -------------------------------------------------------------------------
  // Stage 3 — Context checks (VIX ceiling)
  // -------------------------------------------------------------------------
  // Blocks entry when VIX is above the personality's configured maximum.
  // Deliberately passes when VIX is null: missing data should not silently
  // disable a strategy — the strategy owner opted in to a VIX ceiling, not to
  // a "block when feed is down" rule.
  //
  // REGIME CHECK DEFERRED: regime tagging (RANGING / TRENDING_STRONG /
  // VOLATILE_REVERTING / EVENT_DAY) is not available until Phase 2 (T-33).
  // When T-33 lands, add a regime check here.

  const vixMax = personality.params["vix_max"] as number | undefined;
  if (vixMax !== undefined && signal.vix !== null && signal.vix > vixMax) {
    return { pass: false, stage: 3, reason: "VIX_TOO_HIGH" };
  }

  // -------------------------------------------------------------------------
  // Stage 4 — Signal quality
  // -------------------------------------------------------------------------
  // Enforces the minimum probability threshold for momentum-based personalities.
  // SCHEDULED signals skip this check: Clockwork and the Learners are not
  // probability-gated (they enter at a fixed time regardless of signal quality).

  if (signal.signalType !== "SCHEDULED") {
    const minProbability = (personality.params["min_probability"] as number | undefined) ?? 0;
    if (signal.adjustedProbability < minProbability) {
      return { pass: false, stage: 4, reason: "PROBABILITY_BELOW_THRESHOLD" };
    }
  }

  // -------------------------------------------------------------------------
  // Stage 5 — Optional profit gate
  // -------------------------------------------------------------------------
  // When enabled (require_profit_gate = true), blocks entry if today's net P&L
  // is already above the profit_gate_amount. This prevents over-trading on
  // already-winning days.
  // Gate is disabled by default (require_profit_gate absent or falsy).

  const requireProfitGate = personality.params["require_profit_gate"] as boolean | undefined;
  if (requireProfitGate === true) {
    const profitGateAmount = personality.params["profit_gate_amount"] as number | undefined;
    if (profitGateAmount !== undefined) {
      // If today's net P&L has already reached or exceeded the profit gate,
      // block further entries to protect the day's gains.
      if (parseFloat(dailyState.netPnl) >= profitGateAmount) {
        return { pass: false, stage: 5, reason: "PROFIT_GATE_REACHED" };
      }
    }
  }

  // All 5 stages passed
  return { pass: true, stage: 6, reason: "PASS" };
}

// ---------------------------------------------------------------------------
// checkComparisonIntegrity
// ---------------------------------------------------------------------------

/**
 * Checks that Precision, Adjuster, and Reducer min_probability values stay
 * within 8 percentage points of each other.
 *
 * If the drift exceeds 8pp, the comparison between the three management styles
 * (Hold vs Roll vs Cut+Reenter) is invalidated because they are no longer
 * entering on the same quality of signals. The evolution engine should pause
 * further threshold changes on the offending personality.
 *
 * Only active momentum_exhaustion personalities are included in the check.
 * Inactive or frozen personalities are excluded: a frozen Clockwork row has no
 * min_probability, and inactive personalities are not generating trades to skew
 * the comparison.
 *
 * Returns the first outlier found (by highest or lowest absolute deviation from
 * the mean). If multiple personalities are equally out of range, only the first
 * offender is named — the caller should re-run after fixing each one.
 */
export function checkComparisonIntegrity(
  personalities: PersonalityConfig[],
): ComparisonIntegrityResult {
  // Filter to active momentum_exhaustion personalities that have min_probability set
  const candidates = personalities.filter(
    (p) =>
      p.entryType === "momentum_exhaustion" &&
      p.isActive &&
      typeof p.params["min_probability"] === "number",
  );

  // Need at least 2 personalities to compare; 0 or 1 is trivially valid
  if (candidates.length < 2) {
    return { valid: true };
  }

  const probs = candidates.map((p) => ({
    name: p.name,
    prob: p.params["min_probability"] as number,
  }));

  // Find the spread: max minus min of all min_probability values
  let minProb = probs[0]!.prob;
  let maxProb = probs[0]!.prob;
  for (const { prob } of probs) {
    if (prob < minProb) minProb = prob;
    if (prob > maxProb) maxProb = prob;
  }

  const spread = maxProb - minProb;

  // 8 percentage points = 0.08 in [0,1] probability space.
  // Use a tiny epsilon (1e-9) to handle floating-point representation of exact
  // boundary values like 0.08 which may not be exactly representable in IEEE 754.
  if (spread <= 0.08 + 1e-9) {
    return { valid: true };
  }

  // Find the personality whose value deviates most from the mean
  const mean = probs.reduce((sum, { prob }) => sum + prob, 0) / probs.length;
  let offender = probs[0]!;
  let maxDeviation = Math.abs(offender.prob - mean);
  for (const p of probs) {
    const deviation = Math.abs(p.prob - mean);
    if (deviation > maxDeviation) {
      maxDeviation = deviation;
      offender = p;
    }
  }

  return {
    valid: false,
    offender: offender.name,
    message:
      `min_probability spread of ${(spread * 100).toFixed(1)}pp exceeds the 8pp ` +
      `comparison integrity limit. Outlier personality: ${offender.name} ` +
      `(min_probability=${offender.prob})`,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Converts an epoch ms timestamp to an IST time string in 'HH:mm' format.
 * Used by Stage 1 to compare against ENTRY_START_TIME / ENTRY_CUTOFF_TIME.
 *
 * IST = UTC + 5 hours 30 minutes = UTC + 19800 seconds = UTC + 19800000 ms.
 * We avoid importing date-fns-tz here to keep this module dependency-free.
 */
function toISTHHMM(epochMs: number): string {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5h30m in ms
  const istMs = epochMs + IST_OFFSET_MS;
  const d = new Date(istMs);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

/**
 * Converts an epoch ms timestamp to an IST date string in 'YYYY-MM-DD' format.
 * Used by Stage 1 for the blocked-dates check.
 */
function toISTDate(epochMs: number): string {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istMs = epochMs + IST_OFFSET_MS;
  const d = new Date(istMs);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Parses the BLOCKED_DATES environment variable.
 * Expects a JSON array of 'YYYY-MM-DD' strings. Returns [] on parse failure
 * rather than throwing — a misconfigured env var should not crash the process,
 * it should simply skip the blocked-date check.
 */
function parseBlockedDates(): string[] {
  const raw = process.env["BLOCKED_DATES"];
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === "string");
    }
    return [];
  } catch {
    return [];
  }
}
