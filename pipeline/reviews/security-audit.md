# SECURITY AUDIT REPORT — Milestone 5 (M5)

Scope: `git diff c1b5b48..HEAD`, source files only (migrations 012/013, schema.ts,
sr-levels.ts, sr-detection-engine.ts, personality-filter.ts, personality-router.ts,
optimizer.ts, evolution-engine.ts, eod-retrospection-job.ts, instrument-registry.ts,
entry-engine.ts, portfolio-risk.ts, index.ts).

Context: single-instance research/paper-trading tool. No user auth, no sessions, no
payment code in this diff (per business.md the auth risk-flag is N/A). The audit
therefore focuses on SQL injection, schema/data-integrity, untrusted-input handling
(env + Redis stream payloads + broker symbols), backtest resource/leakage, and the
security-adjacent integrity invariants (Clockwork is_frozen guard, 8pp comparison rule).

Headline: **No SQL-injection vulnerabilities** — every new/changed query uses
parameterised placeholders; no string interpolation of caller/stream/env data reaches
SQL. The one dynamic `RegExp` build uses allowlisted enum values only. The serious
findings are **data-integrity / fail-open risk-control bypasses** introduced by a
schema mismatch in the M5 portfolio-risk and per-index leg-count queries, which the
unit tests cannot catch because they mock `db.query` entirely.

---

FINDING: Daily-stop and per-index leg-count query a non-existent / never-populated column → risk control is fully bypassed (fail-open)
Severity: Critical
File and line:
- `src/trading/portfolio-risk.ts:201-209` (daily-stop: `AND underlying = $4`)
- `src/signals/personality-filter.ts:203-210` (open-leg count: `AND ($2::text IS NULL OR symbol = $2)`)
- Schema of record: `paper_trades` (001_core_schema.sql:178-208, schema.ts:261-280) has
  `symbol TEXT NOT NULL` and **no `underlying` column**.

What it is: The M5 daily-stop query filters `paper_trades` on a column called
`underlying`. That column does not exist on `paper_trades` (it exists on
`straddle_signals` and `index_expiry_calendar`, not here). Against the real schema this
query will **throw** `column "underlying" does not exist`. Because the whole risk check
is wrapped so a thrown error propagates up to `_openTradeForPersonality`'s try/catch,
the symptom depends on the running schema — but in every case the per-(personality,
underlying) daily stop **does not actually evaluate realised P&L correctly**.

The sibling per-index leg-cap query in `fetchDailyState` filters on `symbol = $2` where
`$2` is the bare index name (`'NIFTY'`). But the executor writes the *full* prefixed
broker symbol or leaves `symbol` unset (paper-trade-executor.openTrade INSERT does not
even include `symbol`), and the router passes bare `'NIFTY'`. A bare `'NIFTY'` will
**never equal** a stored value like `NSE:NIFTY26528...`. So the open-leg count returns
zero rows, and the per-index leg cap silently never trips.

Why it matters: These are the two hard money-loss controls M5 reworked. A daily stop
that returns zero rows (or errors out) means a personality that has already blown its
daily loss limit on an index **keeps trading** — exactly the "fail-open risk-control
bypass" the implementor flagged, but the root cause is worse than the NULL case: the
column/value simply does not match, so the stop is inert for *all* rows, not only
legacy NULL ones. The leg cap is the guard against unbounded simultaneous positions;
inert, it permits more open straddles than configured. For a tool whose entire purpose
is risk-disciplined strategy research, a silently-disabled stop invalidates the very
data being collected and, on a future live path, would be a direct loss vector.

How to fix it:
1. Decide the canonical column. `paper_trades` has `symbol` (the tradable instrument
   string), not `underlying`. Either (a) add a real `underlying TEXT` column to
   `paper_trades` (new migration) and populate it on insert in
   PaperTradeExecutor.openTrade, then key both queries on `underlying = $N`; or (b) key
   on a normalised form of `symbol`.
2. Whatever column is chosen, ensure the executor INSERT actually writes it at open
   time (today openTrade omits `symbol` and `personality_id`; personality_id is patched
   by a later UPDATE in the router). Match the *exact* stored value to the query
   parameter — bare `'NIFTY'` vs `'NSE:NIFTY...'` must not differ.
3. Add a real database-backed integration test (not a mocked `db.query`) that opens a
   trade, closes it at a loss beyond the stop, and asserts the next entry on the same
   (personality, underlying) is blocked. The current `portfolio-risk-multi-index.test.ts`
   stubs `db.query` with `vi.fn()`, so it green-lights a query that cannot run against
   Postgres.

---

FINDING: `personality_id`-scoped daily stop treats NULL-personality rows as a separate book (NULL never matches `= $3`)
Severity: High
File and line: `src/trading/portfolio-risk.ts:201-209` (`AND personality_id = $3`),
schema `paper_trades.personality_id UUID` is **nullable** (004_paper_trades_m2.sql:13;
schema.ts:263 `personality_id: string | null`).

What it is (the implementor's flag #1): The daily-stop SUM is now scoped
`personality_id = $3`. SQL equality never matches NULL, so any `paper_trades` row with a
NULL `personality_id` is excluded from the realised-P&L sum. Pre-M2 rows are NULL by
definition, and even for M2+ flow there is a window where the row exists before the
router's follow-up `UPDATE ... SET personality_id` runs (the executor INSERT does not
set it). Losses booked on those rows do not count toward the stop.

Why it matters: This is the genuine fail-open the implementor identified. On its own
(if the `underlying` column problem above were fixed) it would still let realised losses
go uncounted, so the stop can be under-counted and a personality keeps trading past its
limit. It is High rather than Critical only because, once the Critical above is fixed,
the residual exposure is limited to NULL-personality rows; but in a fresh/migrated DB
those can dominate.

How to fix it:
- Treat NULL personality losses conservatively. Either backfill/forbid NULL
  `personality_id` for any row the stop must see (set it inside the INSERT
  transactionally, not via a later UPDATE), or make the predicate explicitly account
  for the intended semantics (e.g. only exclude NULL if you are certain those trades
  belong to no personality book). Do not rely on `= $3` silently dropping NULLs.
- Best: make `personality_id` NOT NULL going forward (new trades) and write it atomically
  at open time; keep a documented one-time exclusion for genuinely-orphan pre-M2 rows.

---

FINDING: SR-detection signal write trusts unbounded `level_source` JSONB and stream-derived numeric strings without range validation
Severity: Low
File and line: `src/signals/sr-detection-engine.ts:389-412, 590-659`.

What it is: `_handleSnapshot` parses the Redis `straddle.values` payload (external from
this module's perspective). It correctly rejects non-finite `time/spot/atmStrike/
straddleValue` and skips `straddleValue===0`. Values are then written parameterised
(`$1..$18`) — good, no injection. However `vix`, `spot`, `atmStrike`, `straddleValue`
are passed straight into NUMERIC columns as `String(...)` with no upper-bound / sanity
check, and `level_source` JSONB is `JSON.stringify`'d from computed levels. There is no
hostile producer here (the straddle calculator is internal), so this is defence-in-depth,
not an exploitable hole. The dedup map (`lastSignalPerLevel`) is keyed per level bucket
and bounded by the number of computed levels, so no unbounded-memory concern.

Why it matters: If a malformed or out-of-range snapshot ever reaches the stream (bug
upstream, replay of corrupt data), it would be persisted as a signal row verbatim. Low
impact for a single-instance research tool, but worth a bound.

How to fix it: Add cheap range asserts (e.g. `spot > 0 && spot < 1e7`,
`straddleValue >= 0`) alongside the existing finiteness guard, and continue treating any
out-of-range field as a malformed message (return early). No change needed to the
parameterisation, which is already correct.

---

FINDING: 013 expiry-calendar seed data is human-unverified and the table has no weekday/holiday-shift integrity constraint
Severity: Low
File and line: `src/db/migrations/013_index_expiry_calendar.sql:38-124`.

What it is: The table is well-formed (composite PK, NOT NULL, sane defaults, idempotent
`ON CONFLICT DO NOTHING`). No injection or DDL safety issue. Two integrity gaps: (1) the
seeded expiry dates are explicitly flagged in-file as not verified against the live
NSE/BSE calendar and assume no holidays in the window — `getCurrentExpiryFromCalendar`
trusts these dates as the source of truth for which contract to trade; (2) there is no
constraint that `expiry_date` falls on the documented weekday for the underlying, so a
typo'd seed row (e.g. a NIFTY expiry on a Wednesday) is accepted silently.

Why it matters: A wrong expiry date drives `buildOptionSymbol`, i.e. which option
instrument the system believes it is paper-trading. This is a correctness/data-integrity
issue rather than a security breach. The code does hard-fail (`CalendarExpiredError`)
when the calendar runs dry, which is the right safety posture — that part is good.

How to fix it: Before any production/live use, verify the seeded dates against the
exchange calendar (already called out in the migration comment — keep that gate). Optional
hardening: a CHECK or a seed-time assertion that each row's weekday matches the
underlying's documented expiry weekday unless `is_holiday_shifted = TRUE`.

---

## Items explicitly checked and found SOUND (no finding)

- **SQL injection (all M5 queries):** parameterised throughout — optimizer.ts
  (fetchTrainingRows holdout subquery, personality SELECT, FOR-UPDATE lock),
  evolution-engine writeProposal/writeApplied (metricsDesc/reason go in as `$4`, never
  interpolated), sr-levels.ts (fetchOHLCV / fetchTicksForPOC / countHistoryBars),
  instrument-registry.ts (getCurrentExpiryFromCalendar, assertCalendarFreshness),
  personality-router.ts (_loadActivePersonalities `phase <= $1`, reconcile,
  personality/signal UPDATE), eod-retrospection-job.ts. No string-concatenated SQL,
  no dynamic table/column/ORDER BY built from external input.
- **`validateSimSymbol` dynamic RegExp** (instrument-registry.ts:547): interpolates
  `prefix` and `underlying`, but both come only from the allowlisted `EXCHANGE_PREFIXES`
  map / `Underlying` enum — not attacker-controlled. No ReDoS-relevant unbounded
  backtracking in the pattern. Safe.
- **Env-var parsing** (index.ts parseActiveIndices, entry-engine, personality-router,
  sr-detection-engine readSRConfigFromEnv, portfolio-risk thresholds, optimizer
  constants): all use allowlist (INDICES against VALID_UNDERLYINGS), finiteness checks,
  and safe defaults; malformed `BLOCKED_DATES` JSON is caught and treated as empty. No
  crash-on-bad-config, no value reaching SQL/shell. `ACTIVE_PHASE` read fresh per
  snapshot is finiteness-guarded and defaults to 1 (fail-safe to "no Phase-2 signals").
- **Clockwork `is_frozen` guard:** optimizer.ts throws `FROZEN_VIOLATION` both before
  reads (line 808) and again inside the SELECT-FOR-UPDATE transaction (line 983);
  evolution-engine likewise (line 481). Throw-not-skip preserved. The optimizer's
  comparison-group lock filters to `entry_type='momentum_exhaustion' AND is_active`,
  correctly excluding sr_anchored from the 8pp peer set.
- **8pp comparison-integrity cap:** optimizer routes its proposal through the same
  `applyIntegrityCap` against the locked peer set (line 1012); no bypass introduced.
- **Backtest resource / DoS:** runOptimizer triggers ONE backtest, gated behind
  MINIMUM_SAMPLE_STABLE (200 retrospection rows); the EOD job runs personalities
  sequentially with worker concurrency=1; backtest-runner queries are time-bounded
  (`time >= $2 AND time < $3`) so no hypertable full scan. Bounded.
- **Holdout / data-leakage (integrity):** fetchTrainingRows excludes the most-recent
  N rows via `trade_date NOT IN (SELECT ... ORDER BY trade_date DESC LIMIT $2)`, and
  scoreFinalists hard-filters to `split==='train'` before scoring. The holdout/test
  splits are never read during training. Correct.
- **Hardcoded `adjustedProbability=0.7` in the backtest runner** (implementor flag #2):
  this makes finalist scoring inert (all candidates ≤0.70 tie), which is a
  correctness/efficacy issue for architecture — it has **no security or integrity
  dimension** (it cannot bypass a guard, leak data, or escalate anything; the optimizer
  still routes through clamp + 8pp cap + cooldown + frozen guard + approval gate).
  Deferring to architecture review as instructed.

---

SUMMARY
Critical: 1
High    : 1
Medium  : 0
Low     : 2
Overall verdict: FAIL

Rationale: The two M5 portfolio-risk / leg-count queries reference a column that does
not exist on `paper_trades` (`underlying`) and match on a value that cannot equal stored
data (`symbol = 'NIFTY'`), and the daily stop additionally drops NULL-`personality_id`
rows. The net effect is that the per-index daily stop and per-index leg cap — the two
hard money-loss controls reworked in M5 — are fail-open and unenforced against the real
schema, and the all-mocked unit tests cannot detect this. These are blocking. Once the
column/value mismatch and NULL handling are fixed and verified with a real-DB
integration test, the remaining items are Low and the verdict can move to PASS.
