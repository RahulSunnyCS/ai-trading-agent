# Architecture Review — Milestone 2

## Verdict: CONDITIONAL PASS

---

### 🔴 Critical

**FINDING: portfolioRiskCheck is implemented but never called**
Severity: High
File or area: `src/trading/portfolio-risk.ts`, `src/signals/personality-router.ts`
What it is: `portfolioRiskCheck()` (T-31) is a complete, tested function enforcing event-day gates, VIX staleness, daily portfolio stop, margin buffer, and the advisory-lock max-legs cap. However, no production code path calls it. `PersonalityRouter._openTradeForPersonality()` opens trades unconditionally after the per-personality filter passes. The portfolio-level stop that is supposed to prevent, e.g., more than 4 simultaneous straddles or trading past the daily stop loss does not fire at runtime.
Why it matters: The advisory lock and the max-legs cap exist specifically to prevent race conditions and over-exposure. Without the call site, 10 personalities could all open positions on the same signal with nothing to stop them. The function was built and tested in isolation but was never wired into the call chain.
Recommendation: Add the `portfolioRiskCheck()` call inside `_openTradeForPersonality()` in `personality-router.ts`, immediately before `executor.openTrade()`, passing `this._clock.now() - this._lastVixTimestampMs` as `vixAgeMs`. The function is already designed for exactly this call site — the `intent` shape maps directly.

---

**FINDING: AdjusterManager and ReducerManager implemented but not dispatched — PositionMonitor still uses HolderManager for all styles**
Severity: High
File or area: `src/trading/position-monitor.ts` lines 387–395
What it is: `_resolveHandler()` in PositionMonitor has two explicit `TODO(T-29)` and `TODO(T-30)` stubs that return `this._holderManager` for both `'roll'` and `'cut_reenter'` management styles. AdjusterManager and ReducerManager are fully implemented (T-29, T-30), tested, and exported, but they are never imported or instantiated in PositionMonitor. All Adjuster and Reducer personalities silently behave as Holders.
Why it matters: Three of the ten personalities — Adjuster (roll) and Reducer (cut_reenter) — run with the wrong management strategy. Rolls are never executed, cut-and-reenter logic never fires, and the re-entry eligibility state in ReducerManager is never populated. This is not a placeholder for future work: the code exists, is complete, and simply needs to be plugged in.
Recommendation: Import `AdjusterManager` and `ReducerManager` into PositionMonitor, instantiate them as singleton fields alongside `_holderManager`, and replace the two TODO stubs in `_resolveHandler()` with the correct instances.

---

### 🟡 Medium

**FINDING: PersonalityRouter opens trades without calling management handler openPosition — two parallel trade-open paths**
Severity: Medium
File or area: `src/signals/personality-router.ts` `_openTradeForPersonality()`, `src/trading/management/holder.ts` `openPosition()`
What it is: PersonalityRouter calls `PaperTradeExecutor.openTrade()` directly and then issues a separate `UPDATE paper_trades SET personality_id = ..., signal_id = ...` to associate the trade with the personality. The ManagementHandler interface has its own `openPosition()` method (used by PositionMonitor's entry bridge) that also wraps `executor.openTrade()`. There are now two distinct code paths for opening personality-associated trades, each with slightly different field handling (e.g., `underlying` cast, `spot` and `straddleValue` string/number conversion).
Why it matters: If `openPosition()` is ever updated (e.g., to carry lot size or BankNifty underlying), the PersonalityRouter path will diverge silently. The two-step INSERT + UPDATE is also non-atomic: if the UPDATE fails after the INSERT succeeds, the trade exists in the DB without a `personality_id`, which the reconciliation log treats as a pre-M2 trade.
Recommendation: Have PersonalityRouter delegate to the management handler's `openPosition()` (dispatched by management style) rather than calling the executor directly. The `openPosition()` method already exists on the ManagementHandler interface and all three managers implement it. This collapses the two paths into one and removes the non-atomic INSERT + UPDATE.

**FINDING: signal_time type mismatch between publisher (ISO string) and consumer (parseInt)**
Severity: Medium
File or area: `src/signals/peak-detection-engine.ts` line 580, `src/signals/personality-router.ts` line 635
What it is: `PeakDetectionEngine` publishes `signal_time` to the `signals.generated` Redis stream as an ISO-8601 string (`new Date(now).toISOString()`). `PersonalityRouter._parseSignal()` reads it back with `Number.parseInt(fields["signal_time"] ?? "", 10)`. `parseInt` of an ISO string like `"2026-05-19T09:30:00.000Z"` returns `NaN`, causing every MOMENTUM_EXHAUSTION signal from the peak detection engine to be silently dropped as malformed.
Why it matters: This is a silent data loss bug: the router logs "Signal missing/invalid signal_time — skipping" and ACKs the message without routing it. No trade is ever opened from a peak-detection signal. Scheduled signals from `ScheduledSignalEmitter` also publish `signal_time` but do so as a numeric string (line confirmed not shown — verify this), so the impact may be limited to MOMENTUM_EXHAUSTION signals, which are the primary trading signals.
Recommendation: Standardise `signal_time` as epoch milliseconds (integer string) in all publishers. Change `PeakDetectionEngine` line 580 from `new Date(now).toISOString()` to `String(now)`. Alternatively, add ISO string parsing in `_parseSignal()`, but the integer convention is cleaner and consistent with all other numeric fields in the stream.

**FINDING: checkComparisonIntegrity duplicated between personality-filter.ts and personalities.ts**
Severity: Medium
File or area: `src/signals/personality-filter.ts` lines 374–432, `src/api/routes/personalities.ts` lines 84–149
What it is: The comparison integrity check (ensuring Precision/Adjuster/Reducer `min_probability` values stay within 8 percentage points) is implemented twice with slightly different logic. The `personality-filter.ts` version operates on in-memory `PersonalityConfig[]` objects and computes the outlier via mean deviation. The `personalities.ts` version queries the DB directly, uses median deviation to find the outlier, and returns a different shape. The comment in `personalities.ts` acknowledges the duplication and promises to remove the inline version once T-26 is ready — but T-26 (`personality-filter.ts`) now exists.
Why it matters: Two implementations of the same business rule will diverge over time. The outlier-detection algorithms already differ (mean vs median). A future change to the 8pp threshold requires updates in two places.
Recommendation: Remove the inline `checkComparisonIntegrity` from `personalities.ts` and replace it with the exported function from `personality-filter.ts`, adapting it to accept the DB-queried personality list. The filter's version takes `PersonalityConfig[]`; the API route can fetch those rows and call it directly, eliminating the duplicate DB query pattern.

**FINDING: IST date/time computation duplicated across at least six modules instead of using the Clock interface**
Severity: Medium
File or area: `src/signals/personality-filter.ts`, `src/signals/scheduled-signal-emitter.ts`, `src/signals/peak-detection-engine.ts`, `src/signals/probability-scorer.ts`, `src/trading/portfolio-risk.ts`, `src/trading/management/reducer.ts`
What it is: Every module that needs to convert epoch-ms to an IST date or time string has its own private copy of the UTC+5:30 offset arithmetic. Some use `5.5 * 60 * 60 * 1000`, some use `330 * 60 * 1000`. The `Clock` interface already has `toISTDate(ms)` and `toISTTime(ms)` methods backed by `date-fns-tz` and the `Asia/Kolkata` IANA zone — which correctly handles any edge cases — but the bulk of the codebase ignores this in favour of inline offset arithmetic. `personality-filter.ts` and `portfolio-risk.ts` define private `getISTDateStr` functions with identical bodies.
Why it matters: If a DST edge case or a Bun runtime quirk surfaces in the manual arithmetic, there are six places to fix. The `Clock` interface already provides the canonical implementation. This is also a testability problem: the inline helpers are not injectable.
Recommendation: Modules that already receive a `Clock` instance (personality-filter, scheduled-signal-emitter, peak-detection-engine) should call `clock.toISTDate()` / `clock.toISTTime()` instead of local helpers. Modules that do not receive a `Clock` instance (portfolio-risk, reducer) should accept one. Delete all private IST helper functions that duplicate what `Clock` provides.

**FINDING: ReducerManager personalityId access via unsafe type cast**
Severity: Medium
File or area: `src/trading/management/reducer.ts` lines 265–266
What it is: `ReducerManager.closePosition()` needs `personalityId` to set re-entry eligibility state, but `OpenPosition` (the interface parameter) does not carry that field. The implementation casts `position as OpenPosition & { personalityId?: string | null }` and reads `extendedPosition.personalityId`. This relies on the runtime caller (PositionMonitor) having passed an `OpenPositionWithPersonality`, which is a local type defined inside PositionMonitor and not part of the shared interface.
Why it matters: The cast bypasses TypeScript's type safety. If any caller other than PositionMonitor ever calls `closePosition()` with a plain `OpenPosition` (as the interface signature promises), `personalityId` will be `undefined`, the re-entry state will be silently skipped, and the warning path will fire. The fact that the implementation depends on a field not in its declared interface is a broken interface contract.
Recommendation: Add `personalityId` to the `ManagementHandler.closePosition()` signature as an explicit parameter (or pass it as part of a richer `PositionContext` struct alongside `OpenPosition`). This makes the dependency explicit and removes the need for the cast. HolderManager and AdjusterManager simply ignore the parameter.

---

### 🟢 Low / Informational

**FINDING: ADVISORY_LOCK_KEY not exported from portfolio-risk.ts**
Severity: Low
File or area: `src/trading/portfolio-risk.ts` line 42
What it is: The advisory lock key integer (42) is declared as a module-private `const` with a comment saying "all code that needs to take this lock must import the constant." But the constant is not exported. The comment describes an intent that the code does not implement. No other module currently takes advisory locks independently, so this is currently harmless.
Why it matters: If a future module (e.g., a batch retrospection job) also needs to serialise against the leg-cap check, it will be tempted to hard-code 42 rather than import it. That defeats the documented single-source-of-truth intent.
Recommendation: Export `ADVISORY_LOCK_KEY` from `portfolio-risk.ts` by changing the declaration to `export const ADVISORY_LOCK_KEY = 42;`.

**FINDING: ReducerManager module-level in-memory state — process restart loses CUT history**
Severity: Low
File or area: `src/trading/management/reducer.ts` lines 77–78
What it is: Re-entry eligibility for the cut_reenter style is stored in a module-level `Map`. The design note documents this clearly and argues correctly that the state is safe to lose on restart (the next signal uses standard `min_probability`, which is the conservative fallback). The date-based stale detection is clever and avoids needing explicit EOD cleanup. This is a conscious, well-reasoned tradeoff for Phase 1.
Why it matters: A process restart during a trading session means the Reducer personality does not know it already cut a position and should use the lower re-entry threshold. The next signal will be evaluated at the standard threshold instead of the relaxed re-entry threshold. The research outcome is slightly pessimistic for the Reducer's re-entry strategy on the restart day.
Recommendation: Document the restart behaviour explicitly in the module header (it is partially documented). For Phase 2, consider persisting `reentry_eligible` state to Redis with a TTL (same pattern as OI tracking) so restarts within the same trading day maintain continuity. This is not urgent: the current fallback is safe and conservative.

**FINDING: PersonalityRouter loads all active personalities on every signal — no cache**
Severity: Low
File or area: `src/signals/personality-router.ts` lines 376–406
What it is: Every signal triggers a `SELECT * FROM personality_configs WHERE is_active = TRUE AND phase <= 1` query. PositionMonitor loads personality configs once at startup and caches them for the session. PersonalityRouter takes the opposite approach: a live query on every signal.
Why it matters: At 15-second snapshot intervals with 10 personalities, the DB query rate is manageable for a research tool. However, the inconsistency between PersonalityRouter (no cache) and PositionMonitor (startup cache) means that if configs change mid-session, the router sees the update but the monitor does not. This inconsistency could cause the router to open a trade for a personality that the monitor does not recognise until the next restart.
Recommendation: Align the two components on one caching strategy. Either both cache (simplest: the monitor is already correct) or both query live (safest: guaranteed consistency). If caching is chosen, the router should expose a `reloadConfigs()` method called after a PUT to `/personalities/:id` so the cache invalidates immediately.

**FINDING: GlobalMacroFeed uses setInterval (not clock.tick) — not testable with VirtualClock**
Severity: Low
File or area: `src/ingestion/global-macro-feed.ts` lines 359–363
What it is: The poll interval uses `setInterval` (real wall-clock timer) instead of `clock.tick()`. The design note acknowledges this explicitly: "the actual poll interval timer uses setInterval (native Bun/Node timers), not clock.tick(), because this feed is designed for production use — it does not need VirtualClock-driven tests since we mock fetch() directly." This is a deliberate choice, not an oversight.
Why it matters: Acceptable for Phase 1. The consequence is that GlobalMacroFeed cannot be driven by VirtualClock.advance() in simulation mode, so macro data is never refreshed during a test run unless `_doPoll()` is called manually. All existing tests correctly call `_doPoll()` directly.
Recommendation: Document in `start()` that this feed intentionally bypasses VirtualClock and will not fire in simulation mode unless `_doPoll()` is called explicitly. Consider adding a note to `SIMULATE=true` startup logging that macro data is not auto-refreshed in sim mode.

**FINDING: OI tracking added to StraddleCalculator — acceptable for Phase 1 but worth flagging**
Severity: Low
File or area: `src/ingestion/straddle-calc.ts` lines 78–90, 183–189, 303–346
What it is: Open interest tracking (locking open OI, computing OI change percentage, publishing to Redis) was added to `StraddleCalculator`, which was originally responsible only for ATM straddle snapshot calculation. The addition is well-encapsulated (private fields and a private `_updateOiTracking()` method) and does not bleed into the public API.
Why it matters: `StraddleCalculator` now has two responsibilities: straddle value snapshotting and OI context aggregation. For Phase 1 with a single underlying, this is fine. When Phase 2 adds BankNifty and Sensex, the OI tracking will need per-underlying logic, making the class more complex. An alternative is a dedicated `OITracker` class.
Recommendation: For Phase 1, the current implementation is acceptable. Add a comment to `StraddleCalculator` that OI tracking is embedded here for now and should be extracted to a separate module when multiple underlyings are supported in Phase 2.

**FINDING: personalitiesRoutes exists but is not registered in server.ts**
Severity: Low
File or area: `src/api/server.ts`, `src/api/routes/personalities.ts`
What it is: The `personalitiesRoutes` Fastify plugin is implemented and exported from `personalities.ts` but is not imported or registered in `buildServer()` in `server.ts`. The GET/PUT endpoints for personality CRUD are therefore not reachable over HTTP.
Why it matters: The personality management API is part of the declared scope of Milestone 2 and is described in the project overview. Operators cannot query or update personality configurations via the API until this registration is added.
Recommendation: Add `import { personalitiesRoutes } from "./routes/personalities.js";` and `server.register(personalitiesRoutes, { db: opts.db });` in `buildServer()`. The plugin follows the same pattern as `paperTradesRoutes` and requires no additional options.

---

### ✅ No issues

- **ManagementHandler interface design**: The three-method interface (`openPosition`, `evaluatePosition`, `closePosition`) with `db` and `personality` passed per-call is the right abstraction. Stateless handler instances handle multiple personalities correctly. AdjusterManager's transactional roll close+reopen is correctly scoped to the ROLL path only.

- **PersonalityRouter fan-out architecture**: Parallel `fetchDailyState` via `Promise.all` followed by parallel filter execution, with serialised trade opens after — correct design for preventing race conditions on the portfolio check while not artificially sequencing the pure filter stages.

- **Advisory lock implementation**: `pg_try_advisory_xact_lock` with `COMMIT` to release, conservative fail-closed on lock contention, always `client.release()` in `finally` — correct and safe.

- **Signal deduplication in PeakDetectionEngine**: In-memory per-underlying with configurable `dedupWindowSecs`. Loss on restart is acceptable (next signal will be treated as fresh; the scheduler's daily-fire-once guard provides the outer boundary). Well-documented.

- **Schema design**: `personality_configs`, `straddle_signals` (hypertable), `personality_audit_log`, and the M2 additions to `paper_trades` are well-structured. The nullable M2 columns with FK references are idempotent via `ADD COLUMN IF NOT EXISTS`.

- **Error propagation in read loops**: ACK-after-success, no-ACK on exception, 500ms backoff on Redis errors — appropriate for a streaming consumer. The PositionMonitor additionally uses `recoverPending()` for crash recovery, which is correct.

- **Clockwork frozen guard**: The `is_frozen` check in `personalities.ts` returns a 403 FROZEN_VIOLATION before any write, consistent with the documented invariant. The comment explicitly notes this must match the evolution engine's behaviour.

---

## Summary

High  : 2
Medium: 4
Low   : 6
