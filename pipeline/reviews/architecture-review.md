# ARCHITECTURE REVIEW REPORT — Milestone 3a
## Backend + Infra Lens

---

### FINDING: straddle-calc.ts retains inline buffer mutate instead of delegating to pushToBuffer

Severity: Medium
File or area: `src/ingestion/straddle-calc.ts` lines 281–283

What it is:
`straddle-math.ts` exports `pushToBuffer()` as the single implementation of the rolling-buffer mutation logic. `reconstruct-straddle.ts` calls it correctly. But `straddle-calc.ts` still performs the mutation inline with the same `push + shift` idiom (lines 281–283) instead of calling `pushToBuffer`. The stated goal of the extraction was "ONE implementation of straddle math for live and historical use." The math functions (`computeRoc`, `computeAcceleration`) are shared, but the buffer management itself is not.

Why it matters:
This is a partial extraction. If the capping logic ever needs to change (e.g. `maxSize` semantics, an off-by-one fix), it must be updated in two places — exactly the problem the refactor was meant to eliminate. The disparity is silent: both paths produce the same result today, so tests pass, but future drift is guaranteed to go unnoticed until P&L numbers diverge.

Recommendation:
Replace the inline push/shift in `computeAndPublishSnapshot` with `pushToBuffer(straddleBuffer, straddleValue, rocWindowSize)`. This is a one-line change and the existing test suite confirms correctness.

---

### FINDING: 10-microtask yield in replay-driver is a fragile environment coupling

Severity: Medium
File or area: `src/ingestion/historical/replay-driver.ts` lines 180–183

What it is:
After publishing ticks to Redis and before calling `snapshotStep()`, the driver spins 10 microtask yields (`for (let i = 0; i < 10; i++) await Promise.resolve()`). The comment explains this is needed because the StraddleCalculator poll loop — a concurrent async loop driven by non-blocking XREAD — needs several event-loop turns to process the freshly published entries. The number 10 is calibrated against observed test behaviour, not a formal guarantee.

Why it matters:
This seam is fragile in three ways. First, the required yield count depends on the number of async hops inside the poll loop's XREAD path; if that path gains or loses an `await` (e.g. a middleware layer, a Redis client upgrade), the count silently becomes wrong and replay non-determinism returns. Second, in a real Redis environment under load, XREAD itself takes a network round-trip, so the microtask count means nothing — the loop may not even have issued the XREAD call yet. Third, the test harness papers over this by using `flushPollLoop()` with fake timers + extra yields, which is a test-only bypass of the production seam. The 100x determinism gate passes because the fake Redis is synchronous; the production replay path at `scripts/replay.ts` uses real Redis where the yield count is the only synchronisation.

A more robust alternative: make the StraddleCalculator expose a `processAllPending()` method or, better, make `computeAndPublishSnapshot()` block until the price map is stable by having the driver pass ticks directly into the price map (via a testable `injectTick` method) rather than relying on an async side-channel through Redis. The current design routes ticks through Redis even in replay, which forces an async boundary that must be bridged by timing heuristics.

If the Redis round-trip path must be preserved, the yield loop should at minimum be replaced with a concrete observable: the driver should await confirmation from the calculator that the most recently published stream entry has been read (e.g. by having `snapshotStep()` return only after the price map reflects at least one entry from the current batch).

Recommendation (pragmatic): add a `flushPendingTicks(): Promise<void>` method to `StraddleCalculator` that resolves only when the poll loop's cursor has advanced past the last-published stream ID. This turns the timing heuristic into a named, testable, observable barrier — the same pattern already applied for `processedThrough` on the output side. Track as medium-priority tech debt; the 100x gate currently masks the risk.

---

### FINDING: HistoricalFeed interface does not structurally extend BrokerFeed

Severity: Medium
File or area: `src/ingestion/historical/historical-feed.ts` lines 102–142

What it is:
The doc comment says "Implements the BrokerFeed interface" and the method list mirrors BrokerFeed methods, but `HistoricalFeed` is a separately declared interface that coincidentally duplicates the BrokerFeed surface. There is no `extends BrokerFeed` in the type declaration, and the factory `createHistoricalFeed` returns `HistoricalFeed`, not `BrokerFeed`. This means: (a) if someone adds a method to `BrokerFeed`, TypeScript will not enforce it on `HistoricalFeed`; (b) `HistoricalFeed` cannot be passed to any function that accepts `BrokerFeed` without a cast.

Why it matters:
The design goal — "slot into the SAME live pipeline wiring" — is not enforced by the type system. The contract exists only in comments. If the live pipeline's wiring function is ever typed as `(feed: BrokerFeed) => void`, the replay path will fail at the type level and require a cast, which obscures the design intent. The replay script (`scripts/replay.ts`) works around this by manually wiring `feed.onTick` rather than passing the feed to a shared factory, so the gap is not yet visible at runtime.

Recommendation:
Change the `HistoricalFeed` interface declaration to `interface HistoricalFeed extends BrokerFeed { ... }`, removing the duplicate method declarations and adding only the replay-specific extensions (`emitUpTo`, `done`, `load`). Adjust the factory return type to `HistoricalFeed` (which is now a subtype of `BrokerFeed`). This is a structural change with zero runtime impact but makes the type system enforce the contract.

---

### FINDING: fetchMarketTicks() loads all symbols in the window — no underlying filter

Severity: Medium
File or area: `src/ingestion/historical/historical-feed.ts` lines 221–228

What it is:
`fetchMarketTicks()` queries `market_ticks` with only a time-range filter (`WHERE time >= $1 AND time <= $2`). It loads every symbol's rows from the window — index ticks, any other instruments backfilled in the same period — not just the configured underlying's index symbol. The `indexSymbol` variable derived from the config on line 196 is never used in the SQL.

Why it matters:
For a single-underlying backtest this is harmless today because the hypertable only contains one index symbol worth of data. When BankNifty and Sensex are added (Phase 2), a multi-underlying backfill will cause every replay for NIFTY to also load all BankNifty and Sensex ticks, multiplying memory usage and `emitUpTo` iteration count by the number of underlyings stored. The StraddleCalculator price map will receive ticks it discards anyway, but the in-memory buffer (`buffer: HistoricalTick[]`) will contain them all, wasting memory proportionally.

Recommendation:
Add `AND symbol = $3` to the `fetchMarketTicks` query and pass `indexSymbol` as `$3`. The same filter should be applied to `fetchOptionTicks` — but option symbols are instrument-specific, so a practical approach is to filter by the underlying prefix (e.g. `WHERE symbol LIKE 'NSE:NIFTY%'`). At minimum, document the scaling concern explicitly and add a `TODO` comment before Phase 2 multi-underlying work begins.

---

### FINDING: writeSnapshot in reconstruct-straddle.ts omits the `resolution` column added by migration 008

Severity: Medium
File or area: `src/ingestion/historical/reconstruct-straddle.ts` lines 289–305

What it is:
Migration 008 adds a `resolution` TEXT column to `straddle_snapshots` specifically to allow reconstruct-straddle.ts to persist the resolution it already computes per step (stored in `snap.resolution`). The `ReconstructedSnapshot` interface and the logic both carry and populate this field correctly. However, the `writeSnapshot` INSERT statement on lines 289–305 does not include `resolution` in the column list or parameter list. The column is always written as its DB default (NULL) for every reconstructed row.

Why it matters:
This is the stated purpose of migration 008 ("closes the T-56 gap: reconstruct-straddle.ts computed the resolution per snapshot but had no DB column to store it previously"). The column exists, the data is computed, but the write is missing. Downstream consumers of `straddle_snapshots.resolution` — including the fidelity/degraded-day detection in regime-tagging.ts — will always see NULL for historical rows, defeating the purpose of the column.

Recommendation:
Add `resolution` to the INSERT in `writeSnapshot`:
```
INSERT INTO straddle_snapshots
  (time, symbol, expiry, strike, call_ltp, put_ltp, straddle_value, roc, roc_acceleration, vix, resolution)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
```
and pass `snap.resolution` as `$11`. This is a must-fix before any regime classification work reads this column.

---

### FINDING: replay script leaks Redis/DB connections and component state on error

Severity: Medium
File or area: `scripts/replay.ts` lines 267–273, 423–426

What it is:
The graceful shutdown block (`straddleCalc.stop()`, `positionMonitor.stop()`, `pool.end()`, `redisClient.quit()`) is not inside a `try/finally`. If `driver.run()` throws (line 250), the `main()` function rejects, is caught by `.catch()` on line 423 which logs and calls `process.exit(1)`, but the pool and Redis client are never closed. In the dry-run path, the pool is closed (line 210) but the Redis client is not.

Why it matters:
Leaked connections cause TimescaleDB and Redis to accumulate `IDLE` connections. For a script that is run repeatedly in development or in CI, this will exhaust the PostgreSQL connection pool over a session and require a server restart. The Redis streams also retain the poll loops' XREAD cursors until the connections time out. This is an operational reliability issue rather than a correctness one.

Recommendation:
Wrap the pipeline section in `try/finally` and move cleanup into `finally`. A reusable pattern:
```typescript
try {
  const summary = await driver.run();
  // report
} finally {
  await straddleCalc.stop();
  await positionMonitor.stop();
  await pool.end();
  await redisClient.quit();
}
```
The dry-run path should also close `redisClient` before returning.

---

### FINDING: pendingBarriers Map in PositionMonitor is not drained on stop()

Severity: Medium
File or area: `src/trading/position-monitor.ts` lines 417–422

What it is:
`stop()` sets `running = false` and returns. Any Promises registered via `processedThrough()` that have not yet resolved remain permanently pending — their resolve functions are in `pendingBarriers` but the poll loop has exited and will never call `resolveBarriers()` again.

Why it matters:
In replay, the driver always awaits `processedThrough()` before advancing the clock. If the poll loop exits between the driver's `snapshotStep()` call and the `processedThrough()` await (e.g. an error causes an early `stop()`), the driver hangs forever with no timeout or rejection. In live mode, any code that calls `processedThrough()` — even if called by a maintenance script or future feature — faces the same permanent hang. This is a hidden deadlock potential.

Recommendation:
In `stop()`, iterate `pendingBarriers` and resolve all pending promises before returning (or reject them if a rejection-based API is preferred). Example:
```typescript
async stop(): Promise<void> {
  running = false;
  for (const [, resolvers] of pendingBarriers) {
    for (const resolve of resolvers) resolve();
  }
  pendingBarriers.clear();
}
```
If rejection semantics are preferred (to signal callers that the monitor was stopped early), replace `resolve()` with `reject(new Error('PositionMonitor stopped'))`.

---

### FINDING: DB-level invariant that gaps_detected=0 implies status='complete' is comment-only

Severity: Low
File or area: `src/db/migrations/007_historical_backfill.sql` lines 161–163

What it is:
The migration comment states: "INVARIANT: if gaps_detected > 0, status MUST be 'partial' or 'gapped' — NEVER 'complete'. The writer enforces this in TypeScript; the CHECK constraint below provides a database-level guard." But the actual CHECK constraint added is only for the status enum values — there is no CHECK constraint that enforces `NOT (gaps_detected > 0 AND status = 'complete')`. The claim "the CHECK constraint below provides a database-level guard" is inaccurate; no such constraint exists in the migration.

Why it matters:
If the TypeScript guard in `finaliseRange` ever has a bug (or is bypassed by a direct SQL insert in a migration script), rows with `status = 'complete'` and `gaps_detected > 0` can exist without the DB rejecting them. The retrospection engine trusts 'complete' to mean "all data present"; a corrupted row would silently produce wrong regime classifications.

Recommendation:
Add a CHECK constraint to `backfill_ranges` in this migration (or a follow-on migration):
```sql
CHECK (NOT (gaps_detected > 0 AND status = 'complete'))
```
Update the comment to match reality. This is low-severity because the TypeScript guard is in place and tested, but the comment claiming DB-level enforcement is misleading and should be corrected regardless.

---

### FINDING: stale 'running' rows in backfill_ranges have no timeout-based detection mechanism

Severity: Low
File or area: `src/ingestion/historical/backfill.ts` line 531, `src/db/migrations/007_historical_backfill.sql` lines 186–189

What it is:
The migration comment acknowledges: "crash-safe: stale 'running' rows can be detected by checking updated_at + timeout". The current backfill logic resets a 'running' row back to 'running' and re-starts without any elapsed-time check. If two processes run backfill concurrently for the same range (e.g. two BullMQ workers), both will reset to 'running' and race to write the same candles. `ON CONFLICT DO NOTHING` on the index level prevents duplicate rows, but both workers will read the same (symbol, from, to, resolution) row, leading to a double-write attempt and two `UPDATE backfill_ranges` calls at finalisation. The winning status depends on which writer finishes last.

Why it matters:
Not a correctness issue under the current BullMQ single-worker setup, but a latent race when the system is extended to parallel workers. The `updated_at` column is present but unused by the resume logic.

Recommendation:
Add a stale-timeout check before resetting 'running' rows: if `updated_at < NOW() - INTERVAL '10 minutes'`, treat as stale and reset; otherwise log a warning and skip (or use a DB advisory lock on the row for the run duration). This is low-priority for the current single-worker setup but should be addressed before parallel backfill is enabled.

---

### FINDING: DailyRegimeTag.regime_confidence typed as `number` but returned as string by pg

Severity: Low
File or area: `src/db/schema.ts` line 368

What it is:
The interface comment says the `pg` client returns this `NUMERIC(5,4)` column as a string (because of the `setTypeParser(1700, val => val)` configuration in `src/db/client.ts`) and that callers must `parseFloat()` for arithmetic. Yet the interface declares the field as `number`. This means callers who read `DailyRegimeTag` rows and use `regime_confidence` in arithmetic get a runtime string where TypeScript promised a number.

Why it matters:
The regime-tagging engine's `classifyAndPersistDay` function writes the confidence value (it calls `writeRegimeTag`) but does not read it back. Any future code that queries `daily_regime_tags` and uses `row.regime_confidence * 100` for display or comparison will silently produce `NaN`. The same issue is noted in the `schema.ts` file header for other NUMERIC fields but this field's interface type is not updated to reflect the dual reality.

Recommendation:
Change the type to `string` and update the comment, or configure a specific pg type parser for this OID that returns a number. Precedent for the latter exists in `src/db/client.ts`. Since this is a read-rarely field at this stage, fixing the type declaration to `string` and adding a `parseFloat` in the one place it is used is the minimal fix.

---

### FINDING: on('gap') event advertised in comments but not implemented in HistoricalFeed

Severity: Low
File or area: `src/ingestion/historical/historical-feed.ts` line 29

What it is:
The module doc comment states: "HistoricalFeed surfaces gaps via a 'gap' event so downstream logging can record them. Gaps do NOT stop the feed — ticks before and after a gap are emitted normally." No `'gap'` event emission appears anywhere in the implementation. The `FixtureTick.gapMarker` field exists in the data structure, but `emitUpTo()` does not check it and no callback registration mechanism for gap events exists on the interface.

Why it matters:
Downstream components relying on gap notification for logging or alerting cannot register for an event that is never emitted. The documentation creates a false expectation. If the replay driver or a future monitoring component depends on gap events, it will never receive them.

Recommendation:
Either implement the gap event (add `onGap(callback)` to the interface and emit it in `emitUpTo()` when `tick.gapMarker === true`), or remove the claim from the doc comment and defer gap notification to a future task with a `TODO` comment. The former is the safer choice since gap visibility is explicitly an M3b input requirement per the fixture tests.

---

### FINDING: reconcileCalendarGaps uses effectiveFrom (resume checkpoint) not original `from` for gap detection

Severity: Low
File or area: `src/ingestion/historical/backfill.ts` lines 691–697

What it is:
On a resumed run, `resolvedEffectiveFrom` is set to `checkpoint_ts` — the point where the previous run left off. The gap reconciliation on line 691 passes `resolvedEffectiveFrom` as the `from` date. This means a day that falls between the original `from` date and the checkpoint — a day that was fully fetched in the first run — is not included in the calendar reconciliation for the resumed run. Any gap on those already-fetched days will not appear in `calendarGaps` for this run.

Why it matters:
The final `finaliseRange` status and `gaps_json` will only reflect gaps from `checkpoint_ts` onward, not from the original `from` date. For the typical case (token expiry after 5–10 days of a 30-day fetch), the gaps stored will be incomplete relative to the full range. The `gaps_json` comment in the migration implies it covers the entire requested range. This is a data quality / auditability issue.

Recommendation:
Pass the original `from` (not `resolvedEffectiveFrom`) to `reconcileCalendarGaps`, and ensure gap detection covers the full requested range by merging with any gaps already stored in `existing.gaps_json` on resume. Alternatively, accumulate gaps across checkpoints using the `gaps_json` field and merge on finalisation.

---

## SUMMARY

High  : 0
Medium: 6
Low   : 4

---

## VERDICT

**CONDITIONAL PASS**

The replay path's core architectural claim — that live and historical paths share one decision implementation — is substantially upheld. `computeAndPublishSnapshot` is the shared core used by both paths, `processedThrough` is a sound named barrier, `FyersAuthError`/`BackfillResumeError`/`MissingLegError` are correctly scoped, and the migration hygiene (append-only files, idempotent DDL) is good. The 100x determinism gate and drain barrier tests are the right tests.

The two items that must be fixed before production data is consumed:

1. `writeSnapshot` not persisting `resolution` (Medium, T-56 output is silently lost — the stated purpose of migration 008 column is unmet)
2. `HistoricalFeed` not structurally extending `BrokerFeed` (Medium — the "same pipeline" contract is unenforced by the type system)

The 10-microtask yield (Medium) is the most architecturally concerning seam: it is a timing heuristic in the production replay path that the test suite cannot cover because it uses fake Redis. This should be tracked as tech debt and resolved before any production backtest run depends on replay correctness.
