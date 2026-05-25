PERFORMANCE REVIEW REPORT — Milestone 5
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Reviewer: Performance Reviewer (Phase 4)
Branch diff: c1b5b48c56ddc564b09b70b6a1543313461e15f8..HEAD
Date: 2026-05-25

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FINDINGS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

---

FINDING: Backtest runner repeated N times per EOD job for identical workload
Severity: Critical
File and line: src/retrospection/optimizer.ts line 884–887; src/jobs/eod-retrospection-job.ts line 268; src/backtesting/backtest-runner.ts line 502–503
What it is: The EOD retrospection job calls runOptimizer() for each personality sequentially. Inside runOptimizer(), if the personality reaches the backtest phase (past the min-sample gate), it creates a fresh backtest runner and runs an independent 365-day backtest. All momentum_exhaustion personalities use an identical BacktestConfig: the same BACKTEST_UNDERLYING ('NSE:NIFTY50-INDEX'), the same date window (today minus 365 days), the same holdoutDays, and the same trainFraction. With three active momentum_exhaustion personalities (Precision, Adjuster, Reducer), this means three complete, independent backtest runs that each produce the same SimulatedTrade[] array.

The backtest runner itself contains a classic N+1 [one query per item instead of one query for all items] query: loadDaySnapshots() is called once per calendar day inside a sequential for loop (backtest-runner.ts line 502–503). Over 365 calendar days that is 365 sequential database round-trips to straddle_snapshots per backtest run. The three personalities therefore cause 365 × 3 = 1,095 sequential hypertable queries just for the backtest phase, plus 3 × 2 = 6 additional queries for personalities and regime tags.

Impact at scale: The EOD job runs once per day at 16:00 IST. At current scale this takes on the order of minutes. If the system is extended to more momentum_exhaustion personalities, or if the lookback window (BACKTEST_LOOKBACK_DAYS) is increased, cost scales as O(personalities × days). At 6 momentum_exhaustion personalities and a 2-year lookback, the backtest phase alone would issue roughly 4,380 sequential hypertable queries — which, on a TimescaleDB instance carrying years of 15-second snapshots, would take tens of minutes and hold a BullMQ worker slot for the duration.

How to fix it:
  1. Run the backtest exactly once per EOD job (not once per personality). The eod-retrospection-job.ts should call the backtest runner once, pass the resulting SimulatedTrade[] into a shared context, and then call runOptimizer() with the pre-computed trades array instead of letting each optimizer call re-run the backtest. Add a parameter like backtestTrades?: SimulatedTrade[] to runOptimizer(); when supplied, skip the backtest phase.
  2. Replace the per-day sequential query loop in loadDaySnapshots() with a single range query that fetches all snapshots for the full window at once, keyed by date in memory. Example: SELECT time, call_ltp, straddle_value, roc, roc_acceleration, vix, strike FROM straddle_snapshots WHERE symbol=$1 AND time >= $2 AND time < $3 ORDER BY time ASC — then group into a Map<dateISO, InMemorySnapshot[]> client-side. This reduces 365 DB round-trips to 1 per backtest run.

---

FINDING: fetchDailyState closed-trade query bypasses index via timezone function wrapper
Severity: High
File and line: src/signals/personality-filter.ts lines 181–190
What it is: The closed-trade query that computes daily P&L uses DATE(entry_time AT TIME ZONE 'Asia/Kolkata') = $2::date as its date filter. Wrapping the entry_time column in a function call — AT TIME ZONE followed by DATE() — prevents PostgreSQL from using any index on entry_time. PostgreSQL can only use an index on entry_time if the column itself appears on the left-hand side of the comparison without a function wrapper. The existing idx_paper_trades_status_entry_time index (migration 002, on (status, entry_time DESC)) is therefore skipped, forcing a sequential scan of all rows with status='closed' for the given personality. As the paper_trades table grows over many trading days, this scan grows linearly with total trade history.

The open-legs query in the same function (lines 203–210) filters on personality_id and status using the covered idx_paper_trades_personality (migration 001, on (personality_id, status)) and is fine.

Impact at scale: Each signal arriving on signals.generated triggers one fetchDailyState call per active personality (10 personalities = 10 parallel calls, each running this query). On a day with years of trading history in paper_trades, the status='closed' scan over all prior days for the personality grows unboundedly. At 10 signals per day × 10 personalities, the total sequential scans per day scale as O(total_closed_trades_for_personality).

How to fix it: Replace the timezone-function filter with a precomputed IST-midnight UTC range, matching the approach already used in portfolio-risk.ts (lines 188–196). Compute the IST midnight and IST end-of-day as UTC ISO strings in TypeScript, then query with entry_time >= $2 AND entry_time < $3. This allows the existing (status, entry_time DESC) index to be used. The todayIST parameter that fetchDailyState already receives can be converted to UTC bounds before the query.

---

FINDING: Duplicate identical COUNT queries in portfolioRiskCheck on every trade open
Severity: Medium
File and line: src/trading/portfolio-risk.ts lines 263–264 (Rule 4) and lines 315–316 (Rule 5)
What it is: Both Rule 4 (margin buffer check) and Rule 5 (advisory lock + max legs check) execute SELECT COUNT(*) AS cnt FROM paper_trades WHERE status = 'open' independently. These two queries always run in sequence within the same portfolioRiskCheck() call and will always return the same count (no trade opens or closes happen between them in the same request). The count is computed twice from the database when it only needs to be computed once.

This runs for every passing personality that attempts a trade open — with up to 4 personalities passing simultaneously, portfolioRiskCheck() can be called up to 4 times per signal, meaning up to 8 COUNT queries where 4 would suffice.

Impact at scale: With 3 underlyings active (INDICES=NIFTY,BANKNIFTY,SENSEX) and all personalities active, the number of passing personalities per signal increases. The duplicate count queries increase proportionally. While a COUNT(*) on an indexed column (idx_paper_trades_status exists from migration 002) is fast, the waste compounds across every trade open event during a busy session.

How to fix it: Compute the open count once at the start of portfolioRiskCheck() and pass it to both rules. Alternatively, remove the Rule 4 COUNT query and reuse the result from Rule 5 (moving Rule 5's count before Rule 4's margin calculation). The advisory lock in Rule 5 must still be acquired, but the COUNT query inside the lock can be kept for correctness while Rule 4 uses the pre-fetched count for its margin estimate.

---

FINDING: parseBlockedDates called on every personality filter evaluation
Severity: Medium
File and line: src/signals/personality-filter.ts lines 334 and 576–588
What it is: runPersonalityFilter() calls parseBlockedDates() at Stage 1 every time it runs. parseBlockedDates() reads process.env.BLOCKED_DATES and calls JSON.parse() on it each time. The personality router calls runPersonalityFilter() for every active personality (up to 10) for every signal. BLOCKED_DATES does not change between calls — it is a static list set at process startup.

The JSON.parse() call is cheap individually, but it is unnecessary repeated work. The BLOCKED_DATES list is also stored as an array (the result of JSON.parse()), which means the blocked-date check uses Array.includes() — an O(N) linear scan — rather than O(1) set membership.

Impact at scale: At current signal volumes (a few momentum exhaustion signals per day plus periodic SR signals), this is low-cost in absolute terms. However, the pattern is architecturally fragile: if BLOCKED_DATES grows (many holidays or policy days) or signal volume increases (e.g. multiple underlyings emitting SR signals frequently), repeated JSON.parse() plus O(N) array scan per personality per signal degrades.

How to fix it: Parse BLOCKED_DATES once at module level (or inject it as a parameter). Convert the result to a Set<string> for O(1) lookups. The entry-engine.ts already does this correctly (lines 135–145): it parses BLOCKED_DATES in the constructor and stores a ReadonlySet. Apply the same pattern in personality-filter.ts. Since runPersonalityFilter() is a pure function that receives all its context, the simplest fix is to add a pre-parsed blockedDates: ReadonlySet<string> parameter, computed once by the router before the fan-out.

---

FINDING: assertCalendarFreshness makes two separate queries that could be one
Severity: Low
File and line: src/ingestion/brokers/instrument-registry.ts lines 468–495
What it is: assertCalendarFreshness() runs two sequential queries against index_expiry_calendar: one to find the nearest future expiry (Check 1) and one to find the maximum seeded expiry date (Check 2). Both queries filter on the same underlying and both touch the same small table (a few dozen rows for 3 underlyings). These two queries could be combined into a single query that returns both the minimum future expiry and the overall maximum expiry in one round-trip:

  SELECT MIN(CASE WHEN expiry_date >= $2::date THEN expiry_date END) AS next_expiry,
         MAX(expiry_date) AS max_expiry
  FROM index_expiry_calendar
  WHERE underlying = $1

This runs only at startup (not on the hot path), so the practical impact is negligible. It is noted for correctness and code clarity.

Impact at scale: index_expiry_calendar is a tiny lookup table (27 rows at migration time, growing slowly). Two queries vs one makes no measurable difference. This is a low-priority hygiene finding.

How to fix it: Combine the two queries into a single SELECT with conditional aggregation as shown above. Check the returned next_expiry for NULL (calendar empty → throw CalendarExpiredError). Use the returned max_expiry for the refill-days comparison.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ITEMS VERIFIED CLEAN
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

sr-levels.ts hypertable queries: All three queries against market_ticks (fetchOHLCV, fetchTicksForPOC, countHistoryBars) include mandatory AND time >= $2 AND time < $3 predicates. The LIMIT 50000 cap on fetchTicksForPOC is appropriate as a safety net. No full-table scan risk. The hypertable annotation warning in the file header and inline comments correctly document this invariant.

SRDetectionEngine level caching: Levels are loaded at most once per underlying per session (lazy-loaded on first snapshot, then held in _state). There is no per-tick DB call or per-tick level recomputation. The _loadLevels() path is protected by the state.levels === null check. This is the correct design.

SRDetectionEngine per-tick work: Each snapshot triggers _handleSnapshot() which is pure in-memory after levels are loaded: it checks strength and proximity thresholds, consults the in-memory lastSignalPerLevel Map, and only calls _emitSignal() when dedup is cleared. The signal emission path (one DB INSERT + one Redis XADD) is guarded by the dedup window (default 300 seconds per level). No per-tick DB calls.

Migration 012 (012_sr_signals.sql): The decision to defer the sr_subtype index is documented and justified — no current query pattern in the M5 code filters straddle_signals by sr_subtype alone. When retrospection queries for Levelhead performance are added (future phase), a composite index on (underlying, sr_subtype, time) should be added at that point. The acknowledged deferral is acceptable.

Migration 013 (013_index_expiry_calendar.sql): The composite PRIMARY KEY (underlying, expiry_date) is the correct index for all query patterns in this migration's consumers: WHERE underlying=$1 AND expiry_date >= $2 (getCurrentExpiryFromCalendar, assertCalendarFreshness Check 1) and WHERE underlying=$1 (Check 2 MAX). Both are served efficiently by the PK.

PersonalityRouter personality config cache: The 60-second in-memory TTL cache for personality_configs prevents per-signal DB queries on the 10-row table. Cache miss cost (one query) is trivially cheap. This is well-designed.

PersonalityRouter fetchDailyState fan-out: The 10 parallel fetchDailyState calls are dispatched via Promise.all — not sequential. With 10 personalities this sends 20 queries concurrently to the DB pool rather than serially. The pg pool will serve them in parallel up to the pool size. This is the correct approach.

portfolio-risk.ts Rule 3 (per-index daily stop): The query correctly uses entry_time >= $1 AND entry_time < $2 with IST-midnight UTC bounds computed in TypeScript, which allows the (status, entry_time DESC) index to be used. The personality_id and underlying filters further reduce the scan to only relevant rows.

optimizer.ts fetchTrainingRows holdout subquery: The retrospection_results table is not a TimescaleDB hypertable (it stores daily summaries, not tick data), so the subquery-based holdout exclusion does not have the hypertable full-scan risk. The query filters on personality_id which is covered by the idx_retrospection_results_personality_regime_date index (migration 011).

evolution-engine.ts SELECT FOR UPDATE: The transaction correctly locks only the momentum_exhaustion comparison group (not all personalities). The lock scope is documented and justified.

Multi-index fan-out (index.ts): One StraddleCalculator per active underlying feeds independent snapshots into the shared straddle.values stream. Both the PeakDetectionEngine and SRDetectionEngine use per-underlying state maps, so the fan-out multiplies snapshot volume but not computation per snapshot. No expensive operation is repeated per underlying — each snapshot is handled independently with O(levels) work, where levels is a small fixed set loaded once per session.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Critical: 1  (Backtest runner repeated N times for identical workload — up to 1,095 sequential hypertable queries per EOD)
High    : 1  (fetchDailyState timezone function prevents index use on paper_trades — grows linearly with trade history)
Medium  : 2  (duplicate COUNT queries in portfolioRiskCheck; parseBlockedDates re-parsed per personality per signal)
Low     : 1  (assertCalendarFreshness two queries can be one — startup only, negligible impact)
