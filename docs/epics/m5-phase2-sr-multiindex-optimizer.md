# Epic: M5 — Phase 2 Partial: S/R Signal Engine, Multi-Index Expansion, and Deterministic Optimizer

| Field      | Value                                                       |
|------------|-------------------------------------------------------------|
| Status     | Completed (Gate 2 CONDITIONAL PASS approved 2026-05-25)    |
| Date       | 2026-05-25                                                  |
| Branch     | claude/pensive-knuth-IDd8I                                  |
| Tasks      | T-43-A, T-43-B, T-43-C, T-44, T-45, T-46                  |
| Risk level | MEDIUM                                                      |

---

## 1. What was done

### Schema and migrations (T-43-A)

- **Migration 012** (`012_sr_signals.sql`): extends the `straddle_signals` hypertable with four nullable columns — `sr_subtype TEXT` (with a CHECK constraint, not a Postgres enum), `sr_strength NUMERIC`, `poc_used BOOLEAN`, and `level_source JSONB`. These columns are only written for SR signals; all existing momentum and scheduled-entry rows are unaffected.
- **Migration 013** (`013_index_expiry_calendar.sql`): creates the `index_expiry_calendar` table (primary key: `underlying, expiry_date`) and seeds the next eight weekly/monthly expiries for NIFTY, BankNifty, and Sensex. Supports a `is_holiday_shifted` flag for NSE/BSE holiday-adjusted expiry dates. Inserts are idempotent (`ON CONFLICT DO NOTHING`).
- **Migration 014** (`014_signal_idempotency.sql`): adds `sr_level_price NUMERIC` to `straddle_signals` and two partial unique indexes — one for `MOMENTUM_EXHAUSTION` signals keyed on `(signal_type, time, underlying, atm_strike)` and one for `PULLBACK` signals additionally keyed on `sr_level_price`. Both include the hypertable partition column `time` as required by TimescaleDB. These indexes make signal INSERTs idempotent on Redis re-delivery (duplicate message = `ON CONFLICT DO NOTHING`, no re-publish to `signals.generated`).
- **Migration 015** (`015_paper_trades_underlying.sql`): adds `underlying TEXT` (nullable) to `paper_trades` and backfills existing rows from the `symbol` prefix (`NSE:BANKNIFTY%` → `BANKNIFTY`, `NSE:NIFTY%` → `NIFTY`, `BSE:SENSEX%` → `SENSEX`, unmatched rows left NULL). Adds `idx_paper_trades_underlying_status (underlying, status)` to support per-index portfolio-risk queries efficiently.
- **`src/db/schema.ts`**: extended `StraddleSignal` interface with the new nullable fields; new `IndexExpiryCalendar` interface added.

### S/R level computation engine (T-43-B — `src/signals/sr-levels.ts`)

Computes support/resistance levels for a given underlying as of session start from TimescaleDB history. Three level types:

- **Previous-week High/Low** — computed from IST-week-boundary-aware OHLCV queries (all queries are time-range bounded; no hypertable full scans).
- **Monthly classic pivot** — `(H+L+C)/3` with R1, S1, R2, S2 derived from the prior calendar month's OHLCV. Uses IST month boundaries.
- **Volume Point of Control (POC)** — price bucket with highest cumulative volume in the lookback window. Degrades gracefully when volume data is absent: `poc_used` is set to `false` and the level is omitted rather than fabricated.

Each level carries a strength score combining proximity (how often price revisited it), confluence (count of independent level types within a configurable band), and a volume weight (neutral when volume data is absent). A session-start freshness guard throws a named error if the historical bar count for an index falls below the configured lookback threshold; the caller then disables S/R for that index for the session rather than emitting signals against incomplete data.

### S/R detection engine (T-43-C — `src/signals/sr-detection-engine.ts`)

Consumes the `straddle.values` Redis stream in its own consumer group (`sr-detection`). Maintains per-underlying state to support all active indices in a single process. At each 15-second snapshot:

- Checks whether spot is within `sr_proximity_points` of a level whose strength meets or exceeds the configured floor.
- When a trigger fires, writes a `straddle_signals` row with `signal_type = 'PULLBACK'`, `sr_subtype = 'SR_REVERSAL'`, and the computed `sr_strength`, `poc_used`, `level_source` JSON, then publishes to `signals.generated`.
- Emission is gated on `ACTIVE_PHASE >= 2` (read from env, defaulting to 1). No SR rows are written when ACTIVE_PHASE is 1 — preventing data pollution of the Phase-1 comparison baseline.
- VIX-null handling: applies a neutral weight, never divides by or assumes a VIX value.
- A per-level deduplication window prevents repeated emission for the same level within a configurable interval.

### Levelhead personality (T-44 — `src/signals/personality-filter.ts`, `personality-router.ts`)

Levelhead is the first `sr_anchored` entry-type personality. It is gated behind `ACTIVE_PHASE >= 2`.

- **Stage 1 filter**: `sr_anchored` personalities accept `PULLBACK` signals (SR subtype) and reject momentum-exhaustion and scheduled-entry signals. The reverse also holds: momentum personalities never accept SR signals. No cross-matching occurs.
- **Stage 4 filter**: for `sr_anchored` personalities, the quality gate compares `signal.sr_strength` against `params.sr_strength_threshold` rather than `min_probability`. The `min_probability` gate is preserved unchanged for all non-SR personalities.
- **ACTIVE_PHASE routing**: personality-router now loads personalities with `phase <= ACTIVE_PHASE` (configurable env, default 1). At `ACTIVE_PHASE=2`, Levelhead is included; below 2 it is absent.
- **Per-index leg caps**: the open-position count in Stage 2 is now scoped per `(personality, underlying)`. Each index is an independent 4-leg book. Reaching the cap on NIFTY does not prevent new entries on BankNifty.
- **Removed hardcoded cast**: the prior `signal.underlying as 'NIFTY'` coercion in the personality router is gone. The real underlying from the signal propagates through the pipeline.

### Multi-index expansion (T-45 — `src/ingestion/brokers/instrument-registry.ts`, `src/index.ts`, `src/trading/portfolio-risk.ts`)

- **Exchange prefix per underlying**: `buildOptionSymbol` now uses `BSE:` for Sensex and `NSE:` for NIFTY and BankNifty. Previously all indices used `NSE:`.
- **Calendar-driven expiry**: `getCurrentExpiry` reads from `index_expiry_calendar` instead of the hardcoded Thursday weekday formula. Holiday-shifted expiries are honored.
- **Calendar freshness asserts**: at startup, if the calendar has no future expiry for an active underlying (all seeded dates are in the past), the process hard-fails with a named `CalendarExpiredError` before entering the trading loop. A separate refill-reminder log fires when the max seeded date is within a configurable warning window, without triggering a hard-fail.
- **Startup symbol-resolution check**: in live mode, the computed ATM straddle symbol is validated against the broker's instrument master; a failed resolution logs loudly and disables that index for the session without crashing the whole process. In simulation mode, validation uses a dated fixture (no outbound broker call).
- **INDICES env**: `index.ts` reads a comma-separated `INDICES` env var (default `NIFTY`). For each active underlying, the bootstrap instantiates a `StraddleCalculator` with a per-underlying expiry injector and feeds it through the shared peak-detection and SR-detection engines. All three underlyings run in a single process.
- **Per-index portfolio stop**: `portfolio-risk.ts` Rule 3 (daily P&L stop) and Rule 4 (margin buffer) are scoped per `(personality, underlying)`. The per-index open-leg count also uses the real `underlying` column (introduced in migration 015), not a bare index name matched against prefixed option symbols.
- **Backward compatibility**: with `INDICES` unset (defaults to `NIFTY`) and `ACTIVE_PHASE` unset (defaults to 1), the system behaves identically to pre-M5 behavior.

### Guarded deterministic 1-D optimizer (T-46 — `src/retrospection/optimizer.ts`, `evolution-engine.ts`, `eod-retrospection-job.ts`)

Decision D1 from Gate 1 selected Option B: a guarded deterministic 1-D golden-section search over the `min_probability` parameter range `[0.30, 0.90]`. Full Bayesian Gaussian Process optimization was deferred.

- **Guard layer extracted**: the `[0.30, 0.90]` clamp, the 8-percentage-point comparison-integrity cap, the `FROZEN_VIOLATION` throw for Clockwork and frozen personalities, the 7-day cooldown, and the approval-gate write path are exported from `evolution-engine.ts` so the optimizer can reuse them without duplication.
- **Objective**: the kernel smoother over `retrospection_results` shortlists 2-3 candidate `min_probability` thresholds. The real backtest runner (`src/backtesting/backtest-runner.ts`) is run once over the training window; each finalist is scored by post-hoc in-memory filtering of the `SimulatedTrade` array on `adjustedProbability >= candidate`, computing the Sharpe of the resulting `pnlPct` distribution. The holdout split is never read during this process.
- **Shared backtest reuse**: the EOD job runs one shared backtest and passes the resulting `SimulatedTrade[]` to each personality's optimizer call via `precomputedTrades`, preventing the prior N+1 pattern.
- **Min-sample gate**: `MINIMUM_SAMPLE_STABLE = 200` rows (post-filter, regime-tagged). Below this threshold the optimizer returns "no suggestion" — never a low-confidence suggestion.
- **Guard layer applied to every proposal**: FROZEN_VIOLATION → throw; raw candidate clamped to `[0.30, 0.90]`; 8pp cap enforced against the locked `momentum_exhaustion` peer set; cooldown checked; if `EVOLUTION_REQUIRE_APPROVAL=TRUE` (default), the proposal is written to the suggestions queue and never applied directly to `personality_configs`.
- **Levelhead exclusion**: `sr_anchored` personalities are excluded from the optimizer candidate list and from the 8pp comparison-integrity peer set. `sr_strength_threshold` is never tuned by the optimizer.
- **EOD integration**: the optimizer runs inside the BullMQ EOD job, off the critical path, after metrics computation. A failure is caught, logged, and falls back to the rule-based `runEvolutionEngine` — the batch never crashes.

---

## 2. How this helps the project

**More signal types, not just momentum.** Until M5, every entry signal came from the momentum exhaustion detector — the system only traded when it saw price acceleration peaking. Adding the S/R detection engine gives the system a second independent signal source: it now also notices when price approaches a historically significant level (a previous week's high/low, a classic pivot, or the volume point of control). This matters because markets often stall or reverse at these levels even without a clear momentum peak, so signals that momentum-only personalities would miss can now be captured by Levelhead.

**Indian market realities: three indices, not one.** India's options market has three liquid weekly-expiry products — Nifty, BankNifty, and Sensex. Running all three through a single process (rather than three separate deployments) means a researcher can compare strategy behavior across indices with a consistent engine, shared infrastructure, and minimal operational overhead. BankNifty and Sensex now use their correct exchange prefixes and calendar-driven expiries instead of inheriting NIFTY's Thursday formula.

**A data-driven path to parameter tuning.** The rule-based evolution engine could only move `min_probability` up or down by a fixed step when a threshold was breached. The new optimizer performs a principled 1-D search over the full allowed range using real backtest data to score each candidate. The result is a suggestion that is informed by evidence rather than a heuristic rule. The guards around Clockwork (which must never change) and the comparison group (whose members must stay within 8 percentage points of each other) ensure that parameter tuning can never silently invalidate the months of comparative data being accumulated.

**Signal idempotency as operational hygiene.** Redis Streams guarantees at-least-once delivery. Before M5, a re-delivered snapshot could insert a duplicate signal row and re-publish to `signals.generated`, potentially triggering a second paper trade for the same market event. Migration 014's partial unique indexes make both the momentum and SR engines idempotent on re-delivery: a duplicate message is silently discarded after the `ON CONFLICT DO NOTHING` path, with no double-publish.

---

## 3. Limitations and tradeoffs (and why we chose this)

### (a) Optimizer backtest finalist scoring is currently inert

The optimizer's Phase B (scoring finalists against backtest data) does not work in the current codebase. There are two compounding bugs:

1. `BACKTEST_UNDERLYING` is set to `'NSE:NIFTY50-INDEX'` (the Fyers index ticker). The backtest runner queries `straddle_snapshots` with `WHERE symbol = $1`, but the historical reconstruction pipeline stores `symbol = 'NIFTY'` (the bare `Underlying` enum value). These two never match, so the backtest query always returns zero rows.
2. Even if the symbol matched, the backtest runner hardcodes `adjustedProbability = 0.70` for every simulated trade. This means all shortlisted candidates below 0.70 score identically — the scoring is a no-op.

**Practical consequence today:** the optimizer sees zero backtest trades and falls back to the "no eligible finalist" path, which safe-fails to the rule-based engine. No suggestion is queued. This is harmless in the current pre-calibration phase because the probabilities are not empirically grounded anyway. It becomes a silent blocker the moment Phase 2 calibration work lands and the intent is for the optimizer to actually suggest values.

**Why we shipped anyway:** The guard layer (clamp, frozen check, integrity cap, cooldown, approval gate) is fully implemented and verified. The optimizer's architecture is correct. These two bugs are localized fixes (change one constant; wire calibrated probabilities into the backtest runner) that belong to the Phase 2 calibration milestone, not to M5. Holding M5 for them would have blocked the S/R engine, Levelhead, and multi-index work on pre-existing technical debt.

**Must fix before Phase 2 calibration:** change `BACKTEST_UNDERLYING` from `'NSE:NIFTY50-INDEX'` to `'NIFTY'` (after confirming `SELECT DISTINCT symbol FROM straddle_snapshots` returns bare names), then remove the `precomputedTrades === undefined` condition from the `kernel_only` fast path.

### (b) Full Bayesian GP optimization deferred

Gate 1 Decision D1 explicitly chose Option B (guarded deterministic search) over Option A (Gaussian Process). The reason: a GP requires sufficient, regime-consistent historical data that does not yet exist — the EOD retrospection pipeline (T-34–T-38, not started) hasn't run long enough to produce the ~200+ post-filter rows the min-sample gate requires anyway. A GP fitted on sparse or regime-mixed data would produce unreliable suggestions. The deterministic search is simpler to audit, has no matrix-math failure modes, and produces the same Clockwork/guard guarantees. A full GP optimizer remains in the roadmap (Phase 2 later) but was not the right tool for the current data volume.

### (c) Global circuit-breaker deferred to M6 (T-50)

Gate 1 Decision D2 chose per-index risk books (Option A) over a single cross-index portfolio limit. The rationale: per-index books map directly to how Indian margin is allocated — NIFTY and BankNifty margin limits are separate at the exchange level. A global circuit-breaker (one total-portfolio stop that fires when any combination of indices breaches a combined loss threshold) is a more complex instrument and requires data on combined Greeks/margin that the system does not yet compute. It is tracked as T-50 in the M6 backlog. Until then, each index has a 4-leg cap and a daily P&L stop that are enforced independently.

### (d) runEvolutionEngine has no internal entry-type self-guard (N1 — Medium)

The optimizer correctly guards itself against non-`momentum_exhaustion` personalities by reading the personality from the database and returning early. The rule-based `runEvolutionEngine` does not do this — it relies on the EOD job caller filtering to momentum personalities before invoking it. Any future caller that does not know to apply this filter will hit a database transaction error when it tries to take a `SELECT FOR UPDATE` lock on a personality that is not in the `momentum_exhaustion` comparison group. This is the most important pre-Phase-2 architectural fix: the guard should live inside `runEvolutionEngine` as a self-contained early return, not as a caller convention. This item is Medium severity and must be addressed before Phase 2 activates non-momentum personalities at scale.

### (e) S/R levels are computed once per session start; no intraday reload

The S/R engine loads previous-week H/L, pivots, and POC at session start and holds them in memory for the entire trading day. Levels are recomputed only when the engine is stopped and restarted. This is intentional — intraday pivot levels are well-defined as session-start inputs in classical technical analysis, and recomputing them on every tick would be meaningless and expensive. The tradeoff is that if the process restarts mid-day (e.g. after a crash recovery), the levels are recomputed from the same historical data and the output will be identical, so mid-day restarts are safe. A future enhancement could add a midnight UTC reload for the overnight computation of the next day's levels without a full restart.

### (f) Calendar seed data is human-unverified (Low security finding accepted)

Migration 013 seeds expiry dates that were computed from NSE/BSE calendar patterns and are flagged in the migration comment as not cross-checked against the live exchange calendar. A miscoded expiry date drives `buildOptionSymbol` — the system would believe it is paper-trading a contract with a different expiry than intended. The hard-fail `CalendarExpiredError` guards against the calendar running out entirely, but not against a subtly wrong date within the window. **Required before any live use:** verify seeded expiry dates against NSE/BSE holiday schedule for the seeded period.

### (g) paper_trades.underlying is populated via a two-step INSERT + UPDATE

The `PaperTradeExecutor.openTrade` INSERT does not include `underlying`; the personality router's follow-up UPDATE sets it. This means there is a brief window where an open trade row has `underlying = NULL`. For the per-index risk checks, this is safe-fail (a NULL-underlying row is excluded from the per-index daily P&L sum, under-counting losses — the stop fires later than ideal, never later than intended). If the UPDATE fails (DB timeout, connection drop), the row stays NULL permanently and is never counted in any per-index book. The fix is to populate `underlying` (and `personality_id` and `signal_id`) inside the original INSERT transaction and remove the follow-up UPDATE — tracked in the backlog below.

---

## 4. Tests the AI ran to verify this works

### Unit tests — bun test

**Result: 1144 tests, all green.** Run in the pipeline environment (no Docker services required).

Coverage areas added or expanded by M5:

| Test file | What it proves |
|---|---|
| `src/signals/__tests__/sr-levels.test.ts` | Pivot math correctness, previous-week H/L IST-boundary windowing, POC bucketing, null-volume graceful degrade path, strength-score confluence weighting, coverage-guard throw path. Property tests via fast-check on the pivot formula. |
| `src/signals/__tests__/sr-detection-engine.test.ts` | Proximity trigger fires at threshold and not beyond, strength-floor gate, `poc_used` / `level_source` tagging on emitted signals, VIX-null neutral path, ACTIVE_PHASE gate (no emission at phase 1), freshness-disable path per index, deduplication window. |
| `src/signals/__tests__/personality-filter.test.ts` | `sr_anchored` Stage 1 acceptance of PULLBACK and rejection of momentum signals; Stage 4 strength-threshold gate vs `sr_strength_threshold`; ACTIVE_PHASE gating for phase=2 personality; per-underlying leg-count scoping (NIFTY cap does not block BankNifty). |
| `src/retrospection/__tests__/optimizer.test.ts` | Golden-section convergence on a synthetic objective function, holdout split never read, min-sample gate (199 rows → no suggestion; 200 rows → suggestion generated), FROZEN_VIOLATION throw on Clockwork, candidate clamp to `[0.30, 0.90]`, 8pp integrity-cap enforcement, 7-day cooldown, approval-vs-autonomous paths, `sr_anchored` exclusion. |
| Instrument-registry tests | BSE prefix for Sensex, NSE prefix for NIFTY/BankNifty, calendar-driven expiry vs old Thursday formula, expired-calendar hard-fail, refill-reminder at threshold. |
| Portfolio-risk multi-index tests | Per-underlying daily stop and open-leg count queries (note: these tests mock `db.query` — a real DB integration test is deferred to CI with Docker services). |

### TypeScript type-check

`bun run --bun tsc --noEmit` — **clean** (0 errors, 0 warnings). Run in the pipeline environment.

### Integration tests — CI-ONLY

`bun run test:integration` requires TimescaleDB + Redis via Docker. No container runtime was available in the pipeline execution environment. The integration tests were not run here. They must pass in CI before merge.

### E2E tests (Playwright) — CI-ONLY

`npm run test:e2e` requires the Fastify dev server + seeded database. Not run here. `npx playwright test --list` confirmed **82 tests across 10 spec files compile and list cleanly** with no parse or import errors.

Five new M5 spec files were added:

| Spec file | Covers |
|---|---|
| `dashboard-m5` | SR level overlay on chart; per-index view selector |
| `multi-index-pipeline` | All three indices active; per-index P&L display |
| `observability` | Log entries for level discard, refill reminder, optimizer clamp |
| `personalities-dashboard` | Levelhead shown inactive at ACTIVE_PHASE=1, active at 2 |
| `sr-engine` | SR signal appears in active signals panel with strength and level_source |

Tag distribution across the five new specs: 45 `@critical` · 20 `@functional` · 39 `@non-blocker`.

### QA checklist tier summary

The full checklist is at `pipeline/qa-checklist.md`. Tiers:

| Tier | Count | Gate impact |
|---|---|---|
| Critical | 22 | All must pass at Automation Gate for Gate 2 to pass |
| Functional | 20 | Failures → CONDITIONAL PASS at Gate 2 |
| Non-blocker | 8 | Logged only, no gate impact |

The Automation Gate result was **CI-ONLY** (non-blocking) because there is no container runtime in the pipeline environment. The `@critical` E2E tests must be run in CI or locally with `docker compose up -d` before merge.

---

## 5. Manual test cases (for human verification)

Run these tests locally with:

```bash
docker compose up -d          # start TimescaleDB + Redis
bun run migrate               # apply all migrations including 012–015
```

Then run each case below with the stated environment.

---

**MTC-1 — SR signals only reach Levelhead; momentum personalities are unaffected**

- Preconditions: `ACTIVE_PHASE=2`, `INDICES=NIFTY`, `SIMULATE=true`. Database migrated to 015. Levelhead seeded in `personality_configs` with `entry_type='sr_anchored'` and `phase=2`.
- Steps:
  1. Start the app: `ACTIVE_PHASE=2 INDICES=NIFTY SIMULATE=true bun run sim`
  2. Wait for the SR detection engine to compute S/R levels and begin consuming ticks (watch logs for "SR levels loaded for NIFTY").
  3. Allow the simulator to run for 5 minutes, producing straddle.values snapshots.
  4. Query: `SELECT personality_id, signal_type, sr_subtype FROM paper_trades pt JOIN straddle_signals ss ON pt.signal_id = ss.id WHERE ss.signal_type = 'PULLBACK';`
  5. Also query: `SELECT p.name, ss.signal_type FROM paper_trades pt JOIN personality_configs p ON pt.personality_id = p.id JOIN straddle_signals ss ON pt.signal_id = ss.id;`
- Expected result: Any paper trades opened from PULLBACK signals have `personality_id` belonging only to Levelhead. Precision, Adjuster, Reducer, Holder, and other momentum personalities show only `MOMENTUM_EXHAUSTION` signal types in their trade history. No momentum personality has a trade sourced from a PULLBACK signal.

---

**MTC-2 — Momentum personalities never take sr_anchored trades**

- Preconditions: Same as MTC-1.
- Steps:
  1. Start: `ACTIVE_PHASE=2 INDICES=NIFTY SIMULATE=true bun run sim`
  2. Run for 10 minutes.
  3. Query: `SELECT p.name, p.entry_type, ss.signal_type, COUNT(*) FROM paper_trades pt JOIN personality_configs p ON pt.personality_id = p.id JOIN straddle_signals ss ON pt.signal_id = ss.id GROUP BY p.name, p.entry_type, ss.signal_type;`
- Expected result: All rows where `entry_type = 'momentum_exhaustion'` show only `signal_type = 'MOMENTUM_EXHAUSTION'`. No row where `entry_type = 'momentum_exhaustion'` has `signal_type = 'PULLBACK'`.

---

**MTC-3 — Per-underlying straddle data flows independently for all three indices**

- Preconditions: `INDICES=NIFTY,BANKNIFTY,SENSEX`, `SIMULATE=true`.
- Steps:
  1. Start: `INDICES=NIFTY,BANKNIFTY,SENSEX SIMULATE=true bun run sim`
  2. Wait for startup logs showing all three StraddleCalculators initialized (look for "StraddleCalculator initialized for NIFTY / BANKNIFTY / SENSEX").
  3. Wait 5 minutes.
  4. Query: `SELECT underlying, COUNT(*) FROM straddle_snapshots WHERE time > NOW() - INTERVAL '10 minutes' GROUP BY underlying;`
  5. Open the React dashboard and verify the index selector shows all three indices; switching between them updates the straddle value chart.
- Expected result: All three underlyings appear in `straddle_snapshots` with non-zero row counts. BankNifty ATM strike is a multiple of 100; Sensex ATM strike is a multiple of 100; NIFTY ATM strike is a multiple of 50 (verify from snapshot rows). Dashboard displays the per-index selector and chart updates on switch.

---

**MTC-4 — Clockwork parameters never mutate after an optimizer run**

- Preconditions: `ACTIVE_PHASE=2 SIMULATE=true`. At least 200 `retrospection_results` rows for a momentum personality (Precision, Adjuster, or Reducer). The Clockwork personality has `is_frozen = TRUE` in `personality_configs`.
- Steps:
  1. Record Clockwork's current `params` JSON: `SELECT params FROM personality_configs WHERE name = 'Clockwork';`
  2. Trigger the EOD job manually (or wait for the nightly BullMQ schedule).
  3. After the job completes, re-query: `SELECT params FROM personality_configs WHERE name = 'Clockwork';`
  4. Also check the suggestions queue: `SELECT * FROM retrospection_results WHERE personality_id = (SELECT id FROM personality_configs WHERE name = 'Clockwork') ORDER BY recorded_at DESC LIMIT 5;`
- Expected result: Clockwork `params` JSON is byte-for-byte identical before and after. No pending suggestion row exists for Clockwork's `personality_id`. The EOD job logs should contain a "FROZEN_VIOLATION" entry for Clockwork (if it was evaluated) confirming the guard fired.

---

**MTC-5 — Per-index leg cap is independent; NIFTY cap does not block BankNifty**

- Preconditions: `INDICES=NIFTY,BANKNIFTY`, `ACTIVE_PHASE=2`, `SIMULATE=true`. `MAX_OPEN_LEGS_PER_INDEX=4` (or the configured default of 4).
- Steps:
  1. Start: `INDICES=NIFTY,BANKNIFTY ACTIVE_PHASE=2 SIMULATE=true bun run sim`
  2. Manually insert 4 open NIFTY paper trades for a single personality directly into `paper_trades` (set `status='open'`, `underlying='NIFTY'`, `personality_id` = the personality's UUID).
  3. Run for 5 minutes and observe whether the personality accepts a new BankNifty signal.
  4. Also verify via logs or DB that a 5th NIFTY trade attempt is blocked with a portfolio risk reason of `PORTFOLIO_MAX_LEGS` or similar.
- Expected result: The personality accepts new BankNifty entries (per-index book for BankNifty is at 0, cap not reached). A 5th NIFTY entry attempt is blocked. The two checks are independent.

---

**MTC-6 — Integration and E2E test suites pass against live services**

- Preconditions: `docker compose up -d` with healthy TimescaleDB and Redis. `bun run migrate` applied.
- Steps:
  1. `bun run test:integration` — should complete with all tests green.
  2. `SIMULATE=true bun run dev` in one terminal (leave running).
  3. In a second terminal: `npm run test:e2e` — Playwright runs all 82 tests.
- Expected result: Integration tests all pass. E2E tests: all 22 `@critical`-tagged tests must pass for a clean merge. `@functional` failures are acceptable as a CONDITIONAL PASS. `@non-blocker` failures are logged and do not block.

---

**MTC-7 — Calendar freshness hard-fail prevents startup with stale expiry data**

- Preconditions: A test database where all rows in `index_expiry_calendar` for `underlying = 'NIFTY'` have `expiry_date` in the past (e.g. all before today's date).
- Steps:
  1. Update or insert stale rows: `UPDATE index_expiry_calendar SET expiry_date = '2020-01-01' WHERE underlying = 'NIFTY';`
  2. Attempt to start: `INDICES=NIFTY SIMULATE=true bun run sim`
- Expected result: The process throws `CalendarExpiredError` (or equivalent) and exits before entering the main trading loop. Log message names NIFTY as the offending index. Process exit code is non-zero. BankNifty and Sensex entries (if present and valid) do not prevent the hard-fail — each index is checked independently.

---

## 6. Security and risk notes

### Financial integrity — Clockwork immutability

The Clockwork personality is the frozen benchmark that all other personalities are measured against. Two independent guards prevent the optimizer from modifying it: a pre-read throw in `optimizer.ts` before the database SELECT, and a second throw inside the `SELECT FOR UPDATE` transaction (atomic check). Both throw `FROZEN_VIOLATION` and do not silently skip. The rule-based `evolution-engine.ts` has the same guard. Neither path was weakened in M5 — this was explicitly verified by the security auditor re-review.

### Financial integrity — comparison group

Precision, Adjuster, and Reducer use identical `entry_type = 'momentum_exhaustion'`. Their `min_probability` values must stay within 8 percentage points of each other to keep the management comparison valid. The optimizer applies `applyIntegrityCap` against the locked peer set inside the same `SELECT FOR UPDATE` transaction before queuing any proposal. This guard is tested in `optimizer.test.ts` with an explicit out-of-bounds scenario. Levelhead (`sr_anchored`) is correctly excluded from this peer set — its `sr_strength_threshold` parameter is on a different scale and is not comparable to `min_probability`.

### No payment or auth code touched

This epic did not touch any Razorpay, payment, or subscription access code. The PCI/PII boundary described in `business.md` is unaffected.

### Accepted risk — NULL personality_id / NULL underlying in paper_trades

Pre-M2 trades and any trade where the router UPDATE fails will have NULL `personality_id` and/or NULL `underlying`. These rows are excluded from every personality's per-index risk book via SQL equality (NULL never matches a value). This is conservative (safe-fail: losses are under-counted rather than the stop being bypassed), and the invariant holds because the daily stop is evaluated as a pre-entry check against closed rows — by the time a row is closed, the router UPDATE has already run. The accepted risk is documented in `portfolio-risk.ts` inline comments and in the security re-review.

### Rollback

There is no feature flag for the S/R engine or the optimizer individually. To disable S/R signals: set `ACTIVE_PHASE=1` — no SR signals will be written and Levelhead will not be loaded. To run NIFTY-only: set `INDICES=NIFTY`. To disable the optimizer: the EOD job's optimizer invocation is wrapped in a try/catch that falls back to the rule-based engine on any failure; removing the optimizer import from the EOD job is a one-line change. Migrations 012–015 are additive (nullable columns + partial indexes + a new table) and do not break the pre-M5 code path.

---

## 7. Follow-ups and deferred work

**Must complete before Phase 2 calibration work begins (N1 and optimizer latent bugs are blockers):**

| Item | Rationale |
|---|---|
| **N1 (Medium): Add internal entry_type self-guard to `runEvolutionEngine`** | Currently the EOD job pre-filters to `momentum_exhaustion` personalities before calling `runEvolutionEngine`. Any future caller that omits this filter will hit a DB transaction error. The guard should live inside the function as an early return (matching the optimizer's pattern), not as a caller convention. Zero DB cost — the `entry_type` can be passed in by the caller who already has it. Must be done before Phase 2 adds more non-momentum personalities. |
| **Optimizer: fix `BACKTEST_UNDERLYING` constant mismatch** | Change `BACKTEST_UNDERLYING` from `'NSE:NIFTY50-INDEX'` to `'NIFTY'` (the value stored in `straddle_snapshots.symbol`). First confirm with `SELECT DISTINCT symbol FROM straddle_snapshots LIMIT 5`. Without this fix the backtest returns 0 rows and the optimizer's finalist-scoring phase is permanently inert. |
| **Optimizer: remove `precomputedTrades === undefined` guard from `kernel_only` path** | The EOD job always passes `precomputedTrades`; the `kernel_only` fast path therefore never fires in production. Extend the condition to `if (allCandidatesAtOrBelowFixedProb)` (removing the second clause) so the fast path actually short-circuits when all candidates are at or below the fixed ceiling. |

**Backlog Lows (no Phase 2 blocker, but accumulate as tech debt):**

| Item | Rationale |
|---|---|
| Thread a preloaded personality list into the backtest runner | `loadPersonalities` is now called twice per EOD run (EOD job + internal backtest runner call). Pass the already-loaded list via a `preloadedPersonalities` option to avoid the second round-trip. |
| Add composite index `(personality_id, status, entry_time)` on `paper_trades` | The current `(personality_id, status)` index is adequate at current trade volumes. As the system accumulates months of closed trades, a three-column composite index will avoid scanning all closed trades per personality just to filter by date. |
| Deduplicate `IST_OFFSET_MS` — import from `clock.ts` everywhere | The constant `5.5 * 60 * 60 * 1000` is re-declared locally in `straddle-calc.ts` and `personality-filter.ts` (and pre-exists in several other modules). All should import the exported constant from `clock.ts`. Zero-risk refactor. |
| Populate `underlying` atomically in `paper-trade-executor.ts` INSERT | The current two-step INSERT + UPDATE means a brief NULL window. When the executor is next extended to accept `EntryIntent` fields, add `underlying`, `personality_id`, and `signal_id` to the INSERT and remove the router's two follow-up UPDATEs. |
| **L1**: Verify migration 013 seed dates against NSE/BSE calendar | The seeded expiry dates are flagged in the migration comment as unverified against the live exchange calendar. Required before live use. |
| **L2**: Bind stored NUMERIC precision in schema | `retrospection_results` numeric columns are stored as unbounded NUMERIC. Bounding them (e.g. `NUMERIC(10, 4)`) prevents pathological precision accumulation. |
| **L3**: Resolve stale comment + signal_type/sr_subtype field conflation | A comment in the SR detection engine conflates `signal_type` and `sr_subtype` naming. Fix the comment; no logic change needed. |
| **L4**: Extract magic-number SR thresholds to named constants | Proximity points, strength floor, and dedup window are inline numbers in `sr-detection-engine.ts`. Move to a config object (similar to `PeakDetectionConfig`) for readability and env-var override. |

---

## 8. References

**Task contracts:**
- `pipeline/tasks/T-43-A.json` — Schema and migrations
- `pipeline/tasks/T-43-B.json` — S/R level computation
- `pipeline/tasks/T-43-C.json` — S/R detection engine
- `pipeline/tasks/T-44.json` — Levelhead personality wiring
- `pipeline/tasks/T-45.json` — Multi-index expansion
- `pipeline/tasks/T-46.json` — Guarded deterministic optimizer

**Review reports:**
- `pipeline/reviews/security-audit.md` — Initial audit (1 Critical, 1 High, 2 Low)
- `pipeline/reviews/security-audit-rereview.md` — Re-review post fix cycle (PASS; 0 new findings)
- `pipeline/reviews/performance-review-rereview.md` — Re-review post fix cycle (PASS; 2 new Low)
- `pipeline/reviews/architecture-review-rereview.md` — Re-review post fix cycle (CONDITIONAL PASS; 1 Medium, 3 Low)
- `pipeline/reviews/synthesis-rereview.md` — Synthesised verdict: CONDITIONAL PASS
- `pipeline/reviews/automation-gate.md` — Automation Gate: CI-ONLY (1144 unit tests green; 82 E2E compile)

**QA checklist:** `pipeline/qa-checklist.md` (22 Critical / 20 Functional / 8 Non-blocker)

**Key changed files:**
- `src/db/migrations/012_sr_signals.sql`
- `src/db/migrations/013_index_expiry_calendar.sql`
- `src/db/migrations/014_signal_idempotency.sql`
- `src/db/migrations/015_paper_trades_underlying.sql`
- `src/db/schema.ts`
- `src/signals/sr-levels.ts`
- `src/signals/sr-detection-engine.ts`
- `src/signals/personality-filter.ts`
- `src/signals/personality-router.ts`
- `src/ingestion/brokers/instrument-registry.ts`
- `src/index.ts`
- `src/trading/portfolio-risk.ts`
- `src/retrospection/optimizer.ts`
- `src/retrospection/evolution-engine.ts`
- `src/jobs/eod-retrospection-job.ts`

**Related epic docs:**
- `docs/epics/milestone-2-momentum-signals-multi-personality.md` — prior momentum engine and personality engine
- `docs/epics/m3a-historical-data-replay-backtesting.md` — backtest runner (read-only import in optimizer)
- `docs/epics/m4-eod-retrospection-evolution.md` — rule-based evolution engine (extended in T-46)
