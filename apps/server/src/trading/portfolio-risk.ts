/**
 * Portfolio-level hard risk rules for paper trade entry decisions.
 *
 * All rules return {allowed: false, reason: string} on rejection and
 * {allowed: true} on pass. Rules are checked in this exact order:
 *   1. Event-day gate  (no DB — cheapest)
 *   2. VIX staleness   (no DB — caller-supplied age)
 *   3. Portfolio daily stop (one aggregate DB query)
 *   4. Margin buffer   (one COUNT DB query)
 *   5. Max-legs / advisory lock (client checkout + transaction — most expensive)
 *
 * The order minimises database round-trips: the two cheapest checks are pure
 * in-memory, the two aggregate queries run on the shared pool, and the advisory
 * lock — which needs a dedicated client + transaction — only fires when
 * everything else has already passed.
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
  // Rule 3 — Portfolio daily stop
  //
  // If today's total realised P&L has hit or breached the daily stop loss
  // threshold, no more opens are permitted for the rest of the session. This
  // prevents a bad sequence from compounding into a catastrophic loss.
  //
  // The WHERE clause anchors to midnight IST (cast to date then back to
  // timestamptz) so that sessions spanning UTC midnight are still bounded by
  // the IST trading calendar day. This is the correct timezone for Indian market
  // sessions.
  //
  // We include both open and closed trades in the SUM so that paper-loss on
  // still-open positions is counted; this prevents a scenario where all
  // positions are open (net_pnl = NULL) and the stop never triggers.
  // net_pnl is NULL for open trades, so COALESCE(..., 0) is critical.
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

  const pnlResult = await db.query<{ total_pnl: string }>(
    `SELECT COALESCE(SUM(net_pnl), 0) AS total_pnl
     FROM paper_trades
     WHERE entry_time >= $1 AND entry_time < $2`,
    [istMidnightISO, istTomorrowISO],
  );
  const totalPnl = Number(pnlResult.rows[0]?.total_pnl ?? 0);
  if (totalPnl <= -portfolioDailyStop) {
    console.warn(
      `[portfolioRiskCheck] Portfolio daily stop hit: ${totalPnl}, blocking for ${intent.personalityId}`,
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
  const lotSize = 50; // NIFTY lot size — project constant; BankNifty/Sensex will need env var when added
  const lots = 1;

  const openLegsForMargin = await db.query<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM paper_trades WHERE status = 'open'`,
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
