/**
 * Portfolio-level hard risk rules for paper trade entry decisions.
 *
 * All rules return {allowed: false, reason: string} on rejection and
 * {allowed: true} on pass. Rules are checked in this exact order:
 *   1. Event-day gate  (no DB — cheapest)
 *   2. VIX staleness   (no DB — caller-supplied age)
 *   3. Portfolio daily stop (one aggregate DB query) — T-45: now scoped per
 *      (personality, underlying) so each index is an independent book.
 *   4. Margin buffer   (one COUNT DB query)
 *   5. Max-legs / advisory lock (client checkout + transaction — most expensive)
 *
 * The order minimises database round-trips: the two cheapest checks are pure
 * in-memory, the two aggregate queries run on the shared pool, and the advisory
 * lock — which needs a dedicated client + transaction — only fires when
 * everything else has already passed.
 *
 * T-45 multi-index scoping (Decision 2 — Option A: per-index books):
 *   Rule 3 (daily stop) is now scoped per (personality, underlying). Each
 *   underlying's daily P&L is tracked independently — a large BANKNIFTY loss
 *   does not block a NIFTY trade, and vice versa. This matches the independent
 *   index-book model where each underlying runs its own paper book.
 *
 *   TODO (T-50 / M6): implement a GLOBAL circuit-breaker across ALL personalities
 *   and ALL underlyings. The global breaker guards against a systemic model
 *   failure (e.g. a bad signal model producing losses on all indices simultaneously).
 *   Deferred to T-50 because: (a) it requires additional DB schema work to track
 *   cross-index totals efficiently, (b) the per-index stop already provides the
 *   primary per-book protection, and (c) with only one operator the manual
 *   override path is simpler. Remove this TODO when T-50 is implemented.
 */

import type { Pool } from 'pg';
import type { Clock } from '../utils/clock.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TradeIntent {
  personalityId: string;
  underlying: string;
  atmStrike: number;
  straddleValue: number;
}

export interface RiskCheckResult {
  allowed: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Advisory lock key — project constant, documented here as the single source
// of truth. Key 42 = "portfolio-leg-cap". All code that needs to take this
// lock must import the constant rather than hard-coding the integer. Key 42 is
// unique within the project scope (no other advisory locks needed currently).
// ---------------------------------------------------------------------------
const ADVISORY_LOCK_KEY = 42;

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Converts an epoch-ms timestamp to an IST date string 'YYYY-MM-DD'.
 *
 * We avoid `date-fns-tz` here to keep this module free of library imports
 * beyond the standard Clock interface. The computation is simple: add the
 * IST offset (UTC+5:30 = 330 minutes) then extract UTC year/month/day from
 * the shifted Date, which are then the correct IST calendar values.
 */
function getISTDateStr(epochMs: number): string {
  const d = new Date(epochMs + 330 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Runs all portfolio-level hard risk rules against a proposed trade intent.
 *
 * @param db        - pg.Pool for database access
 * @param intent    - The trade being proposed (personality, underlying, strikes, straddle value)
 * @param clock     - Injected clock; use FixedClock in tests for determinism
 * @param vixAgeMs  - Milliseconds since the last VIX update (caller computes this;
 *                    we do not store VIX timestamps in this module to avoid hidden state)
 */
export async function portfolioRiskCheck(
  db: Pool,
  intent: TradeIntent,
  clock: Clock,
  vixAgeMs: number,
): Promise<RiskCheckResult> {
  // -------------------------------------------------------------------------
  // Rule 1 — Event-day gate
  //
  // Two sub-checks:
  //   a) BLOCKED_DATES env var: explicit list of dates (RBI policy days, budget
  //      days, etc.) managed outside the codebase so they can be updated without
  //      a deploy.
  //   b) NSE F&O expiry morning: all Thursday before 11:00 AM IST are blocked
  //      because the expiry-morning auction creates abnormal IV behaviour that
  //      invalidates the momentum-exhaustion signal assumptions.
  // -------------------------------------------------------------------------

  // Guard against a malformed BLOCKED_DATES env var (e.g. a typo in the value).
  // An invalid JSON string must not crash the risk check — we treat it as an
  // empty list and log a warning so the operator can investigate.
  //
  // M5 optimisation note: portfolioRiskCheck is called once per trade intent
  // (not per-signal per-personality), so parsing BLOCKED_DATES here is not on
  // the hot inner loop. The per-signal-per-personality hot path is
  // runPersonalityFilter in personality-filter.ts, where M5a applies.
  let blockedDates: string[] = [];
  try {
    blockedDates = JSON.parse(process.env.BLOCKED_DATES ?? '[]') as string[];
  } catch {
    console.warn(
      '[portfolioRiskCheck] BLOCKED_DATES env var is not valid JSON — treating as empty list',
    );
  }
  const nowMs = clock.now();
  const todayIST = getISTDateStr(nowMs);

  if (blockedDates.includes(todayIST)) {
    return { allowed: false, reason: 'EVENT_DAY_BLOCKED' };
  }

  // Derive the IST datetime by shifting UTC by +330 min so that UTC accessors
  // (getUTCDay, getUTCHours) return the IST calendar values.
  const istDate = new Date(nowMs + 330 * 60 * 1000);
  if (istDate.getUTCDay() === 4) {
    // Thursday (0=Sun … 4=Thu … 6=Sat)
    const istHour = istDate.getUTCHours();
    if (istHour < 11) {
      return { allowed: false, reason: 'EVENT_DAY_BLOCKED' };
    }
  }

  // -------------------------------------------------------------------------
  // Rule 2 — VIX staleness gate
  //
  // A stale VIX feed means we cannot trust our VIX-adjusted probability scores.
  // Rather than trading blind, we block. The threshold is configurable so the
  // operator can tighten or loosen the staleness window via env var without a
  // code change. Default 300,000 ms = 5 minutes.
  // -------------------------------------------------------------------------

  const vixStaleMs = Number(process.env.VIX_STALE_MS ?? '300000');
  if (vixAgeMs > vixStaleMs) {
    console.warn(
      `[portfolioRiskCheck] VIX stale (${vixAgeMs}ms), blocking trade for ${intent.personalityId}`,
    );
    return { allowed: false, reason: 'VIX_STALE' };
  }

  // -------------------------------------------------------------------------
  // Rule 3 — Portfolio daily stop (T-45: scoped per personality + underlying)
  //
  // If today's total realised P&L for THIS personality on THIS underlying has
  // hit or breached the daily stop loss threshold, no more opens are permitted
  // for that (personality, underlying) combination for the rest of the session.
  //
  // T-45 change: the stop is now per (personality, underlying) — Decision 2
  // Option A: per-index books. A BANKNIFTY loss for personality X does NOT
  // block a NIFTY trade for the same personality X. Each index is an independent
  // trading book with its own stop.
  //
  // TODO (T-50 / M6): add a GLOBAL circuit-breaker across all personalities and
  // all underlyings. See module-level comment for rationale and deferral reason.
  //
  // The WHERE clause anchors to midnight IST (computed in TypeScript to avoid
  // session-TZ issues with PostgreSQL's ::timestamptz cast). This ensures the
  // trading calendar day matches the IST session, not UTC midnight.
  //
  // net_pnl is NULL for open trades; COALESCE(..., 0) counts them as zero so
  // the stop triggers on realised losses only. Paper-loss on open positions is
  // NOT counted (unlike the previous portfolio-wide version) because per-index
  // unrealised P&L is not yet tracked at this granularity.
  // -------------------------------------------------------------------------

  const portfolioDailyStop = Number(process.env.PORTFOLIO_DAILY_STOP ?? '20000');

  // Compute IST midnight as a UTC timestamp so we can use a range predicate
  // on the indexed entry_time column. The original cast
  //   (NOW() AT TIME ZONE 'Asia/Kolkata')::date::timestamptz
  // does not produce an IST midnight boundary — ::date strips the timezone and
  // ::timestamptz reinterprets it in the PostgreSQL session timezone (usually UTC),
  // which is wrong. Computing the range in TypeScript is clearer and keeps the
  // query index-friendly (no function wrapping entry_time).
  const istMidnightMs = (() => {
    const nowMs = clock.now();
    const istDate = new Date(nowMs + 330 * 60 * 1000); // shift to IST (UTC+5:30)
    // Zero out the time components in IST by treating the shifted date as UTC
    istDate.setUTCHours(0, 0, 0, 0);
    return istDate.getTime() - 330 * 60 * 1000; // convert back to UTC
  })();
  const istMidnightISO = new Date(istMidnightMs).toISOString();
  const istTomorrowISO = new Date(istMidnightMs + 24 * 60 * 60 * 1000).toISOString();

  // Scoped per (personality_id, underlying): each index is an independent book.
  //
  // personality_id: added to paper_trades by migration 004. It is nullable —
  // pre-M2 rows have NULL. SQL equality (personality_id = $3) never matches
  // NULL rows, so pre-M2 trades are excluded from every personality's daily
  // stop. This is intentional and correct: those trades pre-date the
  // personality engine and should not count against any specific personality.
  // There is no fail-open risk here: the INSERT+UPDATE pattern in the router
  // means personality_id is set *after* the trade opens, but the daily stop
  // is checked *before* the trade opens — the window of NULL rows cannot
  // affect a pre-entry check.
  //
  // underlying: added to paper_trades by migration 015. It is nullable —
  // rows without an underlying value (pre-015 rows or rows from an
  // un-updated trade-executor) are excluded from per-index aggregates.
  // This is safe-fail: under-counting losses is conservative (an index's
  // stop fires later than it should, not earlier — the margin buffer and
  // the per-personality loss cap in the filter are additional backstops).
  //
  // NOTE FOR REVIEWERS: trade-executor.ts (PaperTradeExecutor.openTrade) is
  // the INSERT site. It must be updated to populate `underlying` on new rows
  // so that post-migration inserts are counted correctly. That file is out of
  // scope for this fix cycle; this comment marks the residual work.
  const pnlResult = await db.query<{ total_pnl: string }>(
    `SELECT COALESCE(SUM(net_pnl), 0) AS total_pnl
     FROM paper_trades
     WHERE entry_time >= $1
       AND entry_time < $2
       AND personality_id = $3
       AND underlying = $4`,
    [istMidnightISO, istTomorrowISO, intent.personalityId, intent.underlying],
  );
  const totalPnl = Number(pnlResult.rows[0]?.total_pnl ?? 0);
  if (totalPnl <= -portfolioDailyStop) {
    console.warn(
      `[portfolioRiskCheck] Portfolio daily stop hit for ${intent.personalityId}/${intent.underlying}: ` +
        `${totalPnl}, blocking further ${intent.underlying} entries today.`,
    );
    return { allowed: false, reason: 'PORTFOLIO_DAILY_STOP' };
  }

  // -------------------------------------------------------------------------
  // Rule 4 — Margin buffer (30% reserve)
  //
  // We estimate the margin currently consumed by open straddles and block if
  // it exceeds 70% of the configured capital. The 30% reserve ensures there
  // is always buffer for adverse intraday moves and expiry settlement.
  //
  // Estimation formula:
  //   open_count * straddle_value * lots * lot_size * margin_rate
  //
  // This is intentionally conservative: we use the *new* trade's straddle
  // value for all open positions (not their original entry price), which
  // over-estimates the margin used as prices move up. That conservatism is
  // by design — this is a safety check, not an accounting record.
  //
  // MARGIN_RATE defaults to 0.20 (20%) which approximates NSE option writing
  // SPAN + exposure margins. MARGIN_CAPITAL defaults to ₹1,00,000.
  // -------------------------------------------------------------------------

  const marginCapital = Number(process.env.MARGIN_CAPITAL ?? '100000');
  const marginRate = Number(process.env.MARGIN_RATE ?? '0.20');

  // Lot sizes by underlying — used for margin estimation. NSE lot sizes change
  // periodically; the values below were the project constants when this module was
  // written and match the original hardcoded 50 for NIFTY (backward compat).
  // Configurable via env vars so operators can update without a code change.
  //   NIFTY    = 50  (original project constant — override via LOT_SIZE_NIFTY if changed)
  //   BANKNIFTY = 15 (NSE lot size as of 2023 — override via LOT_SIZE_BANKNIFTY)
  //   SENSEX    = 10 (BSE lot size as of 2023 — override via LOT_SIZE_SENSEX)
  //
  // NOTE: NSE changed NIFTY lot size from 50 to 75 in November 2024. If deploying
  // after that date, set LOT_SIZE_NIFTY=75 in env. The default stays 50 for backward
  // compat with existing tests and config that hardcoded the old value.
  //
  // TODO (T-50): Move lot sizes to a DB config table so they survive process restarts.
  const LOT_SIZES: Record<string, number> = {
    NIFTY: Number(process.env.LOT_SIZE_NIFTY ?? '50'),
    BANKNIFTY: Number(process.env.LOT_SIZE_BANKNIFTY ?? '15'),
    SENSEX: Number(process.env.LOT_SIZE_SENSEX ?? '10'),
  };
  // Fall back to 50 for unknown underlyings (pre-T-45 backward compat and tests).
  const lotSize = LOT_SIZES[intent.underlying] ?? 50;
  const lots = 1;

  // M4 fix: scope the open-leg count to the current underlying so the margin
  // estimate only covers positions in the same index book. Counting ALL open
  // legs across indices over-estimates margin in a mixed-index book (e.g. 2
  // NIFTY + 2 BANKNIFTY legs counted against the NIFTY lot size of 50 inflates
  // the NIFTY margin estimate by the BANKNIFTY legs × incorrect lot size).
  //
  // The `underlying` column is nullable (migration 015); rows with NULL
  // underlying are excluded from this count. This is safe-fail: those rows
  // correspond to pre-015 trades whose index is unknown — excluding them
  // under-estimates margin usage, which is conservative for a blocking check.
  //
  // The open count is also reused in Rule 5 (M5b) to avoid a second identical
  // COUNT(*) query. Rule 5 needs the global open-leg count (not per-underlying)
  // for the advisory-lock cap, so we run a separate global COUNT there.
  // However, both Rule 4 and Rule 5 previously ran:
  //   SELECT COUNT(*) FROM paper_trades WHERE status = 'open'
  // Rule 4 now runs the per-underlying version; Rule 5 runs the global version
  // inside the advisory lock transaction (where it must run to be serialised).
  // There is no safe way to share a pre-lock COUNT with the locked count because
  // a concurrent INSERT could land between the two — the lock exists precisely
  // to prevent that race. The M5b optimisation therefore only applies within a
  // single rule: we do not attempt to share across Rule 4 and Rule 5.
  const openLegsForMargin = await db.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt
     FROM paper_trades
     WHERE status = 'open'
       AND underlying = $1`,
    [intent.underlying],
  );
  const openCountForMargin = Number(openLegsForMargin.rows[0]?.cnt ?? 0);
  const estimatedMargin = openCountForMargin * intent.straddleValue * lots * lotSize * marginRate;

  if (estimatedMargin > marginCapital * 0.7) {
    console.warn(
      `[portfolioRiskCheck] Margin buffer exceeded: estimated ${estimatedMargin} > 70% of ${marginCapital}`,
    );
    return { allowed: false, reason: 'MARGIN_BUFFER_EXCEEDED' };
  }

  // -------------------------------------------------------------------------
  // Rule 5 — Max 4 open legs with advisory lock
  //
  // This is the most expensive rule (client checkout + transaction) so it runs
  // last. It prevents more than 2 simultaneous straddles (each straddle = 1 row
  // in paper_trades, representing 2 option legs: CE + PE).
  //
  // The advisory lock serialises concurrent checks from multiple personalities
  // that would otherwise all read the same count and all proceed. Without it,
  // 3 open positions + 5 personalities checking simultaneously would let all 5
  // attempt to open, blowing past the cap.
  //
  // pg_try_advisory_xact_lock(key) is used (not pg_try_advisory_lock) so the
  // lock is automatically released when the transaction commits or rolls back —
  // no explicit unlock needed, no risk of leaked locks.
  //
  // If the lock cannot be acquired, another transaction is mid-check. We treat
  // that as "max legs exceeded" (conservative) because:
  //   a) We cannot safely know whether the other transaction will end up adding
  //      a position or not.
  //   b) The cost of a false-negative (skipping one trade due to lock contention)
  //      is far lower than a false-positive (exceeding the leg cap).
  // -------------------------------------------------------------------------

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const lockResult = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1) AS acquired',
      [ADVISORY_LOCK_KEY],
    );

    if (!lockResult.rows[0]?.acquired) {
      // Lock not acquired — another check is in progress; block conservatively.
      await client.query('ROLLBACK');
      return { allowed: false, reason: 'MAX_LEGS_EXCEEDED' };
    }

    const countResult = await client.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM paper_trades WHERE status = 'open'`,
    );
    const openLegs = Number(countResult.rows[0]?.cnt ?? 0);

    // COMMIT releases the advisory lock so other checks can proceed immediately.
    await client.query('COMMIT');

    if (openLegs >= 4) {
      console.warn(
        `[portfolioRiskCheck] Max legs exceeded: ${openLegs} open, blocking for ${intent.personalityId}`,
      );
      return { allowed: false, reason: 'MAX_LEGS_EXCEEDED' };
    }

    return { allowed: true };
  } catch (err) {
    // ROLLBACK on any unexpected error — also releases the advisory lock.
    await client.query('ROLLBACK').catch(() => {
      // Suppress secondary ROLLBACK failure so we still rethrow the original error.
    });
    throw err;
  } finally {
    // Always return the client to the pool — critical to prevent pool exhaustion.
    client.release();
  }
}
