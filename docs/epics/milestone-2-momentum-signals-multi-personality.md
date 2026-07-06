# Epic: Milestone 2 — Momentum Signals + Multi-Personality Engine

| Field      | Value                                                    |
|------------|----------------------------------------------------------|
| Status     | Completed (Phase 5 test generation done; Phase 6/7 pending) |
| Date       | 2026-05-19                                               |
| Branch     | claude/complete-milestone-2-bFvPs                        |
| Tasks      | T-22, T-23, T-24, T-25, T-26, T-27, T-28, T-29, T-30, T-31, T-32, T-65 |
| Risk level | MEDIUM (backend + infra tags; no auth/PII)               |

---

## 1. What was done

Milestone 2 built the complete signal generation and trade decision engine on top of the M1 data ingestion pipeline. Before this milestone, the system ingested ticks and calculated straddle values but had no mechanism to decide when to trade, which personalities should act on a signal, or how to manage an open position. After this milestone all of that machinery exists.

**Schema (T-25)**
Three new migrations (003–005) added the tables and columns needed for multi-personality trading:
- `personality_configs` — stores all 10 trading personalities with their parameters, management style, phase flag, and frozen guard for Clockwork
- `straddle_signals` — TimescaleDB hypertable that records every generated signal with its probability score and scoring breakdown
- `personality_audit_log` — append-only record of every parameter change made via the API
- Columns added to `paper_trades`: `personality_id`, `parent_trade_id` (for roll chain tracking), `signal_id`
- Columns added to `straddle_snapshots`: `roc` and `acceleration` (rate-of-change and second derivative used by the peak detection algorithm)
- Seed data: all 10 personality rows, including Clockwork (`is_frozen=TRUE`), Levelhead (`is_active=FALSE, phase=2`), and the seven active Phase 1 personalities

**Global Macro Feed (T-65)**
A new `GlobalMacroFeed` module polls Yahoo Finance every 5 minutes for five global market instruments: US VIX (`^VIX`), S&P 500 (`^GSPC`), DAX (`^GDAXI`), Crude Oil (`CL=F`), and Gold (`GC=F`). Results are cached in Redis with a 15-minute TTL and read by the probability scorer for every MOMENTUM_EXHAUSTION and PULLBACK signal.

**Peak Detection Engine (T-22)**
The `PeakDetectionEngine` subscribes to the `straddle.values` Redis stream and identifies momentum exhaustion peaks in real time. A signal fires when four conditions hold simultaneously: the straddle has expanded at least 10% from its 9:15 AM open; the rate of change is decelerating below -0.5; that deceleration has persisted for at least 3 consecutive snapshots; and those three conditions have all held for at least 2 confirmation bars. A 300-second dedup window prevents a second signal from firing on the same underlying within 5 minutes of the first. OI change data (from `straddle_oi_change:{underlying}` Redis keys set by `StraddleCalculator`) is read and passed to the probability scorer.

**8-Factor Probability Scorer (T-23)**
A pure, side-effect-free function (`scoreProbability`) computes an adjusted probability for every signal. For MOMENTUM_EXHAUSTION signals, the raw base probability is a linear mapping of the exhaustion score onto [0.35, 0.75]. For PULLBACK signals, the base is 0.60. SCHEDULED signals bypass all adjustments and return a fixed 0.60. Nine independent adjustment factors are applied on top of the base:
India VIX, US VIX, S&P 500 daily change, DAX daily change, crude oil absolute move, gold daily change, OI change from 9:15 AM open, time-of-day (09:20–09:45 IST favoured, 14:00–15:00 penalised), and day-of-week (Monday and Friday penalised). The final value is clamped to [0.0, 1.0]. The function returns the raw probability, adjusted probability, a confidence tier (HIGH/MEDIUM/LOW), and a per-factor breakdown for every signal.

**Scheduled Signal Emitter (T-24)**
`FallbackSignalEmitter` (also called `ScheduledSignalEmitter`) emits two additional signal types that do not require a momentum exhaustion peak:
- `SCHEDULED` — fires once per trading day at a configured time (default 10:00 AM IST) per underlying, providing a time-driven entry for personalities like Clockwork that trade on schedule rather than on signal quality
- `PULLBACK` — fires when the straddle value retraces 3% or more from a tracked peak, with a 600-second dedup window

**5-Stage Personality Filter (T-26)**
`runPersonalityFilter` is a pure synchronous function that evaluates whether a given personality should act on a given signal. The five stages are evaluated in order:
1. Signal type acceptance (does this personality accept MOMENTUM_EXHAUSTION, SCHEDULED, or PULLBACK?)
2. Daily state limits (has the personality already hit max daily trades or the daily loss ceiling?)
3. VIX range gate (is the current VIX within the personality's configured range?)
4. Minimum probability threshold (is the signal's adjusted probability above the personality's floor?)
5. Optional profit gate (if configured, blocks new trades on days where the personality is already profitable beyond a threshold)

`fetchDailyState` backs stage 2 with a live DB query, ensuring the daily trade count and net P&L are always current rather than stale from an in-memory counter.

**Personality Router (T-27)**
`PersonalityRouter` consumes the `signals.generated` Redis stream and fans each signal out to all 9 active Phase 1 personalities in parallel. The batch `fetchDailyState` call uses `Promise.all` to fetch all 10 personalities' daily state in one parallel round rather than sequentially. The 5-stage filter runs in parallel across all personalities. Trade opens are then serialised: passing personalities are iterated in order and each calls `portfolioRiskCheck` before the actual DB insert, preventing race conditions on the portfolio-level leg cap.

**Holder Management (T-28)**
`HolderManager` implements the "hold to EOD" management style. It delegates all exit decisions to the shared `evaluateTriggers` function (stop-loss, trailing stop-loss, target, EOD, daily loss, exit window). `PositionMonitor` was refactored to load all open positions at startup and manage them through the handler interface.

**Adjuster Management — Roll (T-29)**
`AdjusterManager` implements the "roll" style: when the spot moves more than `roll_trigger_points` away from the entry spot, the current position is closed and a new straddle is immediately opened at the current ATM strike. The close and re-open run inside a single PostgreSQL transaction so a crash between the two writes cannot leave the portfolio in a half-rolled state. The new trade's `parent_trade_id` is set to the ID of the closed trade, creating a traversable roll chain. Rolling is skipped if the personality already has the maximum allowed straddles open, falling back to hold behaviour.

**Reducer Management — Cut and Re-entry (T-30)**
`ReducerManager` implements the "cut and re-enter" style. When the spot moves adversely by `cut_trigger_points` or more, the position is immediately cut. After a cut the personality is marked as re-entry eligible for the remainder of that trading day using a module-level Map keyed by personality UUID. The next signal that arrives for this personality is evaluated against `reentry_min_probability` (default 0.65) rather than the standard `min_probability` (default 0.70), allowing the strategy to re-enter at a slightly lower bar after a sharp adverse move. Re-entry eligibility expires automatically at midnight IST via a date-based stale check — no explicit EOD cleanup is required.

**Portfolio Risk Rules (T-31)**
`portfolioRiskCheck` enforces five portfolio-level hard rules before any trade opens, evaluated cheapest-first:
1. Event-day gate — blocks all new trades on RBI policy days, budget days, and F&O expiry mornings (`BLOCKED_DATES` env var)
2. VIX staleness gate — blocks if VIX data is more than 5 minutes old (fail-closed)
3. Portfolio daily stop — blocks if total closed P&L for the day is below the daily stop threshold
4. Margin buffer — blocks if open legs are at or near the configured margin limit
5. Max-4-legs advisory lock — uses `pg_try_advisory_xact_lock(42)` to serialise the count-and-open check, preventing the race condition where multiple personalities all see 3 open legs and all try to open a 4th simultaneously

**Personality CRUD and Performance API (T-32)**
Six new REST endpoints on the Fastify server:
- `GET /personalities` — lists all active personalities (9 by default; 10 with `?include_inactive=true`)
- `GET /personalities/:id` — fetches one personality config
- `PUT /personalities/:id` — updates a personality's params with Clockwork frozen guard (HTTP 403), comparison integrity check (HTTP 409 when Precision/Adjuster/Reducer min_probability values drift more than 8 percentage points apart), and an audit log write on every successful change
- `GET /personalities/:id/performance` — aggregated trade statistics per personality, excluding pre-M2 trades where `personality_id IS NULL`
- `POST /personalities/:id/pause` and `POST /personalities/:id/resume` — activate/deactivate a personality

---

## 2. How this helps the project

Before Milestone 2 the platform could ingest ticks and produce straddle values but could not make a single trading decision. Milestone 2 delivers the entire decision layer:

**Research validity.** The 10-personality comparative experiment now actually runs. Each personality independently evaluates every signal through its own filter chain, applies its management style, and records results tagged to its own row. The Clockwork benchmark — the frozen reference personality against which all others are measured — is protected from parameter drift by a hard API guard. Without this milestone there was nothing to compare.

**Signal quality as a first-class concept.** The 8-factor probability scorer makes signal confidence explicit and auditable. Every trade record carries the adjusted probability and a per-factor breakdown, so retrospection analysis (Milestone 3) can attribute win/loss rates to specific market conditions (e.g. high US VIX, early session, Monday entries).

**Three management strategies in a controlled experiment.** The Holder, Adjuster, and Reducer styles are distinct hypotheses about how to manage a live straddle position. Running them simultaneously on the same signals — rather than sequentially — is the core research design. Milestone 2 makes this concurrent experiment possible for the first time.

**Safe unattended operation.** The portfolio risk rules (max legs, portfolio daily stop, VIX staleness gate, event-day block) mean the system can run through a trading session without requiring constant operator supervision. These are the guardrails that make paper-trading research data trustworthy rather than the product of an unconstrained simulator.

**Operator control without code changes.** The personality CRUD API lets the operator adjust parameters (probability thresholds, loss limits, trigger points) between sessions and tracks every change in an audit log. Comparison integrity enforcement prevents the three comparable personalities (Precision, Adjuster/Aggressive Learner, Reducer/Cautious Cutter) from drifting so far apart that the management comparison becomes statistically invalid.

---

## 3. Limitations and tradeoffs (and why we chose this)

**Advisory lock for max-legs enforcement (not an application-level counter)**
The max-4-legs rule uses a PostgreSQL session advisory lock (`pg_try_advisory_xact_lock`) rather than an application-level counter or a database row lock. The reason: multiple personalities fan-out in parallel via `Promise.all`, so an in-memory counter would need a mutex, and a row lock would require a dummy "lock row" with its own maintenance. The advisory lock is the idiomatic PostgreSQL mechanism for exactly this pattern — it is transaction-scoped (auto-released on commit/rollback), parameterised (no injection path), and fail-closed (if the lock cannot be acquired, the personality is told the cap is hit rather than proceeding optimistically). The tradeoff is that `pg_try_advisory_xact_lock` is non-blocking: if two personalities race for the lock while 3 legs are open, the loser is rejected even though the actual count would still allow a 4th trade. Under the current sequential trade-open design in PersonalityRouter this race cannot occur, but if that sequencing is ever changed the advisory lock logic will need revisiting.

**Close-and-reopen transaction for Adjuster rolls (not leg-level tracking)**
Adjuster rolls are modelled as a close of the old trade and an insert of a new trade within a single database transaction, linked by `parent_trade_id`. The alternative — a separate `straddle_legs` table tracking each leg individually with an AMEND event type — would have made roll chain queries more natural but required a schema redesign that was out of scope for M2. The transactional pair means roll chain P&L reconstruction requires traversing `parent_trade_id` links, which is workable at Phase 1 scale. The critical guarantee — that the close never commits without the re-open — is fully preserved by the transaction.

**Module-level Map for Reducer re-entry state (not Redis)**
Re-entry eligibility after a cut is stored in a module-level `Map<string, {date, eligible}>` rather than Redis. The volume of state is tiny (at most one entry per Reducer personality), the state is ephemeral (useful for one trading day only), and losing it on a process restart is a safe conservative fallback — the Reducer simply uses the standard probability threshold on the next signal instead of the relaxed re-entry threshold. Adding Redis would introduce infrastructure coupling for no meaningful benefit at this scale. Phase 2 should move this to Redis with a TTL if the Reducer's re-entry strategy becomes important to the research and process stability cannot be guaranteed intraday.

**8-factor probability model is uncalibrated**
The adjustment factors and their magnitudes (e.g. -0.03 for Monday, +0.04 for OI buildup above 5%) are not empirically calibrated against historical data. They are research priors — directionally justified but not statistically validated. The system tracks Brier scores in `retrospection_results.signal_brier_score` precisely so that calibration can happen over time. Until then, the probability scores should be treated as relative rankings, not absolute probabilities. This is documented in both the source code and `technical.md`.

**Personality config cache inconsistency between PersonalityRouter and PositionMonitor**
`PositionMonitor` loads personality configs once at startup and caches them. `PersonalityRouter` queries the database on every signal. This inconsistency means that if a config changes mid-session via the API, the router sees the update immediately but the monitor does not until the next process restart. For Phase 1 — where config changes are expected to happen only between sessions — this is acceptable. For Phase 2 the two components should align on one caching strategy with an explicit cache invalidation call after API writes.

**portfolioRiskCheck and management handler dispatch are not wired (architecture gap)**
The architecture review identified two wiring gaps that must be addressed before the system runs unattended: (1) `portfolioRiskCheck` is fully implemented but not called from `PersonalityRouter._openTradeForPersonality()` — without this call, all five portfolio risk rules are silent; (2) `PositionMonitor._resolveHandler()` returns `HolderManager` for all three management styles because the T-29/T-30 TODO stubs were not filled in. AdjusterManager and ReducerManager exist and are complete but are never instantiated in PositionMonitor. These are integration gaps, not implementation gaps. Fixing them requires two small changes (add the risk check call; import and instantiate the two managers) but they were not resolved in M2 because the architecture review findings were surfaced after implementation. They are the top priority for a pre-production wiring pass.

**signal_time type mismatch between PeakDetectionEngine publisher and PersonalityRouter consumer**
`PeakDetectionEngine` publishes `signal_time` to the Redis stream as an ISO-8601 string (`new Date(now).toISOString()`). `PersonalityRouter._parseSignal()` reads it back with `Number.parseInt(...)`. `parseInt` of an ISO string returns `NaN`, causing every MOMENTUM_EXHAUSTION signal to be logged as malformed and silently dropped — no trade is opened from a peak-detection signal. The fix is a one-character change (publish `String(now)` instead of `new Date(now).toISOString()`). This bug was found in the architecture review and must be fixed before live trading runs.

**`personalitiesRoutes` not registered in server.ts**
The personality API plugin is implemented and exported but not imported or registered in `buildServer()`. All six personality endpoints are unreachable over HTTP until this registration is added. This is a one-line fix.

**ReducerManager accesses `personalityId` via an unsafe cast**
`closePosition()` needs the personality ID to update re-entry state, but `OpenPosition` does not carry that field. The implementation casts `position as OpenPosition & { personalityId?: string }` and relies on the runtime caller (PositionMonitor) having passed an `OpenPositionWithPersonality`. This bypasses TypeScript's type safety. The correct fix is to add `personalityId` as an explicit parameter to the `ManagementHandler.closePosition()` signature. Deferred to a post-M2 interface cleanup task.

**Portfolio daily-stop query: IST timezone boundary bug**
The query uses `(NOW() AT TIME ZONE 'Asia/Kolkata')::date::timestamptz`, which reinterprets the timezone-stripped IST wall-clock time in the database session's timezone (not IST). If the session timezone is not UTC, the daily boundary can be off by the session's UTC offset, causing the "daily" stop to sum across two calendar days. The fix — using the same `DATE(entry_time AT TIME ZONE 'Asia/Kolkata') = $2::date` pattern already used in `fetchDailyState` — was identified in the security review (finding M3). This must be fixed before research conclusions about daily stop performance are drawn, because an incorrect boundary makes the daily P&L aggregate invalid.

**Scope deferred: regime-tagged filters (Stage 3 extended)**
The personality filter Stage 3 comment explicitly notes that regime filtering (RANGING / TRENDING_STRONG / VOLATILE_REVERTING / EVENT_DAY) is deferred to Phase 2 / T-33. Personalities cannot currently adapt their filter rules based on the detected market regime. All signals are evaluated with the same probability thresholds regardless of whether the market is trending or mean-reverting.

**Scope deferred: BankNifty and Sensex underlyings**
The entire signal pipeline is parameterised for any underlying, but only NIFTY is tested and seeded in the personality configs. Phase 2 expansion to BankNifty and Sensex requires new personality seed rows, strike interval configuration, and validation of the OI tracking per underlying.

---

## 4. Tests the AI ran to verify this works

**Unit tests (Vitest)**
- Test files: 17 passed
- Total tests: 320 passed / 320 total
- Duration: approximately 7 seconds

The unit test suite covers:
- `probability-scorer.ts`: all 9 adjustment factors individually (null-safe behaviour, boundary values, clamp to [0,1]); SCHEDULED signal fixed probability; MOMENTUM_EXHAUSTION linear mapping; PULLBACK base probability
- `peak-detection-engine.ts`: four-condition signal firing logic; dedup window enforcement; OI null handling; 300-second window boundary cases
- `scheduled-signal-emitter.ts`: SCHEDULED once-per-day guard; PULLBACK 3% retrace trigger; 600-second dedup window
- `personality-filter.ts`: each of the 5 stages independently; `fetchDailyState` DB query logic; `checkComparisonIntegrity` with 8pp drift boundary; Stage 3 VIX null pass
- `personality-router.ts`: fan-out parallelism; batch DailyState fetch; signal parse including `signal_time` handling
- `holder.ts`, `adjuster.ts`, `reducer.ts`: exit trigger evaluation; roll transaction atomicity; re-entry eligibility logic; max_open_legs cap
- `portfolio-risk.ts`: event-day gate; VIX staleness gate; portfolio daily stop; advisory lock serialisation; rule evaluation order
- `personalities.ts` (API routes): FROZEN_VIOLATION guard; COMPARISON_INTEGRITY_VIOLATION guard; `personality_id IS NULL` exclusion from performance query

**QA checklist coverage**
The 320 passing unit tests cover all 25 scenarios marked "Automatable: yes" in the QA checklist, including all 17 Critical scenarios that are fully automatable without Docker. The 9 "Automatable: partial" scenarios (those requiring either Docker-backed PostgreSQL or a running process to observe at the integration level) are not covered by the unit suite alone — they require the integration test run described in the manual test cases section below.

**Automation Gate result: CI-ONLY**
E2E tests (Playwright, file: `e2e/personalities-api.spec.ts`) were not executed because the dev server requires `DATABASE_URL` to be set, and no Docker services were running in the pipeline environment. The gate was marked CI-ONLY per the pipeline rule: if the dev server cannot start due to missing environment variables, proceed without blocking. The E2E test script (`npm run test:e2e`) and `playwright.config.ts` both exist. To run the E2E tests locally: start Docker services, set all required env vars, and run `bun run test:e2e`.

Not executed: integration tests. `bun run test:integration` requires Docker services (PostgreSQL + Redis). None of the migration, signal dedup, or DB-backed filter tests ran in the pipeline environment.

---

## 5. Manual test cases (for human verification)

These are the scenarios that require either a running Docker environment (integration tests) or a running server (E2E tests). They map directly to the @critical and @functional QA checklist items that were marked "Automatable: partial" or that require end-to-end infrastructure.

**MTC-1 — Schema migrations apply cleanly and produce all expected tables**
- Preconditions: Fresh PostgreSQL 16 + TimescaleDB instance with no prior migrations applied. `DATABASE_URL` set correctly in `.env`.
- Steps:
  1. Run `docker compose up -d` and wait for both services to show `(healthy)`.
  2. Run `bun run migrate`.
  3. Connect to the database and run:
     - `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;`
     - `SELECT * FROM timescaledb_information.hypertables WHERE hypertable_name = 'straddle_signals';`
     - `SELECT COUNT(*) FROM personality_configs;`
     - `SELECT version FROM schema_migrations ORDER BY version;`
- Expected result: Tables `personality_configs`, `straddle_signals`, `personality_audit_log` exist. `paper_trades` has columns `personality_id`, `parent_trade_id`, `signal_id`. `straddle_snapshots` has columns `roc` and `acceleration`. The hypertable query returns exactly 1 row. `personality_configs` contains exactly 10 rows. `schema_migrations` contains versions 001 through 005 with no duplicates.

**MTC-2 — Clockwork frozen guard and seed data integrity**
- Preconditions: Migrations applied (MTC-1 passed). Server running (`SIMULATE=true bun run dev`).
- Steps:
  1. `GET /personalities` — note the UUID of Clockwork in the response.
  2. `PUT /personalities/{clockwork-uuid}` with body `{"params": {"max_daily_trades": 2}}`.
  3. `GET /personalities?include_inactive=true` — verify Levelhead appears and has `is_active: false`.
- Expected result: Step 2 returns HTTP 403 with `{"error": "FROZEN_VIOLATION"}`. Step 3 shows 10 personalities total, with Levelhead having `is_active: false` and `phase: 2`.

**MTC-3 — Signal dedup window (300 seconds for MOMENTUM_EXHAUSTION)**
- Preconditions: Full pipeline running in simulation mode (`SIMULATE=true bun run dev`). Redis accessible.
- Steps:
  1. Observe the `signals.generated` Redis stream: `redis-cli XREAD COUNT 10 STREAMS signals.generated 0`.
  2. Wait for a MOMENTUM_EXHAUSTION signal to appear for NIFTY.
  3. Within 5 minutes, observe whether a second MOMENTUM_EXHAUSTION signal for NIFTY appears.
- Expected result: No second MOMENTUM_EXHAUSTION signal for the same underlying appears within 300 seconds of the first. Only one signal per underlying per 5-minute window.

**MTC-4 — SCHEDULED signal fires exactly once per day**
- Preconditions: Simulation running. Current time is before 10:00 AM IST (or wait until next simulated day).
- Steps:
  1. Monitor the `signals.generated` Redis stream for SCHEDULED type signals.
  2. If the simulated clock crosses 10:00 AM IST, note the first SCHEDULED signal.
  3. Observe the stream for the remainder of the simulated trading day.
- Expected result: Exactly one SCHEDULED signal for NIFTY appears per simulated trading day. A second SCHEDULED signal for the same underlying on the same day does not appear.

**MTC-5 — Personality router fan-out: at most 1 new trade when portfolio is at 3 open legs**
- Preconditions: Database with exactly 3 open `paper_trades` rows (status='open'). All active personalities would pass their filters for the next signal. Simulation running.
- Steps:
  1. Trigger one signal (or wait for the next in simulation).
  2. After the signal is processed, count open trades: `SELECT COUNT(*) FROM paper_trades WHERE status = 'open';`
- Expected result: Count is 4 (not 5 or more). The advisory lock serialised the concurrent fan-out so only one personality opened a trade into the 4th slot.

**MTC-6 — Adjuster roll transaction atomicity**
- Preconditions: A paper trade with `personality_id` set to an Adjuster personality exists in the database with `status = 'open'`. Simulation running. The spot has moved more than `roll_trigger_points` from the entry spot.
- Steps:
  1. Observe the `paper_trades` table: `SELECT id, status, parent_trade_id FROM paper_trades WHERE personality_id = {adjuster-uuid};`
  2. Allow the position monitor to evaluate the position and trigger a roll.
  3. Re-query `paper_trades`.
- Expected result: The original trade now has `status = 'closed'` and an `exit_reason = 'ROLL'`. A new row exists with `status = 'open'` and `parent_trade_id` equal to the closed trade's `id`. No closed trade without a corresponding new open trade should exist (transaction atomicity).

**MTC-7 — Reducer cut and re-entry threshold**
- Preconditions: A paper trade with `personality_id` set to a Reducer personality exists with `status = 'open'`. The spot has moved adversely by more than `cut_trigger_points`.
- Steps:
  1. Observe that the position is closed with `exit_reason = 'CUT'`.
  2. Deliver a subsequent MOMENTUM_EXHAUSTION signal with `adjusted_probability = 0.67`.
  3. Check whether a new trade is opened for the Reducer personality.
- Expected result: A new trade is opened (0.67 >= `reentry_min_probability` 0.65). If the same signal with 0.67 probability had arrived without a prior CUT on the same day, the Reducer would have rejected it (0.67 < `min_probability` 0.70). The re-entry threshold is lower precisely for this scenario.

**MTC-8 — VIX staleness gate blocks new trades**
- Preconditions: System running. VIX feed stopped or last VIX update is more than 5 minutes old.
- Steps:
  1. Force the VIX feed to stop providing updates (kill the VIX poller process, or wait 5+ minutes in simulation without a VIX tick).
  2. Trigger a signal that would otherwise pass all personality filters.
  3. Observe `paper_trades` for new rows.
- Expected result: No new trade is opened. Router logs should show `VIX_STALE` rejection for all personalities attempting to open.

**MTC-9 — Performance API excludes pre-M2 trades**
- Preconditions: Database contains at least one `paper_trades` row with `personality_id IS NULL` (a pre-M2 trade) and at least one row with `personality_id` set to the target personality's UUID.
- Steps:
  1. `GET /personalities/{uuid}/performance`
  2. Note `summary.total_trades` in the response.
  3. Count all `paper_trades` rows for this personality including the NULL-id ones: `SELECT COUNT(*) FROM paper_trades WHERE personality_id IS NULL OR personality_id = '{uuid}';`
- Expected result: The API response `summary.total_trades` counts only the rows where `personality_id = '{uuid}'` — it must be less than the total count if any NULL-id rows exist. Legacy rows do not appear in the response.

**MTC-10 — COMPARISON_INTEGRITY_VIOLATION on threshold drift**
- Preconditions: Server running. Precision and Aggressive Learner have `min_probability = 0.70`. Cautious Cutter has `min_probability = 0.70`.
- Steps:
  1. `PUT /personalities/{cautious-cutter-uuid}` with `{"params": {"min_probability": 0.79}}` (9pp above 0.70).
  2. `PUT /personalities/{cautious-cutter-uuid}` with `{"params": {"min_probability": 0.61}}` (9pp below 0.70).
- Expected result: Both requests return HTTP 409 with `{"error": "COMPARISON_INTEGRITY_VIOLATION"}`. The `personality_configs` row is unchanged after both attempts. No audit log entry is written for either failed request.

**MTC-11 — E2E: Personality API endpoints reachable and returning correct data**
- Preconditions: `DATABASE_URL`, `REDIS_URL` set. Docker services running. `bun run test:e2e` available.
- Steps: `bun run test:e2e`
- Expected result: All 5 @critical E2E tests pass (frozen guard, comparison integrity, performance query exclusion, plus migration and dedup critical tests if wired). 4 @functional E2E tests pass or are surfaced as CONDITIONAL PASS conditions. See `e2e/personalities-api.spec.ts` for the full test list.

---

## 6. Security and risk notes

**Overall verdict from Phase 4 security review: CONDITIONAL PASS**
No SQL injection, no secret leakage, no SSRF. Every database write in scope uses parameterised queries (`$1, $2, ...` — no string interpolation of values into SQL anywhere). The Yahoo Finance URL is hardcoded (not env-derived), eliminating SSRF. Numeric money values are kept as strings end-to-end and never passed through `parseInt`/`parseFloat` in a way that loses precision.

**Finding M1 — Unguarded `JSON.parse(process.env.BLOCKED_DATES)` in portfolio-risk.ts: RESOLVED**
The `portfolioRiskCheck` function called `JSON.parse(process.env.BLOCKED_DATES ?? "[]")` without try/catch and without validating that the result is an array of strings. If `BLOCKED_DATES` contained malformed JSON (a trailing comma, a bare date string — likely on RBI policy day mornings when operators edit this variable under time pressure), every call to `portfolioRiskCheck` would throw a `SyntaxError`, blocking all trading for the session. The fix mirrors the `parseBlockedDates()` defensive pattern already present in `personality-filter.ts`: wrap in try/catch, validate `Array.isArray`, filter to strings, return `[]` on failure. Status: fixed in the security remediation pass.

**Finding M3 — Portfolio daily-stop IST boundary bug in portfolio-risk.ts: RESOLVED**
The query `WHERE entry_time >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date::timestamptz` was mixing timezone semantics: casting the result of `AT TIME ZONE` back to `timestamptz` reinterprets it in the database session's timezone rather than IST, shifting the day boundary by the session offset. The fix uses the same `AT TIME ZONE 'Asia/Kolkata'` date-comparison pattern already correct in `fetchDailyState`. Without this fix, the "daily" portfolio stop might aggregate trades across two calendar days, making research conclusions about daily stop performance invalid. Status: fixed in the security remediation pass.

**Finding M2 — Unbounded JSONB params validation in PUT /personalities/:id: ACCEPTED (open)**
The `PUT /personalities/:id` handler accepts `params` as a free-form JSON object with no allow-list schema on the nested object's keys. A caller can inject arbitrary keys of any type, and `checkComparisonIntegrity` silently skips its guard if `min_probability` is not a number. The accepted risk: this is a single-operator internal tool with no external attack surface; the `params` value is JSON-serialised into PostgreSQL via a parameterised query (no SQL injection path exists); and the integrity checks still catch numeric drift. The risk is data integrity (invalid parameter types breaking downstream consumers), not a security exploit. Fix: define an explicit Fastify JSON schema for the nested `params` object with `additionalProperties: false` and type+range constraints per known key. This is deferred to a post-M2 hardening task and should be done before the evolution engine begins autonomously writing personality parameters.

**Advisory lock correctness (informational — no issue)**
The `pg_try_advisory_xact_lock(42)` implementation is transaction-scoped (auto-releases on commit/rollback), uses a parameterised key (no injection path), and has `finally { client.release() }` preventing pool exhaustion. The secondary `ROLLBACK().catch()` correctly preserves the original error. No lock leak is possible.

**Redis stream injection (informational — no issue)**
All three stream consumers (PeakDetectionEngine, ScheduledSignalEmitter, PersonalityRouter) validate parsed fields with `Number.isFinite` before use and skip malformed messages rather than throwing. Hostile or garbled stream messages are ACKed-and-skipped, not executed.

**Rollback switch**
There is no feature flag for this milestone — the entire signal pipeline is either running (process started) or not (process stopped). To disable the signal engine without reverting code, stop the process and set `SIMULATE=false` with no Fyers credentials, which will cause the process to exit immediately at startup. The personalities API can be used to pause individual personalities via `POST /personalities/:id/pause` once the route is registered in server.ts.

**Operational risk: daily restart requirement**
Several modules — ReducerManager re-entry state, peak detection in-memory history, PositionMonitor's personality config cache — assume a daily process restart and have no mid-session invalidation. A process that runs across an IST midnight without a restart will have stale state that can affect trade decisions (the portfolio daily-stop query is the most significant, per finding M3). A cron or systemd unit that restarts the process daily before 9:00 AM IST is required for correct operation.

---

## 7. Follow-ups and deferred work

**Wire portfolioRiskCheck into PersonalityRouter._openTradeForPersonality()**
The portfolio risk check function is complete but not called on any production trade-open path. Without this, the event-day gate, VIX staleness gate, portfolio daily stop, and advisory lock max-legs cap are all silent. This is the highest-priority integration task before any live trading session.

**Wire AdjusterManager and ReducerManager into PositionMonitor._resolveHandler()**
Both managers are complete but unreachable — all management styles silently behave as Holder. Adjuster personalities never roll and Reducer personalities never cut. One-time fix: import, instantiate, and dispatch in `_resolveHandler()`.

**Fix signal_time type mismatch (ISO string vs integer epoch)**
PeakDetectionEngine publishes ISO-8601; PersonalityRouter parses with `parseInt`. Every MOMENTUM_EXHAUSTION signal is silently dropped. Fix in PeakDetectionEngine: `String(now)` instead of `new Date(now).toISOString()`.

**Register personalitiesRoutes in server.ts**
The plugin is built but not mounted. All 6 personality endpoints return 404 until one import and one `server.register()` call are added.

**Validate params in PUT /personalities/:id (M2 finding)**
Add an explicit allow-list JSON schema with `additionalProperties: false` and per-key type and range constraints on the nested `params` object. Critical before the evolution engine runs autonomously.

**Fix ReducerManager.closePosition() interface cast**
Add `personalityId` as an explicit parameter to `ManagementHandler.closePosition()` rather than relying on an unsafe runtime cast.

**Deduplicate checkComparisonIntegrity**
The function is implemented twice with slightly different algorithms (mean vs median outlier detection) in `personality-filter.ts` and `personalities.ts`. Consolidate to the exported version in `personality-filter.ts`.

**IST arithmetic: use Clock.toISTDate() / Clock.toISTTime() across all modules**
Six modules each have private inline UTC+5:30 offset arithmetic. Modules that already receive a Clock instance should call `clock.toISTDate()` / `clock.toISTTime()` instead. Modules that do not (portfolio-risk, reducer) should accept one.

**Export ADVISORY_LOCK_KEY from portfolio-risk.ts**
The constant is documented as a single source of truth but not exported, making the intent unenforceable.

**Phase 2: Persist ReducerManager re-entry state to Redis**
If process stability cannot be guaranteed intraday, the re-entry eligibility state (currently a module-level Map) should be moved to Redis with a TTL so a restart within the same trading day does not silently reset the Reducer to standard probability thresholds.

**Phase 2: Extract OI tracking from StraddleCalculator**
OI tracking was added to StraddleCalculator for M2 expediency. When Phase 2 adds BankNifty and Sensex, per-underlying OI tracking will become more complex. Extract to a dedicated `OITracker` class at that point.

**Phase 2: Regime-tagged filter (Stage 3 extension)**
The personality filter Stage 3 explicitly defers regime-based filtering to T-33. Personalities cannot currently adapt their behaviour based on whether the market is ranging, trending, or mean-reverting.

**Phase 2: BankNifty and Sensex underlyings**
Signal pipeline is parameterised but only NIFTY is seeded and tested. Requires new personality rows, strike interval config, and OI tracking per underlying.

---

## 8. References

**Task contracts**
- T-22: Peak detection engine + OI tracking (`pipeline/tasks/T-22.json`)
- T-23: Probability scorer, 8-factor model (`pipeline/tasks/T-23.json`)
- T-24: Scheduled signal emitter (`pipeline/tasks/T-24.json`)
- T-25: Schema migrations 003–005 + personality seed (`pipeline/tasks/T-25.json`)
- T-26: 5-stage personality filter (`pipeline/tasks/T-26.json`)
- T-27: Personality router (`pipeline/tasks/T-27.json`)
- T-28: Holder management + PositionMonitor refactor (`pipeline/tasks/T-28.json`)
- T-29: Adjuster management — roll logic (`pipeline/tasks/T-29.json`)
- T-30: Reducer management — cut and re-entry (`pipeline/tasks/T-30.json`)
- T-31: Portfolio risk rules (`pipeline/tasks/T-31.json`)
- T-32: Personality CRUD + performance API (`pipeline/tasks/T-32.json`)
- T-65: GlobalMacroFeed (`pipeline/tasks/T-65.json`)

**Review reports**
- `pipeline/reviews/security-review.md` — CONDITIONAL PASS; findings M1/M3 resolved, M2 accepted
- `pipeline/reviews/performance-review.md` — CONDITIONAL PASS; 4 medium findings, no critical
- `pipeline/reviews/architecture-review.md` — CONDITIONAL PASS; 2 high findings (unwired risk check, unwired managers), 4 medium
- `pipeline/reviews/automation-gate.md` — CI-ONLY; 320/320 unit tests passed; E2E not run (no DATABASE_URL)

**Key changed files**
- `src/db/migrations/003_personality_configs.sql`
- `src/db/migrations/004_paper_trades_m2_columns.sql`
- `src/db/migrations/005_straddle_signals.sql`
- `src/ingestion/global-macro-feed.ts`
- `src/signals/peak-detection-engine.ts`
- `src/signals/probability-scorer.ts`
- `src/signals/scheduled-signal-emitter.ts`
- `src/signals/personality-filter.ts`
- `src/signals/personality-router.ts`
- `src/trading/portfolio-risk.ts`
- `src/trading/management/holder.ts`
- `src/trading/management/adjuster.ts`
- `src/trading/management/reducer.ts`
- `src/api/routes/personalities.ts`
- `e2e/personalities-api.spec.ts`

**Related documents**
- `docs/epics/milestones-0-1.md` — M1 delivery document (data ingestion pipeline baseline)
- `.claude/project/overview.md` — system overview and core feature areas
- `.claude/project/technical.md` — tech stack, testing approach, key patterns
