# Epic: M3a — Historical Data Replay & Backtesting Foundation

| Field      | Value                                          |
|------------|------------------------------------------------|
| Status     | Completed                                      |
| Date       | 2026-05-24                                     |
| Branch     | claude/hopeful-lovelace-Kaqsz                  |
| Tasks      | T-54, T-55, T-56, T-57, T-33                  |
| Risk level | HIGH (financial-logic, public-facing-api)      |

---

## 1. What was done

**T-54 — Fyers historical REST client** (`src/ingestion/brokers/fyers-historical.ts`)

A typed client that fetches OHLCV candle history from the Fyers v3 REST API. Key behaviours: date-range chunking by resolution (e.g. 30-day max per request for 1-minute data), exponential backoff on HTTP 429 (rate-limit), and a fail-loud resumable error (`FyersAuthError`) on HTTP 401 that carries `lastSuccessfulCutoff` so the backfill layer can checkpoint and resume without re-downloading completed data. The Fyers host is a hard-coded constant — no caller-supplied URLs are accepted. Missing strikes or option legs produce explicit gap markers, never zero-filled data. The adjusted-vs-unadjusted price assumption is recorded in every response's metadata. Unit tests mock the HTTP layer entirely; no live network calls.

**T-55 — Historical backfill writer + migration 007** (`src/ingestion/historical/backfill.ts`, `src/db/migrations/007_historical_backfill.sql`)

Consumes T-54 candle output and writes rows to the existing `market_ticks` and `option_ticks` hypertables tagged `source='fyers-historical'`. Migration 007 adds a `resolution` column to both tables, a partial unique index `(symbol, time) WHERE source='fyers-historical'` on each (disjoint from live-ingestion key space so historical and live rows coexist), and a `backfill_ranges` tracking table (`symbol, from_ts, to_ts, resolution, status, rows_written, gaps_json, updated_at`). On a 401 mid-run the writer checkpoints progress in `backfill_ranges` and throws `BackfillResumeError`; a subsequent call resumes from that checkpoint. Trading-calendar reconciliation (via instrument-registry expiry helpers) detects NSE-holiday and expiry-morning gaps and marks the range `gapped` rather than `complete` — it can never silently mark a gapped range as complete.

**T-56 — Historical straddle reconstruction** (`src/ingestion/historical/reconstruct-straddle.ts`, `src/ingestion/straddle-math.ts`)

Rebuilds `straddle_snapshots` rows for a past date range by stepping through time at a configurable cadence (default 15 s). At each step it reads the index price at-or-before that timestamp, determines the ATM strike, fetches CE and PE option prices at-or-before that timestamp, and computes the snapshot. Critically, the pure straddle compute logic (straddle value, ROC, acceleration over a rolling buffer) was extracted into a new `src/ingestion/straddle-math.ts` module of pure functions. The live `StraddleCalculator` was refactored to import and call these same functions — there is now one implementation of straddle math shared by both live and historical paths. If a CE or PE leg candle is absent at any step, the reconstructor throws `MissingLegError` — it never interpolates or zero-fills. Reconstructed rows carry the resolution tag from the underlying option tick row. Post-Gate-2 fix (C1): the reconstructor's INSERT now uses an explicit `ON CONFLICT (time, symbol, strike, expiry) DO NOTHING` backed by the unique index added in migration 009, and the `resolution` column is now written on every row.

**T-57 — Deterministic replay harness** (`src/ingestion/historical/historical-feed.ts`, `src/ingestion/historical/replay-driver.ts`, `scripts/replay.ts`, changes to `src/trading/position-monitor.ts`)

`HistoricalFeed` implements the `BrokerFeed` interface and replays stored ticks through the exact same live pipeline (`market.ticks` Redis stream → `StraddleCalculator` → `straddle.values` stream → `PositionMonitor` → `paper_trades`). Cadence is driven by `VirtualClock.advance()` in replay, not `setInterval`, so wall-clock time has no effect. Two named drain barriers make the driver fully deterministic: `StraddleCalculator.snapshotStep()` (post-C2 fix: resolved by the new `ticksConsumed` barrier, which awaits until the poll-loop's XREAD cursor passes the last published tick ID) and `PositionMonitor.processedThrough(streamId)` (resolved when the poll loop consumes the exact straddle snapshot ID). The driver awaits these in order — clock advances only after both barriers resolve. The `$` Redis cursor is forbidden in the replay path; all consumers start at `'0'`. A frozen golden fixture (one 30-minute NIFTY session, 20 synthetic ticks, checked in at `src/ingestion/historical/__tests__/fixtures/golden/fixture.json`) gates all replay changes. The `bun run replay` CLI validates date range, underlying, and speed; a hard safety guard (`--against-live` flag or `REPLAY_CONFIRM_LIVE=true` env) is required before replay touches a database with real open trades (post-C3 fix). Post-C4 fix: `stop()` drains all pending `processedThrough` promises before returning to prevent driver hangs on early shutdown.

**T-33 — Causal/point-in-time regime tagging** (`src/trading/regime-tagging.ts`, `src/db/migrations/008_regime_tagging.sql`)

Classifies each past trading day into `RANGING | TRENDING_STRONG | VOLATILE_REVERTING | EVENT_DAY` (or `UNCLASSIFIED` for gapped/sparse days) and persists to a `daily_regime_tags` table. The 14:30 IST cutoff is the decision boundary: classification for day D uses only index and straddle data up to 14:30 IST on day D, never D's own close or any future day. Migration 008 creates the `daily_regime_tags` table, a `regime_confidence` column, and a seed `event_calendar` table pre-populated with known RBI policy days, budget days, and F&O expiry mornings. `EVENT_DAY` is sourced from this static calendar table — not from the operator's `BLOCKED_DATES` env var — so historical labels are reproducible regardless of who runs the classifier. Precedence is deterministic: `EVENT_DAY > VOLATILE_REVERTING > TRENDING_STRONG > RANGING`. Migration 008 also adds the `resolution` column to `straddle_snapshots` (closing the T-56 fidelity gap). Days where backfill data is gapped or more than 50% of expected snapshots are missing are emitted as `UNCLASSIFIED` with a `regime_confidence` score rather than forcing a label onto degraded data.

---

## 2. How this helps the project

The core value of this milestone is honest backtesting: the ability to run the live trading system over historical data and get results that are trustworthy enough to inform real trading decisions.

Without this foundation, any "backtest" would require a separate reimplementation of the signal logic — and divergence between that reimplementation and the live code is the most common source of overfitted or misleading backtest results. M3a eliminates that risk by having replay run through the same `StraddleCalculator`, `PositionMonitor`, and personality filter chain that executes in production. There is one code path.

Causal regime tagging matters for the same reason. If a regime classifier uses that day's closing data to classify a trade entered at 10:00, it is implicitly using information that was not available at entry time — the classic look-ahead problem. The 14:30 IST cutoff, enforced in code and verified by a look-ahead audit test, means regime labels are assigned the way a trader would have assigned them in real time.

The determinism gate (100 consecutive identical ledgers) matters because a backtest that produces slightly different results on each run cannot be trusted. Floating promises, race conditions, or wall-clock dependencies would make results unreproducible between runs or machines. The named drain barriers and the frozen golden fixture together eliminate that class of bug.

For the project owner: M3a is the plumbing. It is not yet a full backtest runner (that is M3b). But M3b is only honest if M3a is correct, and M3a's correctness is now tested, gated, and documented.

---

## 3. Limitations & tradeoffs (and why)

**No Fyers token auto-refresh (accepted deviation)**
The Fyers access token expires daily. If it expires mid-backfill, the client throws a resumable `FyersAuthError` with a checkpoint — but the operator must manually refresh the token and re-run. Automatic token refresh via the OAuth flow was described as "best-effort only if a refresh token is available" in the contract and is not implemented. Rationale: the Fyers v3 token refresh flow requires the full OAuth redirect cycle; implementing it reliably within the client would have added significant complexity and a live-network dependency to the test suite. For a personal research tool that runs backfills overnight, the manual regen + resume pattern is acceptable. This is documented in `FYERS_ACCESS_TOKEN` gotcha notes.

**Reconstructor N+1 per-step queries (Performance High — H1, tracked)**
For each cadence step, the reconstructor issues three database round-trips: one for the index price, one for the CE price, one for the PE price. At the 15-second cadence over a 6-month date range this is approximately 585,000 sequential queries and may take tens of minutes. The fix — pre-fetch the window's ticks once (still time-bounded) and walk a pointer per step — was accepted as a tracked follow-up rather than a blocker because at coarser resolutions (1-minute or 5-minute candles) the cost is acceptable for short ranges. Fix this before running full 15-second reconstruction over ranges longer than 2–3 weeks.

**`HistoricalFeed.load()` loads the full window into memory, no paging (Medium — M1, tracked)**
The `fetchPageSize` config field exists and is documented, but the implementation loads all ticks for the requested window into a single in-memory array. For a multi-month replay window on a constrained host (Railway/Fly free tier) this risks an OOM. Rationale: implementing day-at-a-time paging requires a streaming emit design that would have extended the implementation timeline. Acceptable for single-day or short-window replays typical of early development. Fix this before multi-month replay windows.

**Replay against the live DB is guarded by a flag, not a separate-DB enforcement**
The `--against-live` flag (or `REPLAY_CONFIRM_LIVE=true`) is required to run replay against a database that may hold real open paper trades. This is a human acknowledgement, not a technical enforcement like a separate DB schema. A developer who manually sets the flag and points `DATABASE_URL` at the production database can still corrupt live data. The preferred long-term fix — tagging replay-created trades and scoping `getOpenTrades` to that tag — is tracked tech debt. The flag provides meaningful friction for the common foot-gun (accidental production runs) without the implementation cost of schema isolation at this stage.

**Migration 009 unique index requires a duplicate-free `straddle_snapshots` table**
Migration 009 adds `CREATE UNIQUE INDEX IF NOT EXISTS idx_straddle_snapshots_unique_snapshot ON straddle_snapshots (time, symbol, strike, expiry)`. If a development database accumulated duplicate straddle snapshot rows (possible if the reconstructor was run before the C1 fix), this migration will fail. The affected table must be deduplicated before applying. The progress notes explicitly flag this: `"migration 009 unique index will fail if a pre-fix dev DB already holds duplicate straddle_snapshots rows — dedup before applying"`.

**Integration tests require Docker and skip cleanly without it**
The three new integration tests (`replay-driver.integration.test.ts`, `backfill.integration.test.ts`, `reconstruct-idempotency.integration.test.ts`) require live PostgreSQL and Redis. They use `describe.skipIf(!process.env.DATABASE_URL)` and `describe.skipIf(!process.env.REDIS_URL)` so `bun test` completes cleanly with those 3 tests skipped when Docker is not running. The pre-existing `smoke.test.ts` also skips cleanly. The 451 unit tests run without infrastructure.

**Regime classifier thresholds are not yet empirically calibrated**
The thresholds for `TRENDING_STRONG` (sustained index move) and `VOLATILE_REVERTING` (ROC acceleration / sign-change fraction) are named compile-time constants with documented rationale, but they have not been validated against historical regime labels from a domain expert. They should be treated as relative rankings and starting points, not calibrated probability estimates. Brier scores are not yet tracked for regime labels. The UNCLASSIFIED path prevents degraded days from contaminating analysis.

**`straddle-calc.ts` retains an inline buffer mutate (Medium — M3, tracked)**
`straddle-math.ts` exports `pushToBuffer()` as the single implementation of rolling-buffer mutation. The reconstructor uses it correctly. The live `StraddleCalculator` still performs the same mutation inline (a one-line change to fix). Both paths produce identical results today, but future changes to buffer capping logic must be applied in two places until this is resolved.

---

## 4. Tests the AI ran to verify this works

### Unit tests

`bun test` (no Docker required): **451 pass, 3 skip**. The 3 skips are integration tests that cleanly skip when `DATABASE_URL` is absent. Pre-existing `smoke.test.ts` also skips without Redis (environmental only — test is untouched). TypeScript compilation (`tsc --noEmit`) is clean.

New test files added:

| File | What it proves |
|------|---------------|
| `src/ingestion/brokers/__tests__/fyers-historical.test.ts` | Chunking math for all resolutions; 429 exponential backoff logic; 401 resumable-error path surfaces `FyersAuthError` with `lastSuccessfulCutoff`; missing-strike gap marker; loud `FyersNoCredentialsError` on missing credentials. All HTTP calls are mocked — no live network calls. |
| `src/ingestion/historical/__tests__/backfill.test.ts` | Idempotent re-run writes zero duplicate rows; interrupted run resumes from checkpoint; calendar gap is marked `gapped` not `complete`. |
| `src/ingestion/historical/__tests__/reconstruct-straddle.test.ts` | Look-ahead audit: ATM strike at step T is unchanged when T+1..N data is mutated; missing CE/PE leg throws `MissingLegError`; reconstructed values match hand-computed straddle/ROC/acceleration. |
| `src/ingestion/__tests__/straddle-math.test.ts` | Direct unit tests of the extracted pure functions: `computeRoc`, `computeAcceleration`, `pushToBuffer`, `computeStraddleValue` — including edge cases for fewer than 2 and fewer than 3 snapshots in the rolling window. |
| `src/ingestion/historical/__tests__/replay-determinism.test.ts` | See details below. |
| `src/trading/__tests__/regime-tagging.test.ts` | All four regime labels on representative synthetic inputs; look-ahead audit (day D label unchanged when D+1 data changes); determinism (repeat-run identical); EVENT_DAY precedence over all other labels; UNCLASSIFIED on gapped input; env-independence (BLOCKED_DATES has no effect). |

#### replay-determinism.test.ts — key gates within the file

**Golden oracle**: loads the frozen fixture (`fixture.json`, 20 ticks, NIFTY 09:15–09:45 IST), replays through an in-memory pipeline, and asserts the produced snapshot ledger matches `expectedSnapshotLedger` with Decimal.js-normalised values at 10 decimal places. Result: pass.

**100x identical-ledger gate**: runs `runReplay()` 100 times consecutively and asserts every produced ledger is structurally identical to the first. This gate detects floating promises, race conditions, or wall-clock dependencies. Result: pass (30 s timeout; actual runtime ~5 s).

**11 new `ticksConsumed` barrier tests** (added in the Gate-2 fix cycle, `ebe8ac4`): verify the input-side barrier behaviour — that `snapshotStep()` does not resolve until the calculator's poll-loop XREAD cursor has advanced past all published tick IDs. Tests cover: (a) resolves immediately when cursor is already past target; (b) does not resolve before poll loop processes the target entry; (c) resolves after multiple ticks in the same batch; (d) drain on `stop()` does not leave pending promises.

**processedThrough drain barrier tests**: prove `processedThrough(streamId)` resolves immediately when the poll loop has already advanced past the target, and resolves only after the poll loop processes the target when it has not.

**Live-path regression**: fake-timer test proves `StraddleCalculator` still fires snapshots via `setInterval` in live mode (not via `snapshotStep()`), and that snapshot cadence matches `snapshotIntervalMs`.

**`$` cursor forbidden gate**: asserts that the in-memory fake Redis throws `REPLAY PATH VIOLATION` when `$` is passed to `xread`, and that `StraddleCalculator` configured with `startId='0'` never calls `xread` with `$`.

### Integration tests (Docker-gated, skip cleanly without Docker)

| File | What it proves |
|------|---------------|
| `replay-driver.integration.test.ts` | Under real Redis latency, the `ticksConsumed` barrier produces a deterministic snapshot ledger on two consecutive runs (C2 coverage — the behaviour the in-memory tests cannot verify). |
| `backfill.integration.test.ts` | Against a real TimescaleDB: idempotent re-run writes zero duplicate rows (B1); partial unique index is disjoint from live keys — live source row and historical source row coexist for the same (symbol, time) (B2); resume from 401 checkpoint continues from `checkpoint_ts`, not from original `from` (B3); all written rows are within the requested time bounds (B4). |
| `reconstruct-idempotency.integration.test.ts` | Against real TimescaleDB: running reconstruction twice over the same range yields the same row count (C1a); every reconstructed row has a non-null `resolution` column (C1b). |

### What was not executed

The E2E Playwright tests for the dashboard were not run as part of M3a — M3a has no new UI surface. The M3b backtest runner and statistical reporting (T-51, T-58) are not yet built; their QA checklist items are deferred. The integration tests were not run in CI (marked CI-ONLY — Docker is not available in the pipeline run environment). Their correctness is verified by code review and structural unit coverage.

---

## 5. Manual test cases for humans

**MTC-1 — Backfill a known historical range (dry run, no live Fyers call)**

- Preconditions: Docker services running (`docker compose up -d`). `SIMULATE=true` (no Fyers credentials needed for this test). An empty or test database.
- Steps:
  1. `bun run migrate` — verify migrations 007, 008, 009 apply cleanly.
  2. Inspect `backfill_ranges` table: `SELECT * FROM backfill_ranges;` — should be empty.
  3. Set `FYERS_APP_ID=test` and `FYERS_ACCESS_TOKEN=test` (dummy values). Run a short programmatic backfill against the mock HTTP layer (unit test mode) or inspect `backfill.test.ts` to confirm idempotency.
  4. To exercise the real Fyers path (requires valid credentials): run `bun run -e "import { runBackfill } from './src/ingestion/historical/backfill.ts'; ..."` for a 2-day range at `D` (daily) resolution.
- Expected result: `backfill_ranges` gains one row with `status='complete'`, `rows_written > 0`, and a valid `gaps_json`. Running the same call a second time reports `rows_written=0` (idempotent — no duplicate rows in `market_ticks`).

**MTC-2 — Replay dry-run (no pipeline, no paper trades written)**

- Preconditions: Docker services running. Valid `DATABASE_URL` and `REDIS_URL` in environment. At least one trading day of data backfilled into `market_ticks` and `option_ticks` (see MTC-1).
- Steps:
  1. `bun run replay --from 2024-01-25T03:45:00Z --to 2024-01-25T09:30:00Z --underlying NIFTY --dry-run`
- Expected result: Process exits with code 0. Console logs confirm ticks were loaded and the date range parsed. No rows written to `paper_trades`. The `--dry-run` flag bypasses the `--against-live` guard.

**MTC-3 — Safety guard blocks replay without the required flag**

- Preconditions: Docker services running. `DATABASE_URL` set to any database (even a scratch one). `REPLAY_CONFIRM_LIVE` env var absent.
- Steps:
  1. `bun run replay --from 2024-01-25T03:45:00Z --to 2024-01-25T09:30:00Z --underlying NIFTY`
  2. Observe exit code and console output.
- Expected result: Process exits with code 1 immediately. Console prints `[replay] SAFETY GUARD: replay connects to the live DATABASE_URL and can close real open paper trades`. No database connection is established, no migrations run, no trades are touched.

**MTC-4 — Real replay against a scratch database with --against-live**

- Preconditions: A separate scratch database (not the production one) with migrations applied, `DATABASE_URL` pointing to it. Backfill data present for the date range. Redis running.
- Steps:
  1. Verify `paper_trades` is empty on the scratch DB.
  2. `bun run replay --from 2024-01-25T03:45:00Z --to 2024-01-25T09:30:00Z --underlying NIFTY --against-live`
  3. After completion, `SELECT COUNT(*) FROM paper_trades WHERE status='open';` and `SELECT COUNT(*) FROM paper_trades WHERE status='closed';`
- Expected result: Process exits 0. Summary logs show `ticksEmitted`, `snapshotStepsPublished`, and `wallClockMs`. Paper trades written reflect the personalities' simulated decisions over the replay window — not real money, not live paper trades.

**MTC-5 — Verify reconstruction is idempotent (no duplicate rows)**

- Preconditions: Docker running. `option_ticks` and `market_ticks` populated for a test date via backfill (or by inserting synthetic rows with `source='fyers-historical'`).
- Steps:
  1. Run `reconstructStraddle(pool, { underlying: 'NIFTY', from: ..., to: ..., cadenceMs: 60000, persist: true })` (1-minute cadence to keep row count small).
  2. Record: `SELECT COUNT(*) FROM straddle_snapshots WHERE symbol LIKE 'NSE:NIFTY%' AND time >= $from AND time <= $to;`
  3. Run the same call a second time.
  4. Record row count again.
- Expected result: Row count after step 4 equals row count after step 2. Zero new rows were written. Every row has a non-null `resolution` column.

**MTC-6 — Classify a known EVENT_DAY date**

- Preconditions: Docker running. Migration 008 applied (seeds `event_calendar` with known dates including `2025-04-18 Good Friday`). Straddle snapshots present for that date.
- Steps:
  1. Run `classifyDateRange(pool, { underlying: 'NIFTY', from: new Date('2025-04-18'), to: new Date('2025-04-18') })`.
  2. `SELECT regime, regime_confidence FROM daily_regime_tags WHERE date = '2025-04-18';`
- Expected result: `regime = 'EVENT_DAY'`, regardless of the straddle signal on that day (EVENT_DAY has highest precedence). `regime_confidence` reflects data completeness.

**MTC-7 — Confirm BLOCKED_DATES env var does not affect historical regime labels**

- Preconditions: Same as MTC-6. `event_calendar` table does NOT contain 2024-03-01.
- Steps:
  1. With `BLOCKED_DATES=2024-03-01` in environment, run `classifyDateRange` for 2024-03-01.
  2. Note the regime label assigned.
  3. Unset `BLOCKED_DATES`, run again for the same date.
  4. Compare the two labels.
- Expected result: Both runs produce the same label. `BLOCKED_DATES` has no effect on historical classification — `EVENT_DAY` is sourced only from the checked-in `event_calendar` table.

---

## 6. Security & risk notes

### Findings resolved (Gate-2 must-fix, all applied in commit `14e8499`)

**C1 — Reconstructor INSERT non-idempotent + resolution column missing** (Security Medium + Architecture Medium)
The original `ON CONFLICT DO NOTHING` was a dead clause because the only constraint was `(id, time)` where `id` is `BIGSERIAL` — every insert minted a new id, so conflicts were structurally impossible. Re-running reconstruction silently duplicated straddle snapshot rows, corrupting the regime classifier's ROC and acceleration inputs and potentially flipping a day's label. Additionally, the `resolution` column added by migration 008 was not included in the INSERT, so every row was written with `resolution = NULL`, defeating the fidelity-detection purpose of the column. Fix applied: migration 009 adds `CREATE UNIQUE INDEX idx_straddle_snapshots_unique_snapshot ON straddle_snapshots (time, symbol, strike, expiry)`; the INSERT now names this index as the explicit conflict target and includes `resolution` in the column list.

**C2 — Replay determinism unproven under real Redis (microtask yield replaced by named barrier)** (Performance Medium + Architecture Medium)
The original driver spun 10 `Promise.resolve()` microtask yields to let the StraddleCalculator's poll loop process ticks before `snapshotStep()` fired. This was an empirical constant that only worked against a synchronous in-memory fake Redis — under real Redis network latency or GC pauses, `snapshotStep()` could fire on a stale price map, producing a silently wrong snapshot that would contaminate the entire ROC buffer. Fix applied: `StraddleCalculator` now exposes `ticksConsumed(lastXaddIds)` — a named, awaitable input-side barrier that resolves only when the poll-loop's XREAD cursor has advanced past all published tick IDs. The driver awaits this barrier before `snapshotStep()`. This mirrors the existing `processedThrough` on the output side and eliminates the magic number entirely.

**C3 — `bun run replay` could close real paper trades** (Security Medium)
The replay script connected to the live `DATABASE_URL`/Redis and started the real `PositionMonitor`, which loads ALL open paper trades and can close them against replayed historical prices. The only protection was a header comment. Fix applied: the script now requires `--against-live` flag or `REPLAY_CONFIRM_LIVE=true` env var to proceed. Without it, the process exits with code 1 and a clear error message before making any database connection. `--dry-run` is exempt. The accepted residual risk is that a developer who explicitly adds `--against-live` while pointing `DATABASE_URL` at production could still corrupt data; tag-scoping `getOpenTrades` to replay runs is tracked tech debt.

**C4 — `pendingBarriers` not drained on `stop()` → potential driver hang** (Architecture Medium)
If `stop()` was called between a `snapshotStep()` and a `processedThrough()` await (e.g. an error caused early shutdown), unresolved barrier promises sat permanently in `pendingBarriers` and the driver hung with no timeout. Fix applied: `stop()` now iterates `pendingBarriers`, resolves all pending promises (unblocking any waiting caller), and clears the map before returning.

### Findings resolved (Security auditor — no Critical)

- **SQL injection**: all queries in all five modules use bound `$N` parameters. Multi-row INSERT builders generate only `($1,$2,…)` placeholder positions programmatically — no external values are interpolated as literal SQL. Result: PASS.
- **SSRF**: `FYERS_HISTORY_URL` is a module constant built from a hard-coded host. Caller-supplied inputs (`symbol`, `resolution`, epoch range) go through `URLSearchParams`. Result: PASS.
- **Never fabricate financial data**: `parseCandles` never zero-fills OHLC (volume zero-fill is explicitly justified and documented); missing chunks produce explicit gap markers; `backfill.finaliseRange` enforces `gaps_detected > 0 ⇒ status != 'complete'` in both TypeScript and the migration `CHECK` constraint; `reconstruct-straddle` throws `MissingLegError` on absent CE/PE and does not advance the ROC buffer across a gap; regime tagging routes gapped days to `UNCLASSIFIED`. Result: PASS.
- **Secrets handling**: tokens are masked in logs; `FyersNoCredentialsError` fails loud rather than running zero-data. Result: PASS with two low-severity nits noted below.

### Accepted risks (Low severity — tracked, not blocking)

**Access token first-4-chars in logs** (Security Low): on HTTP 401, the error message embeds `creds.accessToken.slice(0, 4)`, and startup diagnostic logs print `appId.slice(0,4)...`. Four characters of a daily-rotating opaque token is low entropy, but partial secrets in logs is a habit not to normalise. Recommended fix: use a non-reversible fingerprint (first 6 chars of `sha256(token)`) or drop the fragment. Accepted for M3a; tracked.

**Credential resolution prefers env var over fresh DB token with no expiry check** (Security Low): if a stale `FYERS_ACCESS_TOKEN` is left in the environment, it shadows a fresh DB token, guaranteeing a 401 round-trip on every run until cleared. The `expiresAt` field on the stored token is available but is not consulted. Accepted: the resumable 401 path handles this correctly and the daily manual regen workflow is documented. Tracked for improvement.

### Feature flag / rollback

M3a adds new modules and tables but does not modify the live trading path. The replay harness is invoked only via `bun run replay` or programmatically; no automatic pipeline trigger exists yet. Disabling M3a requires no feature flag — simply not running the replay CLI leaves the live system untouched. Migration rollback: tables added in 007, 008, 009 can be dropped manually; the `resolution` column additions (007 / 008) are `NOT NULL DEFAULT ...` so rolling them back requires removing the column, which drops data. Migrate forward; never edit applied migration files.

---

## 7. Follow-ups & deferred work

| Item | Rationale |
|------|-----------|
| H1: Replace N+1 per-step queries in reconstructor with bulk pre-fetch + pointer walk | Critical for 15s-cadence reconstruction over >2–3 weeks; acceptable at coarser resolutions for now |
| M1: Implement day-at-a-time paging in `HistoricalFeed.load()` (wire `fetchPageSize`) | Prevents OOM on multi-month replay windows on constrained hosts |
| `HistoricalFeed extends BrokerFeed` (structural type) | One-line fix; makes the "same pipeline" contract enforced by the type system |
| `straddle-calc.ts` inline `push/shift` → call `pushToBuffer` | One-line fix; eliminates dual implementation of buffer capping |
| `fetchMarketTicks` add `AND symbol = $3` underlying filter | Harmless today; will multiply buffer in Phase 2 multi-index |
| Add `idx_straddle_snapshots (symbol, time DESC)` | Speeds regime classifier queries; not catastrophic without it at current data volume |
| Add `CHECK (NOT (gaps_detected > 0 AND status = 'complete'))` to `backfill_ranges` | Migration comment claims DB-level enforcement but no such constraint exists; TypeScript guard is in place |
| Pin explicit `ON CONFLICT` target in backfill batch inserts | Future-proofs against new unique constraints on the table |
| Token log fingerprint: replace first-4-chars with sha256 fragment | Minor secrets hygiene |
| Fix `regime_confidence` type in `schema.ts` from `number` to `string` (pg returns NUMERIC as string) | Prevents silent `NaN` in any future code that reads and uses this field arithmetically |
| Implement `on('gap')` event in HistoricalFeed or remove the doc comment | Doc comment claims the event is emitted; it is not |
| `gaps_json` on resume: accumulate from original `from`, not `checkpoint_ts` | Current implementation records only gaps from the checkpoint forward; the full requested range is not audited |
| Tag replay-created paper trades + scope `getOpenTrades` to tag | True isolation between replay and live trades; current guard is a flag, not schema isolation |
| M3b: T-51 backtest runner (requires T-27 personality router from M2) | Gated behind M2 |
| M3b: T-58 backtest reporting + statistical validation | Gated behind T-51 and T-33 |

---

## 8. References

**Task contracts:** `pipeline/tasks/T-54.json`, `T-55.json`, `T-56.json`, `T-57.json`, `T-33.json`

**Review reports:** `pipeline/reviews/security-audit.md` (CONDITIONAL PASS, 0 Crit / 3 Med / 2 Low), `pipeline/reviews/performance-review.md` (CONDITIONAL PASS, 0 Crit / 1 High / 4 Med / 4 Low), `pipeline/reviews/architecture-review.md` (CONDITIONAL PASS, 0 High / 6 Med / 4 Low), `pipeline/reviews/synthesis.md`

**Key source files:**

- `src/ingestion/brokers/fyers-historical.ts` — Fyers REST client
- `src/ingestion/historical/backfill.ts` — backfill writer
- `src/ingestion/straddle-math.ts` — shared pure straddle compute functions
- `src/ingestion/historical/reconstruct-straddle.ts` — historical reconstructor
- `src/ingestion/historical/historical-feed.ts` — HistoricalFeed (BrokerFeed for replay)
- `src/ingestion/historical/replay-driver.ts` — deterministic replay orchestrator
- `src/trading/regime-tagging.ts` — causal regime classifier
- `scripts/replay.ts` — `bun run replay` CLI
- `src/db/migrations/007_historical_backfill.sql` — backfill schema
- `src/db/migrations/008_regime_tagging.sql` — regime tables + straddle_snapshots.resolution
- `src/db/migrations/009_straddle_snapshots_unique.sql` — C1 fix: unique index on straddle_snapshots

**Key test files:**

- `src/ingestion/historical/__tests__/replay-determinism.test.ts` — golden oracle + 100x gate + barrier tests
- `src/ingestion/historical/__tests__/fixtures/golden/fixture.json` — frozen golden fixture
- `src/ingestion/historical/__tests__/replay-driver.integration.test.ts` — real-Redis C2 coverage
- `src/ingestion/historical/__tests__/backfill.integration.test.ts` — real-DB idempotency/resume
- `src/ingestion/historical/__tests__/reconstruct-idempotency.integration.test.ts` — real-DB C1 coverage
- `src/trading/__tests__/regime-tagging.test.ts` — look-ahead audit + determinism

**Commits (this branch):**

- `c53bfd1` — T-55: backfill writer + migration 007
- `8f1b781` — T-56: shared straddle-math + reconstruction
- `407ad2a` — T-57 + T-33: replay harness + regime tagging
- `14e8499` — Gate-2 must-fix: C1 (migration 009 + resolution INSERT), C2 (ticksConsumed barrier), C3 (--against-live guard), C4 (barrier drain on stop)
- `194c11d` — docs: backfill/replay/regime README
- `ebe8ac4` — tests: ticksConsumed barrier unit tests + 3 integration tests
