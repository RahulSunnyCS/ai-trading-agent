# M3 Plan — Fyers Historical Data, Replay & Backtesting (post Red Team ×3)

## Milestone split (key decision)
- **M3a (build now):** T-54, T-55, T-56, T-57 — the data + deterministic-replay foundation. Does NOT depend on M2/M4.
- **M3b (gated behind M2 landing ≥1 momentum personality):** T-51, T-58 — backtest runner + statistical validation. Deferred so statistics are never built/validated against N=1 (only the Clockwork personality is active today).

## T-54 — Fyers historical REST client (`src/ingestion/brokers/fyers-historical.ts`)
- Wrap Fyers v3 history REST API (OHLCV candles per symbol per resolution). Reuse `loadStoredToken(pool)` for auth; reuse `fyers-api-v3` where helpful but type the REST responses with a dedicated interface.
- Date-range chunking (Fyers caps days/request per resolution), pagination, exponential backoff on HTTP 429.
- Token expiry mid-backfill: PRIMARY path = on 401, checkpoint in `backfill_ranges` + fail-loud resumable marker; operator re-auths via existing dashboard "Login with Fyers", then resumes. Refresh-token use is best-effort ONLY if a non-null refresh_token is present (do not assume one exists — verify the real Fyers flow in this task).
- Read-only outbound HTTP to the fixed Fyers host only (no user-supplied URLs → no SSRF surface). Gated behind Fyers credential presence; no creds → clear loud error, never silent.
- Fail loud (never zero-fill) on missing strikes / missing legs. Record adjusted-vs-unadjusted assumption explicitly.

## T-55 — Historical backfill store + writer (`src/ingestion/historical/backfill.ts` + migration 007)
- Idempotent writer into `market_ticks` / `option_ticks`. Fyers history returns CANDLES not ticks → synthesize one row per candle (candle close → ltp, candle time → time). Add a `resolution` column; tag every backfilled row with its source resolution.
- Dedupe WITHOUT touching live PK: PARTIAL UNIQUE index `(symbol, time) WHERE source='fyers-historical'`. Backfill writes `source='fyers-historical'`; live ingestion writes `'fyers'`/`'simulator'` → disjoint key space, no collision with live writers, built non-concurrently on an effectively-empty key space. INVALID-index detection + cleanup on failure.
- New table `backfill_ranges(symbol, from_ts, to_ts, resolution, status, rows_written, updated_at)` → resumable; gaps marked explicitly, never silently "complete".
- Trading-calendar reconciliation: reconcile fetched candle timestamps against the NSE calendar (holidays, expiry-morning half-days) using instrument-registry expiry logic; mark gaps in `backfill_ranges`.
- Time-filtered writes only (hypertable discipline).

## T-56 — Historical straddle reconstruction (`src/ingestion/historical/reconstruct-straddle.ts`)
- For a past date range, at each cadence step: determine ATM strike from index candle, fetch CE+PE option candles at that strike/expiry from `option_ticks`, compute straddle_value/roc/acceleration reusing the SAME extracted pure compute function as the live StraddleCalculator (one decision implementation), write `straddle_snapshots` tagged with source resolution.
- **Look-ahead audit:** ATM strike at each step uses ONLY index data at-or-before that step's timestamp (no future bar). A test asserts this. Fail loud if a required CE/PE leg candle is absent rather than interpolating/zero-filling.

## T-57 — Deterministic replay harness (`src/ingestion/historical/historical-feed.ts` + `bun run replay`)
- `HistoricalFeed implements BrokerFeed`: reads `market_ticks`/`option_ticks` for a window in time order, emits via onTick. Replays through the EXACT live/SIMULATE pipeline (market.ticks → StraddleCalculator → straddle.values → PositionMonitor → paper_trades) — single code path, the same code that trades.
- Determinism mechanics (acceptance-criteria, folded from Red Team):
  1. VirtualClock.tick() drives snapshot cadence (not setInterval).
  2. StraddleCalculator exposes an awaitable `snapshotStep()` that resolves only after the snapshot is written to `straddle.values`; the replay driver awaits it. **Zero floating promises (no bare `void`/un-awaited async) in the replay code path** — explicit criterion.
  3. **Named drain-barrier primitive:** PositionMonitor exposes an awaitable `processedThrough(streamId)` (or replay uses a consumer group + assert `XPENDING==0`) — the driver awaits this before `clock.advance()`. The barrier primitive is named in the contract, not left as "drain".
  4. **Forbid `'$'` Redis cursors in the replay path** — pin replay consumers to a fixed start ID (`'0'`) and assert HistoricalFeed publish/consume ordering.
  5. **Live-path regression criterion:** existing `straddle-calc.test.ts` + `position-monitor.test.ts` pass unchanged, plus a SIMULATE smoke cadence assertion — the shared-extract refactor must not degrade live trading.
- **Golden oracle:** a small checked-in frozen historical fixture → checked-in expected trade ledger; a test asserts replay reproduces it. Comparison is a canonicalized STRUCTURAL compare (decimals normalized to fixed precision via decimal.js, stable key ordering, typed field equality) — not byte-for-byte. Fixture includes ≥1 gap-marked range and ≥1 resolution tag so it is a valid M3b input by construction.
- 100×-identical-ledger gate runs in M3a's harness; worker-context equivalence is asserted as an M3b ENTRY criterion (not a blocker on M3a).

## T-51 — Backtest runner (M3b) (`src/backtest/runner.ts` + migration 008)
- Runs all ACTIVE personalities over a historical window via the replay harness. Iterates whatever is active so it scales to 10 when M2 lands.
- Train/test split + a reserved HOLDOUT period that optimization must NEVER touch (holdout dates hard-rejected by every tuning/reporting consumer).
- Runs as a QUEUED BullMQ job (NOT inline in the HTTP request). Single concurrency. Hard max date-range cap. Every hypertable read carries a bounded time filter (rejected otherwise). HTTP endpoint only enqueues + returns a job id; status polled separately. This neutralizes the unauthenticated-endpoint resource-exhaustion / hypertable-DoS vector.
- Writes `backtest_runs` + `backtest_results`.

## T-58 — Backtest reporting + statistical validation (M3b) (`src/backtest/report.ts`)
- M3b launch ships ONLY: per-personality Sharpe/drawdown/win-rate behind a MINIMUM-SAMPLE gate, and a two-group test (Clockwork vs the one momentum personality), clearly labeled "aggregate, not regime-controlled".
- Deferred to land WITH T-33 (regime tagging, M4): Benjamini-Hochberg multiple-comparisons correction, deflated Sharpe ratio, per-regime buckets — built only when multiple comparisons actually exist.
- Holdout-respecting. Emits an experiment-card report (JSON + human-readable).

## Gate-1 decisions for the human
1. M3a/M3b split — approve building T-54–T-57 now and gating T-51/T-58 behind M2? (Red Team strongly converged on yes.)
2. T-58 per-regime stats — confirm deferral to T-33, ship aggregate-labeled stats first? (Or pull T-33 forward.)
3. Dev/CI with no Fyers creds — approve a synthetic historical-candle generator for tests + the golden fixture, with real fetch gated behind creds?
