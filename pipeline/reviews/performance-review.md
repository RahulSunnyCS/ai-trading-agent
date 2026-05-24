PERFORMANCE REVIEW REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━

Scope: M3a — historical backfill, straddle reconstruction, replay driver, position monitor, regime tagging
Branch: claude/hopeful-lovelace-Kaqsz
Reviewer: performance-reviewer agent
Date: 2026-05-24

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FINDING: N+1 per-step leg queries in straddle reconstructor
Severity: High
File and line: src/ingestion/historical/reconstruct-straddle.ts, lines 408–465 (the while loop) and queryLegAtOrBefore (line 202)
What it is: For every cadence step in the reconstruction range, the code issues three separate database round-trips: one for the index price, one for the CE option price, and one for the PE option price. At the default 15-second cadence over a single 6-hour trading day (09:15–15:30 IST), that is approximately 1,500 steps × 3 queries = 4,500 individual database calls per day. Over a typical 6-month backtest (≈130 trading days), this scales to roughly 585,000 sequential database round-trips.
Impact at scale: Each call has a measurable round-trip cost (even locally, typically 1–5 ms per call). At 1,500 steps/day across 130 days, the reconstruction of a single underlying for 6 months would take somewhere between 10 minutes and 2 hours of pure database wait time, excluding all compute. With 5-minute candle resolution (72 steps/day) the cost drops significantly, but at 15-second resolution for a year of data it becomes prohibitive overnight.
How to fix it: Replace the per-step queries with a small number of bulk range queries. Before the step loop, fetch all index ticks for the full reconstruction window in one query (already sorted by time ASC). Then fetch all CE and PE option ticks for the window in one query each. Build an in-memory sorted array for each symbol. During the per-step loop, use a binary search or a walking pointer to find the "at-or-before" value — this is O(log n) per step and requires zero additional database calls. The 24-hour lookback window constraint in queryLegAtOrBefore is already well-suited to a day-at-a-time chunked approach: fetch one day of raw data, loop through all steps for that day, then advance to the next day. The hypertable discipline is fully preserved because the range query still carries explicit time bounds.

---

FINDING: Full-window in-memory load in HistoricalFeed with no size guard
Severity: Medium
File and line: src/ingestion/historical/historical-feed.ts, lines 361–378 (load method) and lines 294–325 (mergeSorted)
What it is: load() fetches ALL market_ticks AND all option_ticks for the configured time window in two parallel queries, then merges the results into a single in-memory array. The comment in the source says "a single trading day is typically 500–5000 ticks" and treats this as safe. However, the HistoricalFeedConfig interface places no upper bound on the window size (from/to). A caller could specify a multi-week or multi-month replay window. For a month of 1-minute resolution data with multiple option legs, the row count could reach hundreds of thousands. The option_ticks query (line 261) fetches ALL option symbols for the window without filtering to the specific CE/PE legs needed — it relies on the downstream StraddleCalculator's price map to route. This is correct for correctness but widens the result set significantly.
Impact at scale: A 30-day replay window at 1-minute resolution with typical NIFTY straddle option data could produce 30 days × 375 minutes/day × 2 legs = ~22,500 option ticks, plus index ticks. This is manageable. However, if a user runs a multi-month replay (6 months = ~135 days), the in-memory buffer could hold 100,000+ objects. On a server with limited RAM (Railway/Fly.io free tier is typically 256MB–512MB), this risks an OOM kill. There is no warning or cap.
How to fix it: Add a guard at the top of load() that estimates the window size (to - from in days) and either rejects windows larger than a configured maximum (e.g. 30 days) or logs a prominent warning. For longer windows, implement a paged emit strategy: load one day at a time, emit it, then discard it before loading the next — this keeps memory bounded to a single day regardless of total window size. The fetchPageSize config option already exists in the interface (line 63) but is not wired to any actual paging logic in the current implementation; the implementation always loads everything.

---

FINDING: Replay driver microtask yield loop is fragile for correctness under load
Severity: Medium
File and line: src/ingestion/historical/replay-driver.ts, lines 180–183
What it is: After publishing ticks to Redis via xadd, the driver runs a fixed loop of 10 Promise.resolve() yields to give the StraddleCalculator poll loop a chance to read from Redis before snapshotStep() fires. The comment acknowledges this is based on observed behavior in a test ("10 yields to match the pattern in straddle-calc.test.ts"). The number 10 is not derived from any timing guarantee — it is an empirical constant that happens to work in tests. In production or under load, the StraddleCalculator's XREAD poll loop may not complete within 10 microtask yields: if Redis is under load, if there is a GC pause, or if Bun's event loop is processing other work, the XREAD could take longer than 10 microtask turns. If that happens, snapshotStep() fires before the price map is populated, and the snapshot silently uses stale prices from the previous interval.
Impact at scale: This is a correctness risk, not a throughput issue. In a backtesting research tool, a silently wrong snapshot at one step causes the ROC/acceleration buffer and all subsequent steps to be computed from a wrong baseline. The determinism guarantee stated in the driver's contract ("all awaits are concrete and observable") is undermined if the microtask count is insufficient. Under higher load (e.g. a long replay with many ticks per interval), the risk of the poll loop being slower than 10 microtask yields increases.
How to fix it: Replace the microtask yield loop with the same drain barrier pattern already used for the position monitor. Add a concrete awaitable to the StraddleCalculator — for example, a ticksConsumed(xaddIds) method that resolves when the poll loop has read all messages with IDs up to and including the last published xadd ID. This makes the wait observable and eliminates the magic number entirely. Alternatively, consider restructuring so that the replay driver calls snapshotStep() directly with the tick data rather than going through Redis — this removes the Redis round-trip overhead and the timing uncertainty entirely, at the cost of coupling the driver more tightly to the calculator. For a research tool that runs offline, the tighter coupling is an acceptable tradeoff.

---

FINDING: getOpenTrades called on every straddle snapshot in position monitor
Severity: Medium
File and line: src/trading/position-monitor.ts, lines 249–256 (evaluateSnapshot) calling getOpenTrades at src/trading/paper-trade.ts line 298
What it is: evaluateSnapshot() is called for every entry in the straddle.values stream — at the live cadence, that is once every 15 seconds. Each call issues a full SELECT on paper_trades WHERE status = 'open'. The comment in the code acknowledges this ("We call getOpenTrades on every snapshot tick rather than caching the list because trades may be opened by other parts of the system between ticks. At 15-second snapshot intervals this DB read is negligible."). This is reasonable for live trading with a handful of open trades. During replay, however, snapshotStep() and processedThrough() together mean the loop runs at maximum speed — for a 6-hour day at 15-second steps, that is 1,440 SELECT calls. Across a 6-month backtest, this is roughly 187,000 SELECT queries on paper_trades just for position monitoring.
Impact at scale: With the existing index on (status) and (status, entry_time DESC), the query is index-efficient and fast. The concern is cumulative: in a multi-month replay, 187,000 small round-trips add up. This is not a blocking issue (each call is fast), but it does mean the replay throughput is bounded by database round-trip latency rather than CPU. Estimated additional cost: at 1ms per call, 187,000 calls = 3 minutes of pure wait time for a 6-month replay.
How to fix it: For replay mode specifically, cache the open trades list and only refresh it after an exitTrade() call is made. The replay driver controls the cadence, so it knows exactly when a trade is closed. A simple Set<string> of open trade IDs maintained in the monitor, refreshed only on actual state changes, would eliminate the per-step DB call entirely. This optimization is replay-specific and does not affect live mode correctness.

---

FINDING: straddle_snapshots lacks symbol+time index needed by regime classifier queries
Severity: Medium
File and line: src/db/migrations/001_core_schema.sql and 008_regime_tagging.sql; queried at src/trading/regime-tagging.ts line 763
What it is: The loadSnapshotsForDay() function queries straddle_snapshots with WHERE symbol = $1 AND time >= $2 AND time < $3. TimescaleDB's chunk exclusion handles the time range bounds, but within each chunk, finding rows for a specific symbol requires scanning all rows in that chunk. The only index on straddle_snapshots is the primary key (id, time). There is no index on (symbol, time). For the regime classifier, which loads one full trading day of snapshots per day being classified, this means each call scans the rows in one or two hypertable chunks without symbol-level pruning. During a 6-month batch classification, this is repeated for each of ~130 trading days.
Impact at scale: straddle_snapshots at 15-second cadence with live data accumulates roughly 1,500 rows/day. Over 6 months, that is ~195,000 rows across many chunks. Within a single chunk (typically 7 days of data = ~10,500 rows), a scan for one symbol is fast but not index-accelerated. The missing index does not cause correctness problems and is unlikely to be catastrophic for a research tool, but it means each loadSnapshotsForDay() call does more work than necessary. loadIndexSamplesForDay() on market_ticks benefits from the existing idx_market_ticks_symbol_time index (symbol, time DESC) and is efficient.
How to fix it: Add an index on straddle_snapshots (symbol, time DESC) in a new migration. This mirrors the idx_market_ticks_symbol_time pattern. The index covers both the symbol filter and the time range filter, allowing TimescaleDB to prune by both dimensions simultaneously.

---

FINDING: Calendar reconciliation in backfill runs O(n) over full-range candle list
Severity: Low
File and line: src/ingestion/historical/backfill.ts, lines 173–179 (extractTradingDates), lines 196–209 (generateExpectedTradingDays), lines 222–265 (reconcileCalendarGaps)
What it is: reconcileCalendarGaps() builds a Set of observed dates from all candles, then a Set of expected weekday dates for the range, then finds the difference. For a 6-month backfill at 1-minute resolution, the candle list contains roughly 130 days × 375 minutes × 2 symbols = ~97,500 candles. Building the observed dates Set iterates through all of them once. This is O(n) and completes in a few milliseconds — perfectly acceptable.
Impact at scale: This is not a practical problem. The function runs once per backfill job, not per candle or per step. Noted for completeness only.
How to fix it: No action required at current scale.

---

FINDING: Batch insert uses ON CONFLICT DO NOTHING without an explicit conflict target
Severity: Low
File and line: src/ingestion/historical/backfill.ts, lines 465–475 (writeMarketTicks) and lines 507–516 (writeOptionTicks)
What it is: The INSERT statements use ON CONFLICT DO NOTHING without specifying ON CONFLICT (symbol, time) WHERE source = 'fyers-historical'. Without an explicit conflict target, PostgreSQL must check all unique constraints on the table to detect conflicts. For market_ticks, this includes the composite primary key (id, time) and the partial unique index idx_market_ticks_hist_uniq. While this works correctly (DO NOTHING fires on any conflict), the absence of a specific conflict target means PostgreSQL cannot short-circuit the check and must evaluate all constraints. The comments in the code acknowledge this: "ON CONFLICT DO NOTHING without an explicit conflict target uses all unique constraints".
Impact at scale: The overhead is small for 500-row batches. Over a 6-month backfill with many batches, the cumulative extra constraint evaluation adds a small but non-zero cost. More importantly, if future migrations add other unique constraints to these tables, the behavior of ON CONFLICT DO NOTHING could change in unexpected ways.
How to fix it: Specify the conflict target explicitly: ON CONFLICT (symbol, time) WHERE source = 'fyers-historical' DO NOTHING. This matches the partial unique index exactly and makes the intent clear. This also future-proofs the insert against new unique constraints on the table.

---

FINDING: classifyDateRange processes days sequentially with 3 DB queries each
Severity: Low
File and line: src/trading/regime-tagging.ts, lines 952–965 (the for loop), and classifyAndPersistDay lines 892–909
What it is: For a 6-month classification run (130 days), classifyDateRange() iterates sequentially, making 3 database queries per day (snapshots, index samples, backfill gap check) plus one write. That is ~390 sequential round-trips. The comment in the code explicitly notes sequential processing to "avoid overwhelming the database". This is conservative and correct for a research tool. The event calendar is loaded once, which is good.
Impact at scale: At 130 days with 3 reads + 1 write = ~520 database operations, all sequential. At 2ms per query, this is about 1 second of pure wait time per run — entirely acceptable for an overnight batch job. The conservative sequential approach prevents connection pool exhaustion and is appropriate.
How to fix it: No immediate action needed. If classification needs to run faster (e.g. for 2+ years of data), the three reads per day (loadSnapshotsForDay, loadIndexSamplesForDay, isBackfillGappedForDay) are independent and could be parallelized with Promise.all() — already done for each individual day in classifyAndPersistDay (line 892). The outer loop could be parallelized with a concurrency limit (e.g. 5 days at a time) if needed. Defer until needed.

---

FINDING: event_calendar loaded fresh on every classifyDateRange call but not cached
Severity: Low
File and line: src/trading/regime-tagging.ts, line 941 (loadEventCalendar call inside classifyDateRange)
What it is: loadEventCalendar() runs a SELECT DISTINCT on event_calendar at the start of every classifyDateRange() call. The event_calendar table contains only ~60 rows (the seed data) and is essentially read-only. Loading it once per batch run is correct and cheap. This is noted only because a caller who invokes classifyDateRange() in a loop (e.g. per-underlying) would re-load the same 60 rows on each call.
Impact at scale: Trivial — 60 rows with one DB round-trip. No action needed unless the caller is invoking classifyDateRange() in a tight loop for many underlyings simultaneously.
How to fix it: Refactor the signature to accept a pre-loaded eventCalendarDates Set as an optional parameter. The caller can load it once and pass it in. This is a minor API improvement, not a performance fix.

---

SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Critical: 0
High    : 1
Medium  : 4
Low     : 4

VERDICT: CONDITIONAL PASS

The implementation is sound for its primary use case (overnight batch processing on a personal research tool). No finding blocks correctness or causes catastrophic performance failure. The one High finding (N+1 queries in the straddle reconstructor) will make a multi-month, 15-second-cadence reconstruction impractically slow — potentially hours — and should be addressed before running the reconstructor at that resolution over large date ranges. The four Medium findings are meaningful quality improvements. The four Low findings are informational.

CONDITIONS:
1. Address the N+1 leg query pattern in reconstruct-straddle.ts before running
   full historical reconstruction at 15-second cadence over ranges longer than
   a few weeks. At coarser resolutions (1-minute or 5-minute candles with a
   matching cadenceMs), the cost is acceptable.
2. Add a size guard or paging path to HistoricalFeed.load() before using it
   with multi-month replay windows, to prevent OOM on constrained deployments.
