# M5 Synthesis Review Report (Phase 4)

**Verdict: FAIL** — 2 Critical + 4 High must be fixed before Gate 2 can pass.

Severity roll-up (deduped across the three reviewers):
- 🔴 Critical: 2
- 🟠 High: 4
- 🟡 Medium: 5
- 🟢 Low: 4

Cross-confirmed positives (two reviewers independently): no SQL injection (all queries parameterised); Clockwork `is_frozen` FROZEN_VIOLATION guard and the 8-percentage-point comparison-integrity cap both preserved and re-checked inside the optimizer's SELECT-FOR-UPDATE; all hypertable queries in new modules carry a time-range filter; conventions (named exports, injectable Clock, append-only migrations) all pass.

---

## 🔴 CRITICAL

### C1 — Per-index risk controls reference a column that does not exist / never match (security)
`src/trading/portfolio-risk.ts:207` filters `paper_trades` on `AND underlying = $4`, but `paper_trades` has **no `underlying` column** (verified against 001_core_schema.sql + 004; columns are `personality_id`, `symbol`, `parent_trade_id`, `signal_id`). The code comment at line 200 falsely claims the column "was present from migration 001." Against a real DB the daily-stop query throws `column "underlying" does not exist`. The sibling per-index leg cap in `personality-filter.ts:203-210` matches `symbol = $2` with the bare index name `'NIFTY'`, which can never equal a stored prefixed symbol (`NSE:NIFTY...`). **Net effect: the two money-loss controls T-45 reworked (per-index daily stop, per-index leg cap) are inert / error at runtime.** Unit tests missed it because `db.query` is mocked.
**Fix:** derive the index from `symbol` (e.g. `symbol LIKE` on the encoded underlying, or join through `signal_id`), correct the false comment, and add a test that runs against a real/in-memory schema rather than a mocked `db.query`.

### C2 — EOD backtest runs 3× identical + N+1 per-day snapshot loads (performance)
`optimizer.ts:884`, `eod-retrospection-job.ts:268`, `backtest-runner.ts:502-503`. The EOD job calls `runOptimizer()` once per momentum personality; each call (past the 200-row gate) spins a fresh 365-day backtest with an **identical** BacktestConfig (same underlying/window/splits) for Precision, Adjuster, Reducer. The runner itself loads snapshots one calendar day at a time in a sequential loop → 365 hypertable queries per run → **~1,095 sequential queries per EOD**, plus triplicated `loadPersonalities`/`loadRegimeTags`.
**Fix:** run the backtest once in the EOD job and pass `SimulatedTrade[]` into `runOptimizer()` (skip the internal run when supplied); replace the per-day loop with a single range query grouped in memory.

---

## 🟠 HIGH

### H1 — Multi-index is broken in LIVE for BankNifty & Sensex (architecture)
`straddle-calc.ts:26,301` calls the synchronous Thursday-formula `getCurrentExpiry` for **all** underlyings on every 15s snapshot; that function ignores its `underlying` arg. BankNifty expires Wednesday, Sensex Friday — so every BankNifty/Sensex option symbol carries a Thursday expiry. The `index.ts` startup assert uses the *correct* calendar function, so **startup passes while runtime symbol-building is wrong from the first tick.** In LIVE mode this yields zero straddle values for those indices (no broker tick matches); SIMULATE masks it. This fires every normal session, not just holidays — the headline M5 feature does not actually work in live for 2 of 3 indices.
**Fix:** inject the pre-resolved calendar expiry into each `StraddleCalculator` at construction; refresh in-memory on week rollover. (`straddle-calc.ts` was forbidden in T-45's scope — this is the deferred seam.)

### H2 — NULL `personality_id` makes the daily stop fail-open (security)
`portfolio-risk.ts` scopes the loss SUM with `personality_id = $3`; SQL equality never matches NULL, and `personality_id` is nullable (pre-M2 rows; the executor INSERT omits it and the router patches it via a later UPDATE). Realised losses on those rows are uncounted → stop can fail open.
**Fix:** make `personality_id` NOT NULL going forward (backfill + constraint) or COALESCE/justify; add a test.

### H3 — `fetchDailyState` defeats its index on the hot path (performance)
`personality-filter.ts:181-190` filters `DATE(entry_time AT TIME ZONE 'Asia/Kolkata') = $2::date`. Wrapping `entry_time` in a function prevents use of `idx_paper_trades_status_entry_time` → sequential scan over all closed trades, per active personality, per signal routing event (up to 10×).
**Fix:** compute IST-midnight UTC bounds in TS (as portfolio-risk.ts already does) and filter `entry_time >= $2 AND entry_time < $3`.

### H4 — EOD evolution engine throws for Levelhead every run (architecture)
`eod-retrospection-job.ts:148-150,244` calls `runEvolutionEngine` for all active personalities with no `entry_type` filter; inside, the SELECT-FOR-UPDATE is scoped to `momentum_exhaustion`, so a Levelhead (sr_anchored) personality throws "not found in momentum_exhaustion group" on every EOD run. The per-personality try/catch swallows it (no data lost) but logs a false alarm every run. The optimizer already handles this with an `entry_type_excluded` early-return; the evolution engine does not.
**Fix:** mirror the optimizer's early-return (or pre-filter by entry_type in the EOD job).

---

## 🟡 MEDIUM

- **M1 (arch, optimizer.ts:192,735):** optimizer hardcodes `BACKTEST_UNDERLYING='NSE:NIFTY50-INDEX'` for all personalities → non-NIFTY personalities would be scored against NIFTY data (silent miscalibration in autonomous mode). Add a pre-flight `multi-underlying_not_supported` guard until the runner accepts per-personality underlying.
- **M2 (arch, index.ts:472-481):** graceful shutdown stops signal engines before straddle calculators → unACKed stream messages re-delivered on restart; `straddle_signals` INSERT is not idempotent → duplicate rows. Reverse the order and add `ON CONFLICT DO NOTHING` on a unique key.
- **M3 (arch/perf, optimizer.ts:36-49,608-650):** Phase B backtest yields zero discrimination while the runner hardcodes `adjustedProbability=0.7` (all candidates ≤0.70 share one trade set; >0.70 admits none). Guard: if all shortlisted candidates ≤0.70, skip the backtest and return the kernel-peak candidate (`kernel_only`). **This guard also largely resolves C2's cost** — they are the same root issue (premature real-backtest wiring).
- **M4 (arch, portfolio-risk.ts:263-267):** Rule 4 margin counts all open legs cross-underlying then multiplies by the new trade's single lot size → overestimates in mixed-index books. Scope per-underlying or document the error bound alongside the T-50 TODO.
- **M5 (perf, personality-filter.ts:334,576 + portfolio-risk.ts:263/315):** `parseBlockedDates` re-runs `JSON.parse(env)` per personality per signal (and as an O(N) array); two identical `SELECT COUNT(*) ... status='open'` run back-to-back. Parse once into a Set at router level; compute the count once.

## 🟢 LOW

- **L1 (security/arch):** migration 013's 27 seed expiry dates are human-unverified with no weekday/holiday integrity constraint; document a runbook + optional CI holiday-calendar check. (Pre-flagged at Gate 1.)
- **L2 (security):** SR-detection persists stream-derived NUMERICs with no range bound (defence-in-depth; producer is internal).
- **L3 (arch, personality-filter.ts:262):** stale comment "any_signal accepts all three types" after the converse SR guard; plus a longer-term note that retrospection grouping by `signal_type` conflates plain-PULLBACK with SR_REVERSAL-PULLBACK unless it also filters `sr_subtype` — a first-class `SR_REVERSAL` signal_type in Phase 2 would remove the ambiguity.
- **L4 (arch):** `sr-levels.ts` prev_week_high/low contributed[] pairing; `sr-detection-engine.ts:184-188` confidence-tier thresholds as inline literals (should be named constants).

---

## CONFLICTS BETWEEN REVIEWERS
No direct contradictions — the findings **converge**. Three findings (C2, M1, M3) all point at the same root cause: wiring the real backtest into the optimizer now is simultaneously **expensive** (3× + N+1), **inert** (runner hardcodes 0.7 → no discrimination), and **miscalibrated for non-NIFTY** (hardcoded NIFTY underlying). The cheapest correct response is the M3 `kernel_only` guard, which also neutralises C2's cost and side-steps M1 until the runner emits per-signal probabilities and per-underlying config. C1 + H1 + M4 converge on a second theme: T-45's multi-index work has real correctness gaps in both symbol-building and risk-control scoping.

## VERDICT EXPLANATION
**FAIL.** Two Criticals (a runtime-erroring/inert risk control; a ~1,095-query EOD blow-up) plus four Highs — most importantly that multi-index does not actually function in LIVE for BankNifty/Sensex (H1). The new S/R signal engine, the SR-leak guard, the Clockwork/comparison-integrity protections, and the convention adherence are all sound. The defects are concentrated in **T-45 (multi-index)** and the **optimizer's real-backtest wiring** — both fixable without touching the S/R core. Recommend a Phase 6 fix cycle on C1, C2, H1–H4 (M3's guard folded into C2) before re-review.
