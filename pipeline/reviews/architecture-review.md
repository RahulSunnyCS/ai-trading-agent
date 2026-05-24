# Architecture Review — M4 EOD Retrospection + Rule-Based Evolution

**Backend lens applied**
**Verdict: CONDITIONAL PASS**

---

## 🟡 High (2)

### H1 — Evolution engine UPDATE runs before retrospection_results INSERT — approval workflow broken
**File:** `src/jobs/eod-retrospection-job.ts` (step ordering), `src/retrospection/evolution-engine.ts:353-362`

`runEvolutionEngine` is called before `INSERT INTO retrospection_results`. When `EVOLUTION_REQUIRE_APPROVAL=true`, the engine issues `UPDATE retrospection_results SET proposed_adjustments = ... WHERE personality_id = $2 AND trade_date = $3` — but the row does not exist yet. PostgreSQL silently updates 0 rows. The subsequent INSERT then writes `proposed_adjustments = null`, permanently overwriting the proposal. The entire human-approval safety workflow is inoperative in the default configuration.

**Fix:** Swap order — INSERT the retrospection row first, then call `runEvolutionEngine`. ✅ Fixed in this cycle.

### H2 — Evolution rule delta signs are inverted — engine degrades performance each cycle
**File:** `src/retrospection/evolution-engine.ts:133-148`

`winRate < 0.4` (too many weak trades) uses `delta = -0.05`, which *lowers* `min_probability`, making the filter *less* strict — admitting more weak signals. `winRate > 0.7` uses `delta = +0.03`, which *raises* `min_probability`, making the filter *more* strict over time. Both are backwards. Over multiple cycles this silently drives low-performing personalities toward lower bars and high-performing ones toward 0.90 clamp.

**Fix:** Swap signs: `winRate < 0.4` → `delta = +0.05`; `winRate > 0.7` → `delta = -0.03`. ✅ Fixed in this cycle.

---

## 🟡 Medium (4)

### M1 — `withTransaction` singleton breaks evolution engine testability
**File:** `src/retrospection/evolution-engine.ts:38-39,156`; `src/db/client.ts:67-87`

`runEvolutionEngine` accepts `pool: Pool` but `withTransaction` always uses the module singleton. The most complex safety-critical module is untestable without whole-module mocking, while all other retrospection modules are pool-injectable.

**Fix (next sprint):** Refactor `withTransaction` to accept an optional external pool, or extract a factory `createEvolutionEngine(pool: Pool)`.

### M2 — `eodQueue` Redis connection never closed on shutdown
**File:** `src/server/index.ts:123-124,424-436`

`createEodRetrospectionQueue()` opens a Redis connection that is decorated on the server. On shutdown, the Worker is closed but the Queue is never closed — leaving an open connection that can prevent the Bun event loop from exiting cleanly in Railway/Fly.io deployments.

**Fix:** Add `await eodQueue.close()` to the `shutdown` function before `server.close()`.

### M3 — Manual trigger enqueues `trade_date` but worker ignores it
**File:** `src/api/routes/retrospection.ts:158-166`; `src/jobs/eod-retrospection-job.ts:104-117`

Worker handler declared as `async (_job)` — `job.data.trade_date` is never read. Every manual trigger always processes today's date, not the requested date. Historical backfill via the API is silently broken.

**Fix:** Read `job.data.trade_date ?? todayIST` in the worker handler.

### M4 — `from`/`to` query params not validated against `DATE_PATTERN` in GET /retrospection
**File:** `src/api/routes/retrospection.ts:113-121`

POST routes validate dates with `DATE_PATTERN.test()`; GET route does not. Invalid dates like `?from=yesterday` reach the DB and return a 500 instead of a 400.

**Fix:** Apply `DATE_PATTERN.test()` to `q.from` and `q.to` before using them.

---

## 🟢 Low (3)

### L1 — `PersonalityConfigM2` optional fields mask a missing DB guarantee
**File:** `src/db/schema.ts:434-437`

`lastEvolvedAt?` and `evolutionConsecutiveApplications?` should be required (nullable/defaulted in the DB). Making them optional lets stale test fixtures pass while hiding regressions. Fix: make required; update fixtures.

### L2 — `SELECT *` in both GET endpoints
**File:** `src/api/routes/retrospection.ts:126-132,193-200`

Returns the full `proposed_adjustments` JSONB and all columns including any added by future migrations. Define explicit column lists and a typed response interface.

### L3 — UUID regex too loose (also in security report)
**File:** `src/api/routes/retrospection.ts:47`

`/^[0-9a-fA-F-]{36}$/` accepts 36 dashes. Use the canonical 8-4-4-4-12 pattern already used in the Fastify JSON schema for the apply route.

### L4 — No unit tests for any retrospection/evolution module
**File:** `src/retrospection/` (entire directory)

The most complex module (evolution engine) has zero unit tests. The `NUMERIC-as-string` and `Boolean('-5.00')` traps — correctly handled in code — would ideally be regression-tested.

---

## Summary

| Severity | Count |
|----------|-------|
| High     | 2 (both fixed) |
| Medium   | 4 |
| Low      | 4 |

**Verdict: CONDITIONAL PASS** — Both High findings fixed in this cycle. Medium findings should be addressed before production deployment.
