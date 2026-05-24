# Performance Review — M4 EOD Retrospection + Rule-Based Evolution

**Verdict: CONDITIONAL PASS**

---

## 🔴 Critical (1)

### C1 — Wrong column name in regime lookup query
**File:** `src/jobs/eod-retrospection-job.ts:167`

Query uses `WHERE tag_date = $1` but the actual column in `daily_regime_tags` is `trade_date` (defined in `src/db/migrations/008_regime_tagging.sql`). PostgreSQL throws "column tag_date does not exist" at runtime; the `?? 'RANGING'` fallback silently defaults every day to RANGING regardless of actual market conditions. All retrospection rows written while this bug is active carry the wrong `market_regime` value.

**Fix:** Change `tag_date` → `trade_date`. ✅ Fixed in this cycle.

---

## 🟡 High (2)

### H1 — N+1 query pattern — extra `entry_type` lookup per personality
**File:** `src/retrospection/brier-score.ts:63`, `src/jobs/eod-retrospection-job.ts:142`

`computeBrierScore` fetches `entry_type` from the DB for each personality, but this column is already available in the active-personalities query result. With 10 personalities, 10 redundant round-trips per EOD batch.

**Fix (next sprint):** Pass `entry_type` as a parameter to `computeBrierScore`; include it in the active-personalities SELECT.

### H2 — Missing composite index on `retrospection_results`
**File:** `src/api/routes/retrospection.ts:126-131`

`GET /retrospection` filters by `personality_id`, `market_regime`, and/or `trade_date` range with `ORDER BY trade_date DESC`. No composite index covers these filter combinations; PostgreSQL falls back to a sequential scan + sort.

**Fix (next sprint):** Add migration:
```sql
CREATE INDEX IF NOT EXISTS idx_retrospection_results_personality_regime_date
  ON retrospection_results (personality_id, market_regime, trade_date DESC);
```

---

## 🟡 Medium (4)

### M1 — Missing partial index for pending-adjustments endpoint
**File:** `src/api/routes/retrospection.ts:192-199`

`GET /retrospection/evolution/pending` has no index on `adjustments_applied`; sequential scan on entire table. Also no LIMIT on the query.

**Fix:** Partial index `WHERE adjustments_applied = FALSE AND proposed_adjustments IS NOT NULL`; add `LIMIT 50`.

### M2 — Missing index on `paper_trades.signal_id` for Brier score join
**File:** `src/retrospection/brier-score.ts:128-138`

JOIN on `pt.signal_id = ss.id` has no supporting index on `paper_trades.signal_id`; nested-loop scan on personality's full trade history.

**Fix:** `CREATE INDEX IF NOT EXISTS idx_paper_trades_signal_id ON paper_trades (signal_id) WHERE signal_id IS NOT NULL;`

### M3 — SELECT FOR UPDATE held across pure-JS computation steps
**File:** `src/retrospection/evolution-engine.ts:171-409`

The entire integrity-cap and cooldown computation (pure JS arithmetic) runs while the row lock is held, widening the contention window against the manual `/apply` API endpoint.

**Fix (next sprint):** Move pre-computation outside the transaction; re-verify inside the lock.

### M4 — `void queue.add(...)` swallows cron-registration failures silently
**File:** `src/jobs/eod-retrospection-job.ts:78-82`

Redis blip at startup → repeat job never registered → no EOD batch fires that day, operator unaware.

**Fix:** Attach `.catch(err => console.error('[eod-queue] Failed to register repeat job:', err))`.

---

## 🟢 Low (2)

### L1 — `withTransaction` overhead for single-statement INSERT
**File:** `src/jobs/eod-retrospection-job.ts:234-253`

BEGIN/COMMIT wrapper around a single INSERT with ON CONFLICT DO NOTHING is unnecessary overhead (3 round-trips instead of 1 per personality).

### L2 — `SELECT *` in retrospection query endpoints
**File:** `src/api/routes/retrospection.ts:127`

Returns all columns including potentially large `proposed_adjustments` JSONB on every row. Enumerate columns explicitly.

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 1 (fixed) |
| High     | 2 |
| Medium   | 4 |
| Low      | 2 |

**Verdict: CONDITIONAL PASS** — Critical bug fixed in this cycle. High findings (N+1 query + missing index) should be addressed before first production deployment.
