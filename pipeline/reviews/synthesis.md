# Phase 4 Synthesis Review — M3a (T-54, T-55, T-56, T-57, T-33)

**Inputs:** security-audit.md (CONDITIONAL PASS, 0 Crit / 3 Med / 2 Low), performance-review.md (CONDITIONAL PASS, 0 Crit / 1 High / 4 Med / 4 Low), architecture-review.md (CONDITIONAL PASS, 0 High / 6 Med / 4 Low).

**Overall verdict: CONDITIONAL PASS.** No Critical findings, no FAIL, no SQL injection / SSRF / secret leakage. The core architectural claim (replay reuses the single live pipeline via a shared `computeAndPublishSnapshot`; `processedThrough` is a sound named barrier) holds. Hypertable time-bounding discipline is respected throughout. The conditions below are correctness/integrity and robustness gaps, not security holes.

## Reviewer conflicts
None material. The three lenses are complementary; performance and architecture independently converged on the same two issues (the replay microtask-yield seam; the historical-feed unbounded load), which raises confidence in those findings.

## MUST-FIX before Gate 2 proceeds (correctness / research-integrity / determinism — all cheap)

**C1 — Reconstructor INSERT silently corrupts data + ignores the resolution column** (Security 🟡 + Architecture 🟡; `reconstruct-straddle.ts:289-306`)
- Two defects on the same INSERT: (a) `ON CONFLICT DO NOTHING` is a DEAD clause — `straddle_snapshots` has only the `(id,time)` BIGSERIAL PK, so re-running reconstruction over a range silently DUPLICATES rows, which corrupts the regime classifier's acceleration / sign-change / completeness inputs and can flip a day's regime label; (b) the INSERT omits the `resolution` column that migration 008 added for exactly this purpose, so every reconstructed row persists `resolution = NULL` and the regime fidelity/UNCLASSIFIED detection is defeated. **This means the "migration 008 closes the T-56 fidelity gap" claim is not yet true in the write path.**
- Fix: add a real UNIQUE index on `(time, symbol, strike, expiry)` (new migration) used as an explicit conflict target (or delete-then-insert the range), AND add `resolution` to the INSERT column list.

**C2 — Replay determinism seam is unproven in production** (Performance 🟡 + Architecture 🟡; `replay-driver.ts:180-183`)
- The driver spins 10 `Promise.resolve()` microtask yields to let the calculator's poll loop read freshly-published ticks before `snapshotStep()`. The count is empirically tuned; the 100× determinism gate passes only because the test uses a SYNCHRONOUS fake Redis — it does not exercise the real-Redis production seam. Under real latency/GC, `snapshotStep()` could fire on a stale price map → a silently wrong snapshot that contaminates the whole ROC buffer. This directly threatens M3's reason to exist (reproducible backtests) and the QA checklist's Critical determinism tier.
- Fix (both reviewers agree): expose a named observable input-side barrier on StraddleCalculator — `flushPendingTicks()/ticksConsumed(lastXaddId)` that resolves only when the poll cursor passes the last published id — mirroring the existing `processedThrough` on the output side. Replace the microtask loop with it.

**C3 — `bun run replay` mutates the live DB and can close real open trades** (Security 🟡; `scripts/replay.ts` + `position-monitor.ts:249-322`)
- Replay connects to the live `DATABASE_URL`/Redis and runs the real PositionMonitor, which can close every open paper trade against replayed historical prices. The "use a separate DB" guidance is a comment, not enforced.
- Fix: require an explicit distinct-target opt-in and/or tag replay trades and scope `getOpenTrades` to them.

**C4 — `pendingBarriers` not drained on `stop()` → potential hang/deadlock** (Architecture 🟡; `position-monitor.ts:417-422`)
- If the poll loop exits between `snapshotStep()` and `processedThrough()`, unresolved barrier promises sit forever and the driver hangs with no timeout.
- Fix: resolve/reject all `pendingBarriers` entries in `stop()` then clear the map. Cheap.

## CONDITIONS for heavy use (track; fix before the milestone is treated as authoritative)

**H1 — N+1 per-step leg queries in the reconstructor** (Performance 🔴 High; `reconstruct-straddle.ts:408-465`)
- 3 sequential DB round-trips per cadence step → ~585k calls for a 6-month 15s reconstruction (~10-50 min of pure DB wait). Correct, but impractically slow. Fix: pre-fetch the window's index+option ticks once (still time-bounded), walk a pointer per step. Condition: address before 15s reconstruction over ranges > ~2-3 weeks.

**M1 — Unbounded in-memory load in `historical-feed.load()`** (Security 🟡 + Performance 🟡; `historical-feed.ts:361-378`)
- `fetchPageSize` is advertised but unused; the whole window loads into memory → OOM risk on constrained hosts for multi-month replays. Fix: wire day-at-a-time paging or enforce a window cap. Condition: before multi-month replay windows.

**M2 — HistoricalFeed does not structurally `extends BrokerFeed`** (Architecture 🟡; `historical-feed.ts:102-142`)
- The "same pipeline" contract is unenforced by the type system. Cheap fix: `interface HistoricalFeed extends BrokerFeed`.

**M3 — straddle-calc retains inline buffer mutate instead of `pushToBuffer`** (Architecture 🟡; `straddle-calc.ts:281-283`)
- Partial extraction; silent drift risk between live and historical buffer capping. One-line fix.

**M4 — fetchMarketTicks loads all symbols, ignores configured underlying** (Architecture 🟡; `historical-feed.ts:221-228`)
- Harmless today (single underlying); multiplies buffer in Phase 2 multi-index. Add `AND symbol = $3`.

## LOW / informational (batch into a cleanup pass)
- Missing `idx_straddle_snapshots_symbol_time (symbol, time DESC)` — suboptimal regime queries (Perf 🟢).
- `backfill_ranges` CHECK `NOT (gaps_detected>0 AND status='complete')` is comment-only, not enforced (Arch 🟢).
- `ON CONFLICT` target unpinned in backfill batch inserts (Perf 🟢).
- Access-token first-4-chars logged — prefer hashed fingerprint (Security 🟢).
- `regime_confidence` typed `number` but pg returns string → NaN risk (Arch 🟢).
- `on('gap')` advertised in doc comment but never emitted (Arch 🟢).
- `gaps_json` incomplete on resume (uses checkpoint `from`, not original `from`) (Arch 🟢).
- Credential resolution prefers env over fresh DB token without expiry check (Security 🟢).
- event_calendar reloaded per classifyDateRange call; classifyDateRange sequential loop — both fine at current scale (Perf 🟢).

## Recommendation
CONDITIONAL PASS. Recommend fixing C1–C4 now (all small, correctness/integrity/determinism, and C1+C2 protect the milestone's core value), then re-running the affected tests. H1 + M1 are conditions before heavy/large-range backtesting. Everything else is tracked tech debt for a cleanup pass.
