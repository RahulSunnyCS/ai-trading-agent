# Performance Review Report

## Summary
Verdict: CONDITIONAL PASS

The codebase is well-structured for Phase 1 scale (single personality, one position at a time). All hypertable queries in the reviewed files include time-range filters. The main blockers for Phase 2 scale are the per-snapshot DB query pattern in the entry engine, the per-snapshot DB write pattern in the position monitor, and the unbounded `GET /api/trades` route. Several medium-severity issues will degrade gracefully at current scale but will become meaningful problems at 10-personality Phase 2 load.

---

## Findings

### 🔴 Critical (blocks Gate 2)

**FINDING: GET /api/trades — unbounded full-table scan with no time filter**
File and line: `src/api/routes/trades.ts`, lines 91–95
What it is: The route `GET /api/trades` fetches every open paper trade with `SELECT * FROM paper_trades WHERE status = 'open'`. There is no date/time range filter. The comment in the code acknowledges this ("for live positions there is no sensible cutoff") but does not address the hypertable scan risk. Unlike `market_ticks` and `straddle_snapshots`, `paper_trades` is a plain table (not a hypertable), so TimescaleDB chunk exclusion does not apply — but as positions accumulate over months, this query will scan the entire table on every dashboard refresh. At Phase 2 scale with 10 personalities trading daily, the table will grow quickly.
Impact at scale: At 10 personalities × multiple trades per day × months of operation, a full `WHERE status = 'open'` scan with no time bound will grow in cost linearly. If an operator forgets to close an old position, it stays in the "open" bucket forever and this scan grows unboundedly. At 10x load this hits every dashboard refresh.
How to fix it: Add a date filter (e.g. `AND entry_time > NOW() - INTERVAL '7 days'`) or a `LIMIT` cap consistent with the `paper-trades.ts` route. At minimum add an index on `(status, entry_time DESC)` so the query can use an index scan instead of a sequential scan.

---

### 🟡 Medium (should fix before Phase 2 scale)

**FINDING: Per-snapshot DB query in the entry engine hot path**
File and line: `src/trading/entry-engine.ts`, lines 250–256
What it is: `_handleSnapshot()` runs a `SELECT id FROM paper_trades WHERE status = 'open' LIMIT 1` on every straddle snapshot — every 15 seconds. The query checks whether any open position exists before the engine proceeds. This is one DB round-trip per snapshot, always, even when the time-gate has already rejected the snapshot. At Phase 1 (single personality) the cost is one query per 15 seconds, which is acceptable. At Phase 2 (10 personalities each with their own entry engine instance) this is 10 queries per 15 seconds hitting the same table with no index on `status`.
Impact at scale: With 10 personalities running, the entry-engine stage alone will issue 40 queries per minute against `paper_trades` just for the open-position check. If the query runs before the time gate (which it currently does not — the time gate fires first, which is good), this would be worse. As written, the DB query only fires inside the entry window, but even so it fires on every snapshot that passes the time and date gates.
How to fix it: Add an index on `paper_trades(status)` in the migration so the `WHERE status = 'open'` lookup uses an index rather than a sequential scan. Alternatively, maintain an in-memory flag (set when a trade opens, cleared when it closes) that the entry engine checks first, falling back to the DB only on process restart. This is safe because entry-engine and position-monitor are both in the same process.

**FINDING: Per-position, per-snapshot DB write in the position monitor**
File and line: `src/trading/position-monitor.ts`, lines 304–308
What it is: Inside `_handleSnapshot()`, for every open position on every snapshot, the monitor issues a separate `UPDATE paper_trades SET lowest_straddle_value_seen = $1 WHERE id = $2`. At Phase 1 with one position this is one update per 15 seconds. At Phase 2 with 10 personalities each potentially holding a position, this becomes 10 separate UPDATE statements per 15-second snapshot, each a round-trip to the database.
Impact at scale: At 10 positions × 4 snapshots per minute × market hours (6.25 h) = ~1,500 individual UPDATE queries per day just for trailing stop updates. Each is a round-trip. If these are not batched and the DB is under any other load (retrospection jobs, API queries), latency will accumulate.
How to fix it: Batch all trailing-stop updates into a single SQL statement using `UPDATE paper_trades SET lowest_straddle_value_seen = CASE id WHEN $1 THEN $2 WHEN $3 THEN $4 ... END WHERE id = ANY($n)`. For Phase 1 this is overkill, but it is the right pattern to establish before Phase 2.

**FINDING: Decimal.js object allocation on every snapshot for every position**
File and line: `src/trading/trigger-engine.ts`, lines 93–97 and 107–152; `src/trading/position-monitor.ts` line 297
What it is: `evaluateTriggers()` creates 5 `new Decimal(...)` objects per call (current, entry, lowest, todayPnl, maxLoss) plus additional Decimal objects per trigger check (hardSlThreshold, trailingThreshold, profitTargetThreshold, and intermediate results). `updateTrailingStop()` creates 2 more. In total, each snapshot evaluation for one position allocates approximately 10–15 short-lived Decimal objects. These are created and immediately discarded, placing pressure on the garbage collector [the process that periodically finds and frees unused memory].
Impact at scale: At Phase 2 — 10 positions × 4 snapshots per minute × 6.25 market hours — that is approximately 150,000 short-lived Decimal allocations per day, plus the GC pauses to free them. In a single-threaded Bun runtime, GC pauses directly add latency to the snapshot handler. For a paper-trading research tool this is unlikely to be a real problem, but it warrants monitoring when Phase 2 ships.
How to fix it: Pre-parse the config values into Decimal objects once in `loadTriggerConfig()` rather than constructing `new Decimal(config.hardSlPct)` etc. on every call. Position values (entry, lowest) can be cached as Decimal on the OpenPosition object rather than re-parsed from strings each snapshot. This reduces per-call allocations from ~15 to ~3 (current, and the arithmetic temporaries that cannot be avoided).

**FINDING: `streamConsume` uses the module-level singleton Redis client, not the injected one**
File and line: `src/redis/client.ts`, lines 114–173; `src/trading/entry-engine.ts`, lines 113–119; `src/trading/position-monitor.ts`, lines 208–226
What it is: `streamConsume()` is called by both the entry engine and the position monitor. It uses the module-level `redis` singleton (exported from `client.ts`) rather than the injected `Redis` instance passed to the constructor. The constructor comment acknowledges this explicitly ("redis is passed in for interface compatibility … we do not store it"). This means the injected test Redis client is silently ignored at the `streamConsume` layer, and both consumers share one connection for all their blocking XREADGROUP calls. A single ioredis connection handles one blocking operation at a time; if two consumers are waiting simultaneously on the same connection, one will block the other.
Impact at scale: With multiple consuming services (entry engine + position monitor both calling `streamConsume` simultaneously), they share one underlying Redis connection for all their blocking reads. This is a latency risk: a 2,000 ms XREADGROUP block from one consumer holds the connection while the other waits. At Phase 2 with more consumer loops, this will cause increasing latency jitter.
How to fix it: Either (a) have `streamConsume` accept a Redis instance parameter and use it, or (b) have `streamConsume` call `redis.duplicate()` internally for each consumer loop, giving each consumer its own non-blocking connection. Option (b) mirrors the correct pattern already used in `websocket.ts`.

**FINDING: Redis stream has no MAXLEN cap — unbounded memory growth**
File and line: `src/redis/client.ts`, line 34; `src/ingestion/straddle-calc.ts`, line 236
What it is: `XADD` and `streamPublish` both use the bare `'*'` ID without a `MAXLEN` option. The `straddle.values` stream accumulates one entry every 15 seconds. Over a week of trading (5 days × 6.25 hours × 240 snapshots/hour) that is approximately 7,500 entries per week, roughly 60,000 entries per month. Redis stores streams in memory. Without a trim, the stream grows indefinitely and will eventually exhaust Redis memory, causing all Redis operations to fail.
Impact at scale: At current snapshot rate, Redis memory consumption grows by roughly 7,500 entries per week. Each entry carries 8 fields (time, underlying, spot, atmStrike, cePrice, pePrice, straddleValue, vix). At Phase 2 with more streams, memory pressure compounds. A Redis out-of-memory event will crash all consumers simultaneously.
How to fix it: Add `MAXLEN ~ 10000` (approximately) to the XADD call. The tilde (`~`) tells Redis to trim approximately rather than exactly, which is efficient. 10,000 entries covers roughly 42 hours of snapshots at 15-second intervals — more than enough for crash recovery while bounding memory. Change `redis.xadd(STREAM_STRADDLE, "*", ...flatFields)` to `redis.xadd(STREAM_STRADDLE, "MAXLEN", "~", 10000, "*", ...flatFields)`.

**FINDING: `GET /dashboard/summary` has no result-count cap**
File and line: `src/api/routes/dashboard.ts`, lines 181–188
What it is: The dashboard summary query returns all paper trades for today, ordered by `entry_time ASC`, with no `LIMIT` clause. On most days with Phase 1 (one personality, one trade per day) this returns at most a handful of rows. But at Phase 2 with 10 personalities each potentially trading multiple times per day, and with historical data accumulating, this query can return dozens or hundreds of rows without any bound.
Impact at scale: At Phase 2 with 10 personalities and multiple entries per day per personality, the summary query could return 50–100 rows on a busy day. More importantly, there is no protection against an operator accidentally querying a multi-month range or a date with many retrospection entries. Adding a `LIMIT` cap is cheap insurance.
How to fix it: Add `LIMIT 500` (or a suitable cap) to the query. The summary is only meant to show today's trades; a cap of 200–500 rows is more than sufficient and prevents runaway result sets.

**FINDING: `closeTrade` issues a separate SELECT before each UPDATE — two round-trips per close**
File and line: `src/trading/paper-trade-executor.ts`, lines 156–168 and 191–212
What it is: `closeTrade()` first SELECTs `straddle_at_entry`, `lots`, and `lot_size` from the DB to compute P&L, then issues a separate UPDATE to set the trade as closed. This is two sequential database round-trips per trade closure. The code comment explains the design choice (avoid stale caller-supplied values), which is correct reasoning, but the implementation is inefficient.
Impact at scale: At Phase 1 (one closure per session) this is negligible. At Phase 2 with 10 personalities each closing positions daily, and with multiple closures happening in rapid succession near EOD (when all 10 positions close at once), 10 sequential SELECT-then-UPDATE pairs will add measurable latency to the EOD close-out window.
How to fix it: Combine into a single `UPDATE ... RETURNING` or a `WITH cte AS (SELECT ...) UPDATE ...` CTE. For example: `UPDATE paper_trades SET exit_time = $1, ... gross_pnl = (straddle_at_entry - $exitValue) * lots * lot_size, ... WHERE id = $id RETURNING id`. The P&L formula can be computed in SQL directly, eliminating the SELECT.

---

### 🟢 Low / Informational

**FINDING: VixFeed has no retry backoff — polls NSE at full rate even after repeated failures**
File and line: `src/ingestion/vix-feed.ts`, lines 235–296
What it is: When the NSE API returns an error (HTTP 4xx/5xx, network failure, or parse error), `_poll()` logs a warning and returns immediately. The next poll attempt happens after the full `pollIntervalMs` (default 60 seconds). This is correct behaviour — there is no tight retry loop. However, there is also no exponential backoff [gradually increasing the wait time between retries to avoid hammering a struggling server] after repeated failures. If NSE is returning 403 errors (which it does when it detects bot-like access), the feed will keep sending one request per minute indefinitely.
Impact at scale: For a personal research tool polling once per minute, the risk is low. NSE occasionally blocks bot access for hours. A simple failure counter that backs off to every 5 minutes after 3 consecutive failures would make this more resilient, but it is not critical.

**FINDING: `evaluateTriggers` priority check for EXIT_WINDOW after EOD is logically unreachable in normal config**
File and line: `src/trading/trigger-engine.ts`, lines 130–133
What it is: The code checks `nowHHMM >= config.exitCutoffTime` as a separate step after checking `nowHHMM >= config.eodExitTime`. The comment acknowledges this is a safety net. However, the EOD check fires at `config.eodExitTime` (default `15:25`) and the EXIT_WINDOW check fires at `config.exitCutoffTime` (default `15:30`). In normal config where `eodExitTime < exitCutoffTime`, the EOD trigger will always fire first and the EXIT_WINDOW check will never be reached for any position — it becomes dead code.
Impact at scale: No performance impact. This is a minor code clarity issue. The comment explains the intent but the code path is never executed under normal configuration. Document this explicitly or consider removing the check and handling the unusual config case differently.

**FINDING: Pool size is at pg default (10 connections) with no explicit configuration**
File and line: `src/db/client.ts`, lines 14–16
What it is: The PostgreSQL connection pool is created with default settings, which gives a maximum of 10 connections. No `max`, `min`, `idleTimeoutMillis`, or `connectionTimeoutMillis` is set. At Phase 2 with multiple concurrent consumers (entry engine, position monitor, API routes, retrospection jobs) all hitting the same pool, connection exhaustion is possible if any slow query holds a connection during peak load.
Impact at scale: At 10 personalities with concurrent snapshot handlers, API requests, and EOD retrospection running simultaneously, 10 pool connections may be insufficient. A request that cannot acquire a connection in time will queue and add latency, potentially causing a cascade where slow DB responses back up the connection queue.
How to fix it: Explicitly configure `max: 20` (or tune to measured load) and set `connectionTimeoutMillis: 5000` so slow-connection events are surfaced as errors rather than silent hangs. Add a pool error handler: `pool.on('error', (err) => console.error('pg pool error', err))`.

**FINDING: WebSocket `broadcastLoop` has no maximum reconnect delay — 500 ms flat backoff**
File and line: `src/api/websocket.ts`, lines 70–74
What it is: When an XREAD error occurs (e.g. Redis restart, network blip), the loop catches the error, logs it, waits 500 ms, and retries. This fixed 500 ms backoff does not increase on repeated failures. If Redis is down for an extended period, every connected WebSocket client will generate one Redis connection attempt every 500 ms. With multiple clients this creates a reconnection storm [many clients simultaneously hammering a recovering service].
Impact at scale: For a small internal dashboard with a handful of tabs, the impact is low. But it is better practice to use exponential backoff with a cap (e.g. start at 500 ms, double each failure, cap at 30 seconds).

**FINDING: `clock.tick()` callbacks cannot be deregistered — guard flags as the only cancellation mechanism**
File and line: `src/ingestion/straddle-calc.ts` line 117; `src/ingestion/vix-feed.ts` line 175; `src/trading/position-monitor.ts` line 158
What it is: All three modules that use `clock.tick()` rely on an `_running` boolean flag to cancel the callback after `stop()` is called, because `VirtualClock` has no deregistration API. This is a deliberate design decision documented in each file. The concern here is that if a module is accidentally restarted (e.g. `start()` called twice, bypassing the guard), a second tick callback is registered with no way to deregister the first. The `_running` guard on `start()` prevents this in the happy path, but it creates a fragile invariant.
Impact at scale: No current performance impact. At Phase 2 with more modules using `clock.tick()`, the risk of accidental double-registration grows. Consider adding tick-deregistration to `VirtualClock` and `RealClock` (return a cancellation token from `tick()`) so the guard flag is not the sole protection.

---

## Summary Table

| Severity | Count |
|---|---|
| Critical | 1 |
| Medium   | 6 |
| Low      | 4 |

**Verdict: CONDITIONAL PASS**

The single critical finding (unbounded `GET /api/trades` scan) must be addressed before Phase 2 ships. The medium findings — particularly the per-snapshot entry-engine DB query, the per-position trailing-stop UPDATE, the shared Redis connection for consumer groups, and the unbound Redis stream — should all be resolved before Phase 2 personality scale-out begins. The low findings are informational and can be addressed at any point.
