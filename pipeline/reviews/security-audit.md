# Security Audit — Milestone 3a (Historical Backfill, Reconstruction, Replay, Regime Tagging)

Auditor: security-auditor (mandatory gate)
Branch: claude/hopeful-lovelace-Kaqsz
Risk level: HIGH (financial-logic, public-facing-api)
Scope: T-54, T-55, T-56, T-57, T-33 (see task list). M3b (T-51 HTTP endpoint) NOT yet built — not assessed.

Project context applied: single-instance unauthenticated server; per-user auth is out of scope and NOT flagged. Secrets that matter: Fyers credentials and the stored `broker_tokens` row. Razorpay is out of M3 scope.

---

## Summary of approach

I read all in-scope files fully, plus the supporting code they depend on:
`src/server/services/fyers-auth.ts` (credential resolution / token storage),
`src/db/migrate.ts` (migration transaction model), and
`src/db/migrations/001_core_schema.sql` (original hypertable definitions and primary keys).

The code is unusually disciplined: every SQL statement in the new modules uses bound parameters, the outbound Fyers host is a hard-coded constant, tokens are masked in logs, and the "never fabricate / never zero-fill" research-integrity rule is honoured in the fetch and reconstruction paths. Most of my findings are about correctness with a security/integrity impact rather than classic injection/secret-leak holes.

---

## Findings

### 🟡 Medium — Reconstructor `ON CONFLICT DO NOTHING` is a dead clause; re-running silently duplicates financial snapshot rows
File: `src/ingestion/historical/reconstruct-straddle.ts:287-306` (`writeSnapshot`)
Cross-ref: `src/db/migrations/001_core_schema.sql:37-50` (only constraint on `straddle_snapshots` is `PRIMARY KEY (id, time)` where `id BIGSERIAL`); confirmed no other unique index on the table in any migration.

What it is: `writeSnapshot` inserts with `ON CONFLICT DO NOTHING` and no conflict target. With no explicit target, Postgres can only fire the clause against an existing unique constraint. The sole constraint is the composite primary key `(id, time)`, and `id` is `BIGSERIAL` — every INSERT mints a brand-new `id`, so a conflict is structurally impossible. The clause never fires. The in-code comment claiming "TimescaleDB will not create duplicate rows for the same (time, symbol, strike, expiry) combination in practice" is incorrect — there is no such constraint.

Why it matters: reconstruction is explicitly idempotent in its design contract (the doc-comment says "re-running reconstruction over an already-filled range is safe and idempotent"). It is not. A second `reconstructStraddle()` run over the same range writes a full duplicate set of `straddle_snapshots` rows. Those snapshots feed the regime classifier (`loadSnapshotsForDay`) and any future backtest P&L. Duplicated rows inflate `snapshotCount`, distort `meanAbsAcceleration` / `rocSignChangeFraction` (each duplicated ROC pair is counted again), and can flip a `RANGING` day to `VOLATILE_REVERTING` or change `dataCompleteness`. For a research tool whose entire value is trustworthy historical metrics, silent duplication is a research-integrity defect.

How to fix it (pick one):
1. Add a partial/real `UNIQUE` index on `straddle_snapshots (time, symbol, strike, expiry)` (mirroring the backfill pattern; scope it `WHERE resolution IS NOT NULL` if you only want it for reconstructed rows) and name it as the explicit `ON CONFLICT` target. This is the cleanest fix and makes the idempotency claim true.
2. If a new unique index is undesirable on a hypertable, make reconstruction explicitly delete-then-insert the target range inside one transaction (bounded `DELETE ... WHERE symbol=$1 AND time >= $2 AND time <= $3 AND resolution IS NOT NULL`), so a re-run replaces rather than appends.
Until fixed, document loudly that reconstruction is append-only and must run against an empty range, and update the misleading comment.

### 🟡 Medium — `bun run replay` writes to the real DB/Redis and the position monitor reads/closes ALL open trades — no isolation guard
File: `scripts/replay.ts:26-36, 163-233`; `src/trading/position-monitor.ts:249-322` (`evaluateSnapshot` calls `getOpenTrades(db)` with no symbol/source filter and `exitTrade` on matches).

What it is: the replay script connects to the real `DATABASE_URL`/`REDIS_URL` (defaulting to `postgresql://trading:trading@localhost:5432/trading` and `redis://localhost:6379`), runs migrations against it, and starts the live `PositionMonitor`. The monitor's `evaluateSnapshot` loads *every* open paper trade in the DB and will close any that meet an exit condition against the replayed (historical) straddle values. There is no flag separating "replay-generated" trades from real ones, and nothing stops a replay run from publishing historical straddle values onto the same `straddle.values` stream a live monitor is consuming.

Why it matters: this is a DoS / data-corruption surface against the operator's own research data. Running a replay against a database that also holds live or prior paper-trade results will mutate `paper_trades` (forced exits at historical prices), publish thousands of historical ticks onto the shared `market.ticks` / `straddle.values` streams, and overwrite/contend with any concurrently running live pipeline. The script's header comment warns the operator to "use a separate test database," but it is only a comment — the code has no enforcement. For a single-instance commercial tool this is the most likely real-world foot-gun in the milestone.

How to fix it:
- Refuse to run unless an explicit opt-in is present (e.g. require `REPLAY_TARGET_DB` distinct from the live `DATABASE_URL`, or require an env like `ALLOW_REPLAY_ON=<dbname>` that must match the connected DB name). Fail loud otherwise.
- Strongly preferred: tag replay-created paper trades (e.g. a `source`/`is_replay` column or a dedicated `personality`/run-id) and have the replay's PositionMonitor scope `getOpenTrades` to that tag, so a replay can never touch real trades. At minimum, route replay onto a distinct Redis stream / DB schema.

### 🟡 Medium — Unbounded in-memory load in `historical-feed.load()` despite a documented page-size control
File: `src/ingestion/historical/historical-feed.ts:53-73, 221-284, 360-379`; reachable from `scripts/replay.ts:200-218`.

What it is: `HistoricalFeedConfig.fetchPageSize` is documented ("Default 1000 … keeps memory bounded for large replay windows — rows are fetched in pages") but is never read or used. `fetchMarketTicks` and `fetchOptionTicks` each run `SELECT … WHERE time >= $1 AND time <= $2 ORDER BY time ASC` with no `LIMIT` and no paging, then `load()` holds the entire merged result in a JS array. The replay CLI accepts an arbitrary `--from`/`--to` with the only check being `from < to` — there is no maximum window. A user (or the operator fat-fingering a year-wide range) can ask the feed to materialise tens of millions of rows into memory.

Why it matters: this is an unbounded-resource path on a hypertable. A wide replay window will OOM the Bun process (and, because `ORDER BY time` spans many chunks, push significant sort load onto Postgres). The query is correctly time-bounded so it is not a *full*-table scan, but "bounded by a user-supplied range with no cap" is effectively unbounded. This is the DoS surface called out in the audit focus #4.

How to fix it:
- Either implement the documented paging (keyset pagination on `time` with `fetchPageSize` + streaming emit) or enforce a hard maximum replay-window span in `parseArgs`/`createHistoricalFeed` (e.g. reject windows longer than N days unless an explicit override flag is passed), and add `LIMIT` as a backstop. Remove the dead `fetchPageSize` doc if paging is not implemented, so the safety control is not falsely advertised.

### 🟢 Low — Access token prefix (first 4 chars) written to logs
File: `src/ingestion/brokers/fyers-historical.ts:548, 750-754`.

What it is: on HTTP 401 the error message embeds `creds.accessToken.slice(0, 4)`, and the startup diagnostic log line prints `appId.slice(0,4)...` and `token.slice(0,4)...`. This is deliberate masking, and 4 characters of a long opaque token is low entropy to leak.

Why it matters: minor. Logs that ever reach a shared sink (Railway/Fly logs, a future log aggregator) accumulate small fragments of a daily-rotating secret. The risk is low because the token expires daily and 4 chars is not enough to reconstruct it, but partial-secret-in-logs is still a habit worth not normalising in a HIGH-risk financial repo.

How to fix it: prefer a non-reversible fingerprint (e.g. first 6 chars of `sha256(token)`) or drop the token fragment entirely and log only `appId` prefix. The appId is an identifier, not a secret, so it is fine.

### 🟢 Low — Credential resolution prefers env vars over the freshly stored DB token, with no expiry check
File: `src/ingestion/brokers/fyers-historical.ts:375-400`; `src/server/services/fyers-auth.ts:112-132` (`StoredToken.expiresAt` exists but is never consulted here).

What it is: `resolveCredentials` returns the env-var token if present, only falling back to `broker_tokens`. Neither path checks `expiresAt`. Fyers tokens expire daily (documented in technical.md). The intended resilience for an expired token is the resumable `FyersAuthError` path on 401 — which is reasonable and is the known/accepted deviation.

Why it matters: low, and partly by design. Two small concerns: (a) if a stale `FYERS_ACCESS_TOKEN` is left in the environment, it always shadows a fresh DB token written by the OAuth flow, guaranteeing a 401 round-trip every run until the env var is cleared; (b) `expiresAt` is available and could pre-empt the wasted request. This is a robustness nit, not a vulnerability.

How to fix it (optional): when both sources exist, prefer the non-expired one (compare `expiresAt`), or at least log a clear warning when an env token is used while a stored token also exists. Not a blocker.

---

## Assessment of pre-flagged / focus items

1. **SQL injection / unsafe query construction** — PASS. Every query in the five modules uses bound `$N` parameters. The multi-row INSERT builders in `backfill.ts` (`writeMarketTicks`/`writeOptionTicks`) generate only `($1,$2,…)` placeholder *positions* programmatically — the literal text is never derived from data; all values go through `params`. `loadEventCalendar` uses `TO_CHAR(event_date,'YYYY-MM-DD')` with a constant format string (no input). No string interpolation of external values anywhere.

2. **Secrets handling in the Fyers client** — Largely good. Host is fixed; tokens are masked; `FyersNoCredentialsError` fails loud rather than running zero-data. The two nits above (🟢 partial-token-in-log, 🟢 resolution-order/expiry) are the only items. Note `exchangeAuthCode` in `fyers-auth.ts` does `JSON.stringify(body)` into an error on a non-`ok` token exchange (line 82); Fyers error bodies are not expected to echo the secret, but consider trimming to `body.message` to avoid ever serialising an unexpected field — out-of-strict-scope but adjacent.

3. **SSRF / outbound-request safety** — PASS. `FYERS_HISTORY_URL` is a module constant built from a hard-coded host; the only caller-supplied inputs (`symbol`, `resolution`, epoch range) are passed via `URLSearchParams`, which percent-encodes them — they cannot alter the host/path. The injectable `fetchFn` is for tests only and still targets the fixed URL.

4. **Resource-exhaustion / DoS** — Two real items found above (🟡 unbounded `load()`, 🟡 replay hitting the real DB/all-trades). The Fyers fetch path itself is well-bounded (per-resolution day caps, sequential chunking, capped retries/backoff). The reconstructor and regime queries are all time-range bounded with `LIMIT 1` or per-day windows — good hypertable discipline.

5. **Migration safety (007 / 008)** — PASS with one note.
   - `007` `ALTER TABLE option_ticks ADD COLUMN ... NOT NULL DEFAULT 'fyers'`: on PostgreSQL 11+ a `NOT NULL DEFAULT` with a constant default is a metadata-only operation (no full table rewrite), so this is safe even on a populated hypertable. Correct.
   - Partial unique indexes `WHERE source = 'fyers-historical'`: correct design. The key space is empty at build time (instant, negligible lock), they include the `time` partition column as required for hypertables, and they are the only matchable target for the backfill `ON CONFLICT DO NOTHING` (the `(id,time)` PK can't conflict because `id` is BIGSERIAL — verified against 001). The INVALID-index cleanup `DO $$` guards make re-runs safe.
   - Idempotency: all statements use `IF NOT EXISTS` / `ON CONFLICT DO NOTHING`; each migration runs in its own transaction (`migrate.ts`). Good.
   - Note (not a finding): `008` seeds `2025-04-18 Good Friday` etc.; the `2024-04-21 'Good Friday (if applicable)'` and several `(provisional)` 2026 entries are best-effort. A *wrong* event date silently mislabels a day as `EVENT_DAY` (highest precedence, overrides real straddle signal). This is a data-quality/integrity concern for backtest correctness, not a security hole — flagging for the data owner to verify against the authoritative NSE/RBI calendars.

6. **Input validation at boundaries** — Good. `replay.ts` validates `--from`/`--to` are parseable dates, `--underlying` against an allow-list, `--speed` finite>0, and `from<to`. `reconstructStraddle` and `createHistoricalFeed` validate Date validity, `from<=to`, and `cadenceMs>0`. The only gap is the *absence of an upper bound* on the date range (see 🟡 unbounded load). Symbols flowing to Fyers are URL-encoded; symbols flowing to SQL are parameterised.

7. **Silent fabricated / zero-filled financial data** — Strong PASS, this is clearly a designed-in invariant.
   - `fyers-historical.parseCandles` zero-fills *volume only* (explicitly justified) and never zero-fills OHLC; non-finite price candles are skipped, not faked.
   - Missing chunks become explicit `gaps`, never synthetic candles.
   - `backfill.finaliseRange` enforces "gaps present ⇒ status `gapped`, never `complete`" both in TS and via the migration `CHECK` constraint.
   - `reconstruct-straddle` throws/records `MissingLegError` on an absent CE/PE leg and does NOT advance the ROC buffer across a gap — correct causal handling, no interpolation.
   - `regime-tagging` routes gapped/sparse days to `UNCLASSIFIED` rather than defaulting them to `RANGING`.
   The one place this invariant is undermined is indirect: the dead `ON CONFLICT` in the reconstructor (🟡 #1) can silently *duplicate* real data, which corrupts the same downstream metrics the no-fabrication rule is meant to protect.

**Known deviation — T-54 has no token refresh, throws resumable `FyersAuthError` on 401:** Assessed as SAFE and NOT a silent-failure hole. The 401 / Fyers-`code=16` / token-message path throws loudly, carries `lastSuccessfulCutoff`, and `backfill.ts` converts it to `BackfillResumeError` after writing a `partial` checkpoint — no data is fabricated and no range is marked `complete`. The operator must refresh the token and re-run, which is acceptable for a research tool with documented daily token rotation. The only adjacent nit is the wasted 401 round-trip when a stale env token shadows a fresh DB token (🟢 #5).

---

## VERDICT

**CONDITIONAL PASS** — no Critical findings; no injection, SSRF, or material secret-leak. Conditions before merge: (1) fix or loudly document the reconstructor's non-idempotent `ON CONFLICT` duplication (🟡), (2) add an isolation guard so `bun run replay` cannot mutate real paper trades / live streams (🟡), and (3) bound the replay window / implement the advertised paging in `historical-feed.load()` (🟡). The two 🟢 items (partial-token logging, credential resolution order) are recommended but not blocking.
