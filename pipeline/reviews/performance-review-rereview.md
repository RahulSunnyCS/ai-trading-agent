# PERFORMANCE RE-REVIEW REPORT — Phase 6 Fix Cycle
# Milestone 5 (Multi-Index Expansion)
# Scope: git diff 7394fbe..HEAD

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## PRIOR FINDINGS — RESOLUTION STATUS

---

### CRITICAL (was): Triple-redundant EOD backtest + N+1 per-day snapshot queries

**Status: RESOLVED with one minor residual (see new Finding 1 below)**

Verification points confirmed:

**(a) Backtest runs at most once per EOD run**

`src/jobs/eod-retrospection-job.ts` (Step 4c, ~line 222) now runs ONE shared
backtest via `backtestRunnerFactory.create(pool)` before the per-personality
loop and stores the result as `sharedBacktestTrades`. Each call to `runOptimizer`
receives `{ precomputedTrades: sharedBacktestTrades }` so the optimizer skips
its internal `runner.run()` call when `precomputedTrades` is defined.

The M3 kernel_only path in `src/retrospection/optimizer.ts` (line 966) skips
the backtest when `allCandidatesAtOrBelowFixedProb === true AND precomputedTrades
=== undefined`. The EOD job unconditionally passes `precomputedTrades` when the
shared run succeeded, so the kernel_only fast path is bypassed even when it would
apply — this is a minor inefficiency documented in new Finding 1 below.

When the shared backtest fails, `sharedBacktestTrades = undefined` and each
optimizer falls back to its own backtest or the kernel_only path. This is correct
and non-fatal.

**(b) Single range query with TimescaleDB time-range predicate**

`src/backtesting/backtest-runner.ts` `loadAllSnapshots()` (~line 350) issues one
query with `WHERE symbol = $1 AND time >= $2 AND time < $3`. The lower bound is
`fromDateT00:00:00.000Z` and the upper bound is `(toDate + 1 day)T00:00:00.000Z`
(exclusive). The time-range predicate is present and correct — TimescaleDB chunk
exclusion fires as required.

The in-memory grouping uses a single forward pass (`for...of result.rows`) into a
`Map<string, InMemorySnapshot[]>`. This is O(N) — not O(N^2). Each row is touched
once. The Map key is `TO_CHAR(time AT TIME ZONE 'UTC', 'YYYY-MM-DD')` computed
in the SELECT clause (not the WHERE clause), so it does not affect index use.

**(c) loadPersonalities and loadRegimeTags calls**

The EOD job queries `personality_configs` ONCE in Step 3 (line 165). However, the
shared backtest runner (`createBacktestRunner(pool).run()`) also calls
`loadPersonalities(pool)` internally at line 521 of `backtest-runner.ts`. This
means `personality_configs` is now queried TWICE per EOD run (down from four times:
one in EOD + three in per-personality optimizers). This is Low severity — see
new Finding 2.

---

### HIGH (was): fetchDailyState defeating idx_paper_trades_status_entry_time

**Status: RESOLVED**

`src/signals/personality-filter.ts` `fetchDailyState()` (~line 187) now computes
IST-midnight UTC bounds in TypeScript using:

```typescript
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istMidnightMs = new Date(todayIST).getTime() - IST_OFFSET_MS;
const istMidnightISO = new Date(istMidnightMs).toISOString();
const istTomorrowISO = new Date(istMidnightMs + 24 * 60 * 60 * 1000).toISOString();
```

The closed-trades query now uses:
`entry_time >= $2 AND entry_time < $3`

This is sargable — PostgreSQL can use `idx_paper_trades_personality_status`
`(personality_id, status)` to narrow to the personality+status pair, then apply
the `entry_time` range as a residual filter. The non-sargable
`DATE(entry_time AT TIME ZONE 'Asia/Kolkata') = $2::date` is gone.

Date arithmetic is correct: `new Date('2026-05-19')` parses as UTC midnight
(2026-05-19T00:00:00.000Z). Subtracting `IST_OFFSET_MS` (19,800,000 ms = 5h30m)
yields 2026-05-18T18:30:00.000Z, which is the correct UTC representation of
2026-05-19 00:00 IST. This matches the method used in `portfolio-risk.ts`
(which shifts forward then zeroes UTC hours — both produce the same value).

Also confirmed: the open-positions query now uses `underlying = $2` (the bare
index name column from migration 015) instead of the prior `symbol = $2` (which
compared full Fyers option symbols like 'NSE:NIFTY25O0924500CE' to a bare index
name and could never match). This correctness fix is confirmed verified.

---

### MEDIUM (was): Duplicate COUNT(*) in portfolio-risk.ts

**Status: RESOLVED — the two counts are genuinely semantically distinct**

`src/trading/portfolio-risk.ts`:

- Rule 4 (margin buffer, ~line 310): `SELECT COUNT(*) WHERE status = 'open' AND underlying = $1`
  — counts only legs in the current underlying's book, used to estimate index-specific
  margin consumption with the correct lot size for that index.

- Rule 5 (max 4 open legs, ~line 366): `SELECT COUNT(*) WHERE status = 'open'`
  — counts ALL open legs globally, enforced under an advisory lock to prevent races.

These are NOT the same query. The Rule 4 count is scoped per-underlying; the Rule 5
count is global. Sharing them would be wrong because:
1. Rule 4 must account only for the current underlying's margin.
2. Rule 5 must run inside the advisory lock transaction for correctness — a
   pre-lock read of the count could be stale by the time the lock is acquired.

The code comment at line 299 explicitly documents this decision. This is a correct
and deliberate two-query design.

---

### MEDIUM (was): parseBlockedDates re-parsing per-personality per-signal

**Status: RESOLVED**

`src/signals/personality-router.ts` (~line 542) calls `parseBlockedDatesSet()`
once per signal and passes the `ReadonlySet<string>` to every `runPersonalityFilter`
call. The hot inner loop (10 personalities × N signals/day) no longer calls
`JSON.parse(process.env.BLOCKED_DATES)`.

The fallback inside `runPersonalityFilter` (`parseBlockedDates()`, line 391)
is only reached when the caller passes `blockedDates = undefined`, which happens
only in backward-compatible test callers that predate the parameter. The production
router always supplies the pre-parsed Set. The fallback path is correct and
does not affect the hot path.

---

## NEW FINDINGS FROM THE FIX CYCLE

---

FINDING: kernel_only fast path bypassed when precomputedTrades is supplied
Severity: Low
File and line: src/retrospection/optimizer.ts, line 966
What it is: The M3 kernel_only guard (which skips Phase B entirely when all shortlisted
  candidates are at or below 0.70, the fixed probability the current backtest runner
  emits) is only active when `precomputedTrades === undefined`. The EOD job always
  passes `precomputedTrades` when the shared backtest succeeded. So in the common case
  where all candidates are at or below 0.70 AND the shared backtest succeeded,
  `scoreFinalists()` still runs against the full in-memory trades array (~250,000–500,000
  rows for a one-year window) for each personality, even though the scores are
  predetermined to be identical (all candidates admit the same trades at threshold
  <= 0.70).
Impact at scale: This is entirely in-memory work — no additional DB queries. At
  3 personalities, it amounts to 3 extra in-memory filter passes of ~300k rows each.
  A single `Array.filter` on 300k plain objects takes roughly 5–15ms in a modern
  JavaScript runtime. At EOD (once per day), this is not a meaningful cost. However,
  if the personality count grows significantly (e.g., 30+ personalities) the wasted
  work scales linearly. The logic comment says "possibly for testing or future
  calibrated-probability mode" but this rationale produces ongoing unnecessary work
  in every production EOD run until the backtest runner emits calibrated probabilities.
How to fix it: Extend the kernel_only condition to also fire when precomputedTrades
  is supplied and all candidates are at or below the fixed ceiling:
  `if (allCandidatesAtOrBelowFixedProb)` (removing the `&& options.precomputedTrades === undefined`
  guard). The precomputedTrades array would be passed but unused, which is the same
  correct behavior the code already documents for the kernel_only path. If testing
  scenarios genuinely need to force backtest scoring, that should be done via a
  separate test-only option flag rather than the production data path.

---

FINDING: loadPersonalities called twice per EOD run
Severity: Low
File and line: src/backtesting/backtest-runner.ts line 521; src/jobs/eod-retrospection-job.ts line 165
What it is: The EOD job fetches active personalities in Step 3 (`SELECT id, entry_type FROM
  personality_configs`). The shared backtest runner it then calls (`backtestRunnerFactory.create(pool).run()`)
  also calls `loadPersonalities(pool)` internally (`SELECT id, name, ... FROM personality_configs
  WHERE is_active = TRUE AND phase = 1`). This means two round-trips to the same
  table per EOD run. The queries are slightly different in shape (EOD fetches only
  `id` and `entry_type`; the backtest fetches the full personality row), so they
  cannot be trivially unified without restructuring the backtest runner's public API.
Impact at scale: At one EOD run per trading day with two small queries (10–30 rows
  each), this is negligible. It was worse before the fix (four queries: one in EOD +
  three per-optimizer). This is documented as a known residual in the EOD job's comments.
How to fix it: Pass the already-loaded personality data into `createBacktestRunner`
  via a `preloadedPersonalities` option (similar to how `precomputedTrades` was
  introduced for the optimizer). This avoids the internal `loadPersonalities` call.
  Not urgent for current scale; worth doing if the EOD job ever becomes time-sensitive.

---

FINDING: No composite index covering (personality_id, status, entry_time) on paper_trades
Severity: Low
File and line: src/db/migrations/002_paper_trades_indexes.sql (existing); no new migration added
What it is: The `fetchDailyState` closed-trades query in `personality-filter.ts` filters on
  `personality_id = $1 AND status = 'closed' AND entry_time >= $2 AND entry_time < $3`.
  The existing `idx_paper_trades_personality_status (personality_id, status)` allows
  PostgreSQL to narrow to a specific personality's closed trades, then apply the
  `entry_time` range as a residual heap filter. This is correct and sargable (much
  better than the prior non-sargable DATE(...AT TIME ZONE...) predicate), but it
  means PostgreSQL still reads all closed trades for the personality before filtering
  by date. On a long-running system with months of closed trades, this set could grow
  to thousands of rows per personality.
Impact at scale: For a system running for 1 year at 10 trades/day × 250 trading days
  × 10 personalities = 25,000 closed rows total (2,500 per personality). At this
  scale the current index is adequate. At 10x (250,000 total rows), a sequential
  scan of one personality's closed trades could take a few milliseconds per signal
  check. Since `fetchDailyState` is called once per personality per signal, and
  there are roughly 1–2 signals per trading day, this remains acceptable. The fix
  is correct as-is.
How to fix it: Add `CREATE INDEX idx_paper_trades_personality_status_entry ON paper_trades
  (personality_id, status, entry_time DESC)` in a future migration. This makes the
  closed-trades query fully covering. Low priority for current phase.

---

## NEW MIGRATION REVIEW

---

Migration 014 (`src/db/migrations/014_signal_idempotency.sql`):

- Adds `sr_level_price NUMERIC` column to `straddle_signals` (nullable,
  idempotent via `ADD COLUMN IF NOT EXISTS`). This column is always populated
  non-null by the SR detection engine for PULLBACK signals (confirmed at line 670
  of `sr-detection-engine.ts`). Correct.

- Partial unique index `idx_straddle_signals_momentum_exhaustion_idem` on
  `(signal_type, time, underlying, atm_strike) WHERE signal_type = 'MOMENTUM_EXHAUSTION'`.
  The `time` column is the TimescaleDB partition column — index includes it.
  Satisfies TimescaleDB's requirement. The `ON CONFLICT DO NOTHING` in
  `peak-detection-engine.ts` correctly targets this constraint.

- Partial unique index `idx_straddle_signals_pullback_idem` on
  `(signal_type, time, underlying, atm_strike, sr_level_price) WHERE signal_type = 'PULLBACK'`.
  Includes `time` (partition column). `sr_level_price` is non-null for PULLBACK rows
  after this migration (the engine writes `String(level.price)` which is always
  defined for SR signals). Pre-migration PULLBACK rows with NULL `sr_level_price`
  do not participate in the unique constraint (SQL NULL != NULL in unique index
  semantics), which is correct and documented.

Both indexes support the ON CONFLICT pattern without bloat — they are partial
(filtered) indexes that only index the relevant signal type's rows, keeping index
size proportional to each signal type's volume separately. No concern.

---

Migration 015 (`src/db/migrations/015_paper_trades_underlying.sql`):

- `ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS underlying TEXT` — nullable,
  idempotent. Correct for backward compatibility.

- Backfill UPDATE with `CASE WHEN symbol LIKE 'NSE:BANKNIFTY%' THEN 'BANKNIFTY'
  WHEN symbol LIKE 'NSE:NIFTY%' THEN 'NIFTY' WHEN symbol LIKE 'BSE:SENSEX%' THEN
  'SENSEX'` — BANKNIFTY checked before NIFTY (correct, prevents 'NSE:BANKNIFTY...'
  being classified as NIFTY via substring match). Idempotent via `WHERE underlying IS NULL`.

- `CREATE INDEX IF NOT EXISTS idx_paper_trades_underlying_status ON paper_trades
  (underlying, status)` — supports the per-underlying open-leg count in
  `personality-filter.ts` and the per-underlying daily stop P&L sum in
  `portfolio-risk.ts` Rule 3. Both queries filter on `underlying = $N AND status = $M`,
  matching this index's leading columns. Correct and useful.

---

## straddle-calc.ts H1: Expiry Rollover Debouncing

Confirmed: `expiryRefreshInFlight` boolean flag at line 237 prevents concurrent
refresh calls. When the 15-second tick fires `resolveCurrentExpiry()` and
`needsRollover = true`, the async `config.resolveExpiry()` is launched ONCE
(`expiryRefreshInFlight = true`), reset in `finally` after completion or failure.
Any subsequent 15-second ticks during the async call see `expiryRefreshInFlight = true`
and skip the re-trigger. On success, `cachedExpiry` is updated and subsequent ticks
see `needsRollover = false` (new expiry is weeks away). On failure, `cachedExpiry`
stays unchanged and the next 15-second tick retries.

No per-tick I/O is introduced. The hot snapshot path at line 463 calls
`resolveCurrentExpiry()` which is synchronous — it reads the cached value or
triggers the debounced async refresh as a fire-and-forget side effect. No awaits
on the hot path.

The `resolveExpiry` closure in `index.ts` calls `getCurrentExpiryFromCalendar(underlying, pool, clock)`,
which issues `SELECT expiry_date FROM index_expiry_calendar WHERE underlying = $1 AND expiry_date >= $2 LIMIT 1`.
This is a small table with a selective predicate and `LIMIT 1` — the rollover DB
call is fast and occurs at most once per week per underlying.

---

## SUMMARY

| Severity | Count |
|----------|-------|
| Critical | 0     |
| High     | 0     |
| Medium   | 0     |
| Low      | 2 (new, introduced by fix cycle) |

Prior Critical (triple-redundant backtest + N+1 snapshots): RESOLVED
Prior High (non-sargable date predicate): RESOLVED
Prior Medium (duplicate COUNT): RESOLVED — confirmed semantically distinct
Prior Medium (per-personality JSON.parse): RESOLVED

New Low findings (2):
1. kernel_only fast path bypassed when precomputedTrades is supplied — in-memory only, no DB impact, negligible at current scale
2. loadPersonalities called twice per EOD run — 2 small queries vs prior 4, acceptable residual

---

## VERDICT: PASS

All prior Critical and High findings are genuinely resolved. The two new Low findings
introduce no additional database load and no regression in query patterns. The fix cycle
correctly addresses the root causes without introducing new performance regressions.

The one design note worth tracking: `trade-executor.ts` (`PaperTradeExecutor.openTrade`)
still does not populate the `underlying` column on INSERT. The router's UPDATE
(runs after openTrade) covers all personality-initiated trades, but until the INSERT
site is updated, a brief window exists where a trade row has `underlying = NULL`.
This creates a safe-fail gap (under-counts losses in per-index risk checks) that is
documented in the code and is not a new introduction from this fix cycle.
