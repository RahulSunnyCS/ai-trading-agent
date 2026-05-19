# Performance Review — Milestone 2

Reviewer: Performance Reviewer
Date: 2026-05-19

---

## Verdict: CONDITIONAL PASS

The implementation is largely sound for a paper-trading research tool at Phase 1 scale. Two patterns deserve attention before the system runs under live market conditions: sequential Redis reads inside a hot-path function called on every signal, and a PaperTradeExecutor object that is allocated on every trade open rather than once. The remaining findings are low-severity or explicitly accepted design decisions.

---

### 🔴 Critical (blocking)

_None._

---

### 🟡 Medium (should fix)

---

**FINDING: getMacroContext reads 5 Redis keys sequentially inside a signal-critical path**
Severity: Medium
File and line: `src/ingestion/global-macro-feed.ts` lines 443–480
What it is: `getMacroContext()` fetches five Redis keys inside a `for` loop, making five separate round-trips to Redis one after another. This function is called by `PeakDetectionEngine._handleSnapshot()` every time a momentum exhaustion signal fires (`src/signals/peak-detection-engine.ts` line 500). The five round-trips are serial: key 2 does not start until key 1 has replied.
Impact at scale: At current signal cadence (signals are rare, not every 15 seconds), this is tolerable. However, a high-volatility session could produce several signals in rapid succession. Each signal blocks for 5 × RTT (Redis round-trip time) before it can be written to the DB and published to the stream. On a hosted Redis instance (even with a few milliseconds RTT), this adds 10–25 ms of unnecessary latency per signal. The fix is a one-line change.
How to fix it: Replace the `for` loop with `Promise.all` over all five `redis.get()` calls. Redis handles concurrent GET commands efficiently and this change halves or eliminates the sequential wait:
```
const keys = INSTRUMENTS.map(inst => `macro:${inst.key}`);
const values = await Promise.all(keys.map(k => redis.get(k)));
```

---

**FINDING: PaperTradeExecutor and QuantiplyStub allocated on every trade open**
Severity: Medium
File and line: `src/signals/personality-router.ts` line 521
What it is: `_openTradeForPersonality()` calls `new PaperTradeExecutor(...)` and `new QuantiplyStub()` inside the loop that iterates over passing personalities. With up to 4 personalities opening trades on a single signal, this creates 4 executor objects per signal event. The objects are light-weight, but they are constructed, used once, and immediately discarded.
Impact at scale: Not a memory leak (GC will collect them), but it creates needless allocation pressure on the garbage collector. More importantly, it is an architectural smell: the executor wraps the DB pool and a Quantiply client, neither of which changes between calls. If QuantiplyStub is ever replaced with a real HTTP client that maintains a connection pool, per-call construction would leak those resources.
How to fix it: Construct `PaperTradeExecutor` and `QuantiplyStub` once in the `PersonalityRouter` constructor (or lazily on first use) and store them as private fields. Pass the stored instances into `_openTradeForPersonality()`.

---

**FINDING: `fetchDailyState` queries run with a non-sargable [index-unfriendly] time filter**
Severity: Medium
File and line: `src/signals/personality-filter.ts` lines 136–148 and 154–160; also `src/trading/position-monitor.ts` lines 549–558
What it is: Both `fetchDailyState` and `_getOpenPositionsWithPersonality` filter by trading date using `DATE(entry_time AT TIME ZONE 'Asia/Kolkata') = $2::date`. Wrapping a column in a function call (`DATE(...)`) prevents PostgreSQL from using the `idx_paper_trades_status_entry_time` index on `entry_time`, forcing a scan of all rows that match the `status` filter before the date check can be applied. At low trade counts this is invisible. The `paper_trades` table is not a hypertable, so there is no automatic time-partitioning to rescue it.
Impact at scale: After a few months of paper trading at 4 trades per day × 10 personalities, the table will hold tens of thousands of rows. Every 15-second snapshot will trigger a scan of all `status = 'open'` rows before the date filter eliminates the closed ones. With 10,000 rows, each tick costs a full index scan of the status index plus a function evaluation per row.
How to fix it: Replace the function-wrapped filter with a range predicate that PostgreSQL can use with the existing `idx_paper_trades_status_entry_time` composite index:
```sql
-- Compute midnight IST in the application and pass as a parameter:
AND entry_time >= $date_midnight_ist
AND entry_time <  $date_midnight_ist + INTERVAL '1 day'
```
The IST midnight timestamp can be computed in TypeScript using the same UTC+5:30 offset arithmetic already present in the codebase.

---

**FINDING: Personality configs re-queried on every signal in PersonalityRouter**
Severity: Medium
File and line: `src/signals/personality-router.ts` lines 376–406 (`_handleSignal`, Step 5)
What it is: On every signal, the router queries `SELECT * FROM personality_configs WHERE is_active = TRUE AND phase <= 1`. With signals arriving roughly every 15 seconds during market hours (6.25 hours = ~1500 signals/day), this executes 1500 DB queries against `personality_configs` per trading session to read a table of 10 rows that changes at most once per day (via the evolution engine at EOD or the API). The PositionMonitor avoids exactly this problem by loading personality configs once at startup and caching them. The router does not.
Impact at scale: The query itself is fast (10 rows), but the round-trip cost accumulates. More critically, if the pool is under pressure from other concurrent queries (position monitoring, trailing stop updates), these 1500/day personality reads add unnecessary competition for pool connections.
How to fix it: Mirror the PositionMonitor's pattern: load personality configs at `start()` time and store them in a `Map<string, PersonalityConfig>`. Expose a `refreshPersonalityCache()` method for the rare case where configs change mid-session (API update or EOD evolution). This is already done correctly in PositionMonitor — copy that pattern.

---

### 🟢 Low / Informational

---

**FINDING: `parseBlockedDates()` parses the BLOCKED_DATES env var on every filter call**
Severity: Low
File and line: `src/signals/personality-filter.ts` line 255 (inside `runPersonalityFilter`, Stage 1)
What it is: `parseBlockedDates()` calls `JSON.parse(process.env["BLOCKED_DATES"])` on every invocation of `runPersonalityFilter`. With 10 personalities per signal, this parses the same JSON string 10 times per signal event. The array is typically short (a handful of date strings per year) and JSON.parse is fast, but there is no reason to repeat the work.
Impact at scale: Negligible in absolute terms, but worth noting because `runPersonalityFilter` is described as a pure synchronous function with no I/O. A module-level cached parse would be more consistent with that design intent and remove 10 × N redundant JSON.parse calls per trading day.
How to fix it: Parse `BLOCKED_DATES` once at module load time (similar to how `POLL_WINDOW` is parsed at the top of `global-macro-feed.ts`) and export the result as a module-level constant.

---

**FINDING: `spot_at_entry` queried from DB on every tick for every ReducerManager position**
Severity: Low
File and line: `src/trading/management/reducer.ts` lines 180–183
What it is: `ReducerManager.evaluatePosition()` issues a `SELECT spot_at_entry FROM paper_trades WHERE id = $1` on every straddle snapshot (every 15 seconds) for every open position managed by the Reducer style. With up to 2 open Reducer positions, this is 2 extra DB queries every 15 seconds = 3,000 extra queries per trading session. The module-level comment explicitly acknowledges this as an accepted limitation for Phase 1.
Impact at scale: At current scale (2 Reducer positions maximum), this is minor. If Phase 2 expands to BankNifty/Sensex with more positions, the per-tick query count will multiply. The `spot_at_entry` value never changes for a given trade — it is written once at entry and never updated. Querying it on every tick is redundant.
How to fix it: Add `spot_at_entry` to the `OpenPosition` interface (or the `OpenPositionWithPersonality` local type in position-monitor.ts) so it is fetched once per snapshot in `_getOpenPositionsWithPersonality()` alongside the other position fields, and passed through to the handler. This eliminates the per-tick SELECT entirely.

---

**FINDING: Advisory lock contention causes conservative false-negative on simultaneous personality trade opens**
Severity: Low
File and line: `src/trading/portfolio-risk.ts` lines 222–251
What it is: `pg_try_advisory_xact_lock(42)` is a non-blocking attempt — if another transaction holds it, the attempt returns false immediately and the calling personality is told "MAX_LEGS_EXCEEDED" even if the actual open position count is 0. With the PersonalityRouter currently serialising trade opens sequentially (Step 10 in `_handleSignal`), this contention scenario cannot happen in normal operation. However, if the serialisation is ever changed to concurrent opens, up to 9 of 10 personalities would be falsely rejected.
Impact at scale: No current impact. The code comment accurately explains the conservative-failure design intent. Worth tracking as a constraint: if the serialisation is relaxed in a future sprint, the advisory lock logic will need revisiting to avoid starving legitimate trade opens.
How to fix it: No action needed for Phase 1. Document the dependency between the sequential-open serialisation in `personality-router.ts` and the advisory lock behaviour in `portfolio-risk.ts` so a future sprint author knows to review both.

---

**FINDING: `Array.shift()` used to trim snapshot history — O(n) on every snapshot**
Severity: Low
File and line: `src/signals/peak-detection-engine.ts` line 420
What it is: When the snapshot history buffer hits 200 entries, the oldest entry is removed with `state.snapshots.shift()`. `Array.shift()` in JavaScript/TypeScript removes the first element by shifting all remaining elements left — an O(n) operation where n = 200. This happens on every snapshot once the buffer is full, i.e., approximately every 15 seconds after the first 50 minutes of trading.
Impact at scale: With MAX_HISTORY = 200 and typically 1–3 underlyings active in Phase 1 (NIFTY only for now), the cost is O(200) = negligible. If Phase 2 adds BankNifty and Sensex simultaneously, there will be 3 buffers of 200 elements each being shift()ed every 15 seconds. Still small in absolute terms for this system. A circular buffer (ring buffer) would make this O(1) — the ScheduledSignalEmitter already uses exactly this pattern correctly at `src/signals/scheduled-signal-emitter.ts` lines 421–431.
How to fix it: Replace the `snapshots` array + `shift()` pattern with a circular buffer, mirroring the `recentValues` implementation in `ScheduledSignalEmitter`. Low priority given the bounded size, but worth aligning the two modules for consistency.

---

**FINDING: `GET /personalities/:id/performance` makes two sequential DB queries**
Severity: Low
File and line: `src/api/routes/personalities.ts` lines 438–472
What it is: The performance endpoint first queries `SELECT id FROM personality_configs WHERE id = $1` to check existence, then issues a second query for the aggregated trade stats. Both queries are necessary, but they run sequentially rather than in parallel, adding one extra round-trip to every API call.
Impact at scale: This is an API endpoint called by a human operator, not by the hot signal path. At single-operator usage the extra round-trip (a few milliseconds) is imperceptible. Worth noting only because the sequential pattern could be refactored into a single query using `LEFT JOIN` or `EXISTS` if the endpoint ever becomes performance-sensitive.
How to fix it: Merge the existence check into the stats query by joining `personality_configs`:
```sql
SELECT pc.id, COUNT(...) ...
FROM personality_configs pc
LEFT JOIN paper_trades pt ON pt.personality_id = pc.id
WHERE pc.id = $1
GROUP BY pc.id
```
A missing personality returns a row with `pc.id IS NULL` (or no row), letting the caller detect 404 in a single query. Low priority.

---

### ✅ No issues found in

- **N+1 query pattern in personality-router.ts**: The router correctly uses `Promise.all` to fetch all personality `DailyState` records in parallel (Step 6). With 10 personalities this fires 20 DB queries simultaneously rather than sequentially — the pool handles concurrent queries efficiently. This is the right pattern.
- **PositionMonitor query pattern**: `_getOpenPositionsWithPersonality()` loads all open positions for today in a single query with `status = 'open'` filtered by date. The `idx_paper_trades_status_entry_time` composite index covers the status filter; the date function issue is noted separately above but the underlying query structure is sound (one query per tick, not one per position).
- **AdjusterManager transaction integrity**: The roll transaction (BEGIN → SELECT → UPDATE → INSERT → COMMIT) is correctly structured. Client checkout, error handling, and `client.release()` in `finally` are all present. No connection leak risk.
- **Redis consumer group isolation**: PeakDetectionEngine (`peak-detection` group), ScheduledSignalEmitter (`fallback-signals` group), and PersonalityRouter (`personality-router` group) each use their own consumer group name on the `straddle.values` stream. Messages are therefore delivered to all three independently — no group steals messages from another. This is correct.
- **Peak detection in-memory history**: Bounded at 200 snapshots per underlying via explicit trim. With NIFTY only (Phase 1), memory footprint is approximately 200 × ~80 bytes per `SnapshotEntry` ≈ 16 KB. Negligible. Grows linearly with underlyings, which is acceptable.
- **Yahoo Finance polling**: Five instruments are fetched in parallel via `Promise.allSettled` inside `_doPoll()`. A 5-second per-instrument timeout prevents any single stalled fetch from blocking the poll cycle. The 5-minute poll interval is a sensible rate-limit for a public endpoint.
- **DB index coverage for migration 004 queries**: `idx_paper_trades_personality` covers `WHERE personality_id = $1` (used by `fetchDailyState`, `AdjusterManager`'s open-legs count, and the performance API). `idx_paper_trades_parent` covers roll chain reconstruction. The `idx_paper_trades_status` index from migration 002 covers `WHERE status = 'open'` (used by portfolio-risk and position-monitor). Coverage is adequate for Phase 1 query patterns.
- **Portfolio daily stop query**: `src/trading/portfolio-risk.ts` line 147 uses `entry_time >= (NOW() AT TIME ZONE 'Asia/Kolkata')::date::timestamptz` which is a range predicate (not a per-row function call) and is index-friendly via the `idx_paper_trades_status_entry_time` index.
- **VIX staleness gate**: Correctly implemented with a fail-closed design — stale VIX blocks all new opens. The in-memory `_lastVixTimestampMs` avoids any DB or Redis query on every signal.
- **Redis stream BLOCK timeout**: All three consumers use BLOCK 2000 ms (2-second timeout), which keeps shutdown latency below one timeout window while avoiding CPU-busy polling. Correct.
- **Personality config cache in PositionMonitor**: Loaded once at `start()` and reused for the session lifetime. This correctly avoids per-tick DB queries for configs that change at most once per day.

---

## Summary

| Severity | Count |
|---|---|
| Critical | 0 |
| Medium | 4 |
| Low | 5 |

The system is well-structured for a research tool at this scale. The medium findings are all addressable with small, isolated changes — none require architectural revision. The most impactful fix is making `getMacroContext` parallel (one line change). The personality config caching in the router mirrors a pattern already correctly implemented in PositionMonitor.
