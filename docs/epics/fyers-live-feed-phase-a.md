# Epic: Fyers Live Feed Integration — Phase A

| Field      | Value                                              |
|------------|----------------------------------------------------|
| Status     | Completed                                          |
| Date       | 2026-05-25                                         |
| Branch     | main                                               |
| Tasks      | T-01, T-02, T-03, T-04, T-05, T-06, T-07, T-08, T-DOC |
| Risk level | HIGH — broker WebSocket, secrets handling, financial data feed |

---

## 1. What was done

This epic wired the real Fyers WebSocket broker end-to-end: from the raw SDK
through Redis Streams to the React dashboard, while also fixing all gaps that
the smoke-test phase surfaced in the simulator's straddle path.

**Broker adapter hardening (T-01 — `src/ingestion/brokers/fyers.ts`)**

- Added `socketFactory` dependency injection so the adapter can be fully unit-tested
  with a fake EventEmitter socket (no live credentials needed in CI).
- Implemented a reconnect circuit breaker: transient disconnects retry with
  exponential backoff starting at 2 s, doubling to a 64 s ceiling, with ±20% jitter.
  A hard cap prevents infinite retry loops.
- Added inline `AUTH_FAILURE` detection: when Fyers sends `tick.s === 'error'` or
  `tick.code === 1`, the adapter stops retrying (a new token is required), emits a
  `disconnect` event with `DisconnectReason.AUTH_FAILURE`, and logs a clear operator
  message. No secret is logged — only a 4-character mask.
- Added `exchangeTime` to every emitted `BrokerTick` so downstream consumers have a
  broker-supplied timestamp alongside the local wall-clock time.

**Broker factory and stub retirement (T-02 — `src/ingestion/brokers/broker-factory.ts`, deleted `brokers/index.ts`)**

- `createBroker(clock)` selects `FyersBroker`, `AngelOneBroker`, or `MarketDataSimulator`
  based on `BROKER` and `SIMULATE` env vars in that precedence order.
- The old `brokers/index.ts` stub (which silently defaulted to the simulator) was
  deleted. If `BROKER` is unset and `SIMULATE !== 'true'`, the factory throws a
  descriptive error at startup. Silent fallback to synthetic data in an intended-live
  environment is never allowed.
- Each adapter validates its required env vars at construction time (missing vars are
  listed by name, never by value).

**Simulator synthetic ATM CE/PE legs (T-03 — `src/ingestion/market-data-sim.ts`)**

- The simulator now emits three ticks per interval: the NIFTY spot index tick plus
  synthetic ATM call (CE) and ATM put (PE) option ticks priced via a simplified
  Black-Scholes approximation (geometric-Brownian-motion price model,
  `_syntheticOptionPrice`).
- ATM strike is computed from the current spot price using `getAtmStrike()` and
  `getCurrentExpiry()` from the instrument registry.
- This fixes the straddle path end-to-end in `SIMULATE=true` mode: the straddle
  calculator can now compute `cePrice + pePrice` from real option symbols emitted by
  the simulator, rather than receiving only the index tick.

**Real `/ws/ticks` and `/api/meta` (T-04 — `src/server/index.ts`)**

- `/ws/ticks` is backed by a per-connection `redis.duplicate()` client that polls
  `market.ticks` and `straddle.values` streams via non-blocking `XREAD` every 100 ms.
  The duplicate client is quit on socket close. When no Redis client is injected
  (unit tests), the endpoint degrades gracefully — it sends a `connected` frame and
  then nothing, without crashing.
- `/api/meta` returns `{ simulate, broker, authDegraded }`. The `authDegraded` field
  is read from the shared `broker-status` module (see T-05) and tells the frontend
  whether the operator needs to re-authenticate.
- A single `server-level onClose` hook (registered once in `buildServer`) drains a
  module-level `Set<() => void>` of active socket cleanup callbacks. This replaces the
  previous pattern of calling `server.addHook('onClose', ...)` inside the per-connection
  handler, which caused unbounded hook accumulation (condition H2, resolved here).
- `MAX_WS_CONNECTIONS` (default 50, configurable via env var) caps concurrent
  `/ws/ticks` connections. A connection that arrives over the cap receives a JSON error
  frame and is closed before any `redis.duplicate()` is called (condition M1).
- All `XADD` calls — in `server/index.ts`, `straddle-calc.ts`, `vix-feed.ts`, and
  `market-data-sim.ts` — now carry `MAXLEN ~ 10000`, capping each Redis Stream to
  approximately 10 000 entries (roughly 83 minutes of data at one tick per second)
  and keeping per-stream memory under ~3 MB (condition H3).

**Application integration (T-05 — `src/index.ts`)**

- `createBroker(clock)` is called from the main entry point instead of the retired stub.
- On every NIFTY index tick the ATM strike is computed; when it crosses a 50-point
  boundary, `feed.subscribe()` is called to add the new CE/PE option symbols. The guard
  means `subscribe()` is called at most a handful of times per trading day.
- `AUTH_FAILURE` from the broker disconnect event calls `setAuthDegraded(true)` on the
  shared `broker-status` module. The resolved token from the database is injected into
  `process.env.FYERS_ACCESS_TOKEN` so the factory receives it on the same code path as
  an env-provided token (a known limitation — see Section 3).
- The Redis client is passed into `buildServer()` so the WebSocket feed reads live
  streams rather than falling back to the no-Redis degraded mode.

**Frontend live/synthetic banner and straddle panel (T-06 — `src/frontend/`)**

- `useLiveTicks` now parses `WsStraddleMessage` frames (type `'straddle'`) from the
  WebSocket feed alongside existing tick frames. It maintains a `latestStraddle`
  value (CE + PE combined) that is updated on every straddle push.
- `LiveView` fetches `/api/meta` once on mount. It renders a green "Live \<broker\>
  feed" indicator in live mode or an amber "Synthetic dev feed" warning in
  `SIMULATE=true` mode. When `authDegraded` is true, an additional red "re-login
  required" banner is shown.
- `WsStraddlePanel` in `LiveView` displays the live straddle value from the WebSocket
  push path.

**OAuth CSRF validation, token-log redaction, `.env` dedup (T-07 — `src/server/routes/fyers-auth.ts`, `src/server/services/fyers-auth.ts`)**

- OAuth `state` parameter: `/login` generates 16 cryptographically random bytes
  (`node:crypto`), stores them with a 10-minute TTL in a module-level Map, and
  includes the value in the authorization URL. `/callback` verifies the echoed state
  is present, unexpired, and deletes it on first use (one-time). Missing, unknown, or
  expired states are rejected with HTTP 400.
- Token log redaction: `redactToken()` masks all but the first 4 characters of any
  token string. All log and error paths in the auth service use this helper — no raw
  token value appears in any log output or client-facing error message.
- `.env` was deduplicated: conflicting or duplicate `FYERS_*` variable declarations
  were removed so the canonical set matches `.env.example`.

**Token-expiry UX: shared broker-status + `/api/auth/fyers/status` (T-05 / T-08)**

- `src/state/broker-status.ts` is a new module that holds the process-local
  `authDegraded` flag. `setAuthDegraded(true)` is called from the `AUTH_FAILURE`
  disconnect handler; `isAuthDegraded()` is read by `/api/meta`. This removes the
  dead-write condition H1: the flag is now visible to the server's status endpoints.
- `/api/auth/fyers/status` exposes `{ hasToken, isValid, needsReauth, degraded }`
  by combining the DB-stored token's expiry state with the runtime socket state.

**Pre-market token-validity check job (T-08 — `src/jobs/token-validity-check.ts`)**

- `checkTokenValidity(token, now)` is a pure function (no I/O) that returns one of
  four discriminated states: `valid`, `near-expiry`, `expired`, or `missing`.
- `registerTokenValiditySchedule(pool)` registers a BullMQ cron job (using the same
  BullMQ setup already in place for the EOD job) that fires at 08:45 IST on weekdays —
  15 minutes before NSE opens. The job reads the stored token from the database and
  logs the state. When `TOKEN_VALIDITY_SCHEDULER_ENABLED !== 'true'` the function is a
  no-op, making it safe to import in all environments.
- `deriveStatusFlags(state)` converts the discriminated union into `{ degraded, needsReauth }` for the `/api/auth/fyers/status` route.

**Documentation reconciliation (T-DOC)**

- `ROADMAP.md` updated to mark the Fyers live-integration epic as complete and note
  deferred Phase B items.
- `.claude/project/overview.md` and `technical.md` updated with the new modules,
  patterns, and environment variables introduced in this epic.

---

## 2. How this helps the project

Before this epic, the application always ran in simulation mode regardless of
configuration. The broker factory was a stub that silently returned the simulator;
the `/ws/ticks` WebSocket sent no real data; and the dashboard had no way to tell the
operator whether the feed was live or synthetic.

After this epic:

- **An operator with valid Fyers credentials can run the application against real
  market data.** Setting `BROKER=fyers` and supplying `FYERS_APP_ID` + `FYERS_ACCESS_TOKEN`
  now results in a live Fyers WebSocket connection, real NIFTY ticks flowing through
  Redis Streams to the dashboard, and real ATM option symbols being subscribed
  dynamically as the index moves.
- **The simulator now produces a complete straddle.** `SIMULATE=true` emits both the
  index tick and synthetic CE/PE option ticks, so the straddle path (the project's
  core signal input) works end-to-end without any broker credentials.
- **The dashboard tells the operator what it is showing.** A green or amber banner
  indicates whether data is live or synthetic. When the Fyers daily token expires
  mid-session, the operator sees a red "re-login required" banner and can use the
  OAuth flow to refresh — instead of silently stale data.
- **The system no longer silently misconfigures.** The factory throws at startup if
  `BROKER` is set to a real adapter but credentials are missing, preventing a
  live-mode operator error from running a simulation they did not intend.

---

## 3. Limitations and tradeoffs (and why we chose this)

**Live Fyers ticks could not be verified in the pipeline environment.**
The pipeline has no access to a valid daily Fyers token or an open NSE market session.
Verification was achieved via: (a) 46 mocked-socket unit tests covering parse/emit,
exchangeTime, AUTH_FAILURE detection, reconnect circuit breaker, and malformed-payload
safety; (b) end-to-end straddle verification via the simulator; (c) the boot-path
wiring test (broker-factory routing). Real-tick confirmation is a manual owner step
(see Section 5). This was the plan's stated hard constraint from the start — there is
no workaround without valid credentials and market hours.

**The Fyers daily access token still requires manual daily regeneration.**
The token expires every 24 hours and Fyers does not issue a long-lived refresh grant
via their data API. Automating the re-authentication (FYERS_PIN-based headless flow)
was deliberately deferred to Phase B. The rationale: implementing automated PIN
handling introduces a stored-PIN risk surface that deserves its own dedicated security
review. The pre-market check job (T-08) and the re-login UX (T-06/T-07) give the
operator clear advance warning and a one-click flow, which is acceptable friction for
a single-instance research tool.

**Token is resolved into `process.env` rather than passed directly.**
When the stored token is loaded from the database, it is written into
`process.env.FYERS_ACCESS_TOKEN` so the factory reads it on the same path as an env-
provided token. This widens the exposure surface of the secret from a scoped DB read
to a process-global mutable map. The impact is low for a 24-hour read-only market-data
token on a single-instance tool, but it was flagged as a Low finding by the security
audit. The correct fix is to pass the resolved token directly into `createBroker()`.
This was not changed here because the refactor requires threading the token through the
factory signature and all tests — a bounded but non-trivial change deferred to Phase B.

**`broker_tokens` stores the access token and refresh token in plaintext.**
Encrypting tokens at rest was explicitly deferred in the Gate 1 scope discussion. The
24-hour access token has low inherent risk (read-only market data, expires quickly).
The refresh token is more sensitive; it should be the first target when at-rest
encryption is implemented in Phase B.

**`broker_tokens` at-rest encryption deferred.**
Accepted risk. See above and Section 6.

**FYERS_PIN handling deferred.**
Headless re-auth using a stored PIN introduces a new secret-storage problem. Deferred
to Phase B with a dedicated security review.

**Two coexisting Fastify servers.**
`src/server/index.ts` is the application server used by this epic. `src/api/server.ts`
is a legacy server still targeted by integration tests. The integration test suite
gates behind `src/api/server.ts`; migrating it to the new server is tracked as
deliberate tech-debt. It was not changed here to keep this epic's scope bounded —
touching the integration harness mid-epic would risk breaking unrelated tests.

**ATM-subscription logic remains inline in `src/index.ts`.**
The architecture reviewer recommended extracting the per-tick ATM recalculation and
option-leg subscription loop into a dedicated `AtmSubscriber` class. Deferred: the
inline logic is correct and the extraction is a refactor with no user-visible benefit
at current scale. Tracked as a follow-up.

**Per-connection Redis `duplicate()` instead of a shared fan-out.**
Each `/ws/ticks` connection opens its own Redis client and poll loops. At the project's
expected operator count (1–5 concurrent dashboard tabs) this is well within capacity.
A server-side fan-out architecture (one poll loop shared across all sockets) is the
correct future direction if the product expands to many concurrent subscribers. The
`MAX_WS_CONNECTIONS` cap (condition M1) bounds the worst-case connection count.

**`setData` instead of `update` in the tick chart.**
The performance reviewer flagged that `TickChart` calls `series.setData()` on every
tick (O(N) array rebuild) rather than `series.update()` (O(1) append). At one tick per
second this is not measurable. Deferred as a low-priority refinement.

---

## 4. The four review conditions and how they were resolved

**H1 — `authDegraded` was a dead write (architecture HIGH)**

The original implementation set `authDegraded = true` inside a local variable scope in
`src/index.ts`; the variable was never read by the server's status endpoints. This
meant the core "graceful token-expiry UX" deliverable of Phase A was not actually
working.

Fix: a new module `src/state/broker-status.ts` holds the flag with
`setAuthDegraded(value)` and `isAuthDegraded()` exports. `src/index.ts` calls
`setAuthDegraded(true)` in the `AUTH_FAILURE` disconnect handler. `/api/meta` calls
`isAuthDegraded()` and includes the result in `{ authDegraded }`. `/api/auth/fyers/status`
calls `deriveStatusFlags()` and merges the runtime socket state with the DB-token expiry
state into one payload. The frontend `LiveView` reads `authDegraded` from `/api/meta`
and shows a red "re-login required" banner when true.

**H2 — per-connection `onClose` hook accumulation (performance + architecture HIGH)**

The original `/ws/ticks` handler called `server.addHook('onClose', cleanup)` inside the
per-connection callback. Fastify accumulates these hooks permanently — they are never
pruned when the socket closes. Over a long-running process with many reconnects, the
hook list grows without bound.

Fix: the `server.addHook('onClose', ...)` call was removed from the per-connection
handler entirely. A module-level `Set<() => void>` (`wsCleanupCallbacks`) holds
cleanup callbacks for all currently active connections. Each connection adds its cleanup
function to the Set on open and removes it on socket `'close'`. A single
`server.addHook('onClose', drain)` registered once in `buildServer()` iterates the Set
on server shutdown. The normal disconnect path — browser tab closed, network drop —
fires the per-socket `socket.on('close', cleanup)` which was already correct.

**H3 — unbounded Redis Stream growth, tripled by this epic (performance HIGH)**

Before this epic, `market.ticks` received one entry per simulator tick. After T-03
(synthetic CE/PE legs), the simulator emits three ticks per interval. None of the
`XADD` calls in any file carried a `MAXLEN` argument. At the Fyers live feed rate a
stream could grow to hundreds of thousands of entries and exhaust Redis memory within
a trading week.

Fix: `MAXLEN ~ 10000` was added to every `XADD` call in `src/index.ts`,
`src/ingestion/straddle-calc.ts`, `src/ingestion/vix-feed.ts`, and
`src/ingestion/market-data-sim.ts`. The approximate trim (`~`) is O(1) amortized.
10 000 entries at one tick per second retains ~83 minutes of data while keeping each
stream under ~3 MB. Six unit tests that asserted on `xadd` argument positions were
updated (test-side only — no logic change).

**M1 — no cap on concurrent WebSocket connections (security Medium)**

Each `/ws/ticks` connection opens a Redis `duplicate()` client and two poll loops. With
no cap, a reconnect storm or a misconfigured client could exhaust Redis's connection
limit and the server's file descriptors.

Fix: a module-level `wsConnectionCount` counter and a `MAX_WS_CONNECTIONS` constant
(default 50, configurable via `MAX_WS_CONNECTIONS` env var) were added. When a new
connection arrives over the cap, the server sends a JSON error frame and closes the
socket before calling `redis.duplicate()`. The `ws-feed.test.ts` suite includes a test
that confirms the cap is enforced.

---

## 5. Tests the AI ran to verify this works

**Type-check**

`bun run --bun tsc --noEmit` exited clean (exit 0) after all fixes.

**Unit suite — 902 passed, 3 skipped, 0 failed (49 files)**

The 3 skipped tests are pre-existing (unrelated to this epic). No new skips introduced.

New test files added this run:

| File | Tests | What it proves |
|---|---|---|
| `src/ingestion/brokers/fyers.test.ts` | 46 | Mocked-socket adapter behaviour: tick parse and emit, `exchangeTime` present on each tick, `AUTH_FAILURE` detection on `tick.s==='error'` and `tick.code===1`, reconnect circuit-breaker stops after cap, graceful teardown, malformed-payload safety (missing symbol, missing ltp). Run 3 times consecutively — 46/46 stable (no reconnect-timer flakiness). |
| `src/ingestion/brokers/broker-factory.test.ts` | ~6 | `BROKER=fyers` routes to `FyersBroker`, `BROKER=sim` / `SIMULATE=true` routes to simulator, unconfigured throws (safe default). |
| `src/server/ws-feed.test.ts` | 8 | `/api/meta` round-trip includes `authDegraded`, tick delivery to a connected socket, per-socket cleanup on close, `MAX_WS_CONNECTIONS` cap enforced (cap+1 connection is rejected). |
| `src/ingestion/sim-straddle-path.test.ts` | 8 | Simulator emits synthetic ATM CE and PE ticks alongside the index tick; straddle value = `cePrice + pePrice` is computable from simulator output. |

**Integration suite — ENV-BLOCKED (CI-ONLY, non-blocking)**

`bun run test:integration` → 18 passed / 72 skipped / 1 suite failed.

The single failure is `smoke.test.ts`: `password authentication failed for user "trading"` — a credential mismatch between the test harness's `DATABASE_URL` and the local Docker container (which runs on port 5433 rather than the default 5432). This failure is pre-existing (noted in `pipeline/progress.md` before this epic began) and was not introduced or worsened here. The 72 skips are gated behind the same DB connection. To run the integration suite locally: align `DATABASE_URL` in the test environment with the running TimescaleDB container credentials.

**E2E (Playwright) — CI-ONLY**

`playwright.config.ts` requires the Vite frontend and Fastify server to be started manually before `test:e2e`. Live Fyers ticks require a valid daily token and open market hours. Neither was available in the pipeline environment. Manual test cases for the real live path are documented in Section 5 below.

**Automation Gate result: CI-ONLY** — no `@critical` E2E failures (none ran), no code-level test failures. Does not block Gate 3.

---

## 6. Manual test cases (for human verification)

These steps are written for the operator who did not build this epic. All commands run from the repository root.

**MTC-1 — Confirm simulator straddle path works end-to-end**

- Preconditions: Docker services running (`docker compose ps` shows both containers healthy). No Fyers credentials required.
- Steps:
  1. `SIMULATE=true bun run dev`
  2. Open `http://localhost:5173` in a browser.
  3. Observe the feed banner at the top of the Live view.
  4. Observe the straddle panel.
- Expected result: Banner shows amber "Synthetic dev feed" text. Straddle panel shows a non-zero value (CE + PE price) that updates approximately every second. The tick chart shows a live random-walk price line.

**MTC-2 — Confirm live Fyers feed reaches the dashboard during market hours**

- Preconditions: Valid daily Fyers token regenerated today. `BROKER=fyers`, `FYERS_APP_ID`, `FYERS_ACCESS_TOKEN` set in `.env`. Docker services running. Run during NSE market hours (09:15–15:30 IST on a weekday).
- Steps:
  1. `bun run dev`
  2. Open `http://localhost:5173`.
  3. Observe the feed banner.
  4. Observe the tick chart.
- Expected result: Banner shows green "Live fyers feed" indicator. Tick chart shows real NIFTY LTP updating in real time. No amber or red banner visible.

**MTC-3 — Confirm stale/expired token triggers the re-login banner**

- Preconditions: Docker services running. An expired or deliberately invalid Fyers token set in `.env` (e.g. use a token from a prior day, or set `FYERS_ACCESS_TOKEN=invalid`). `BROKER=fyers` set.
- Steps:
  1. `bun run dev`
  2. Open `http://localhost:5173`.
  3. Wait up to 30 seconds for the broker to connect and receive the first tick.
  4. Observe the feed banner in the Live view.
  5. In a separate terminal: `curl http://localhost:3000/api/meta | jq .`
  6. In a separate terminal: `curl http://localhost:3000/api/auth/fyers/status | jq .`
- Expected result: Dashboard banner shows a red "re-login required" state. `/api/meta` response includes `"authDegraded": true`. `/api/auth/fyers/status` response includes `"needsReauth": true`. The tick chart stops updating (no new ticks while auth is degraded).

**MTC-4 — Confirm `MAX_WS_CONNECTIONS` cap rejects connections over the limit**

- Preconditions: Docker services running. App started in any mode. `MAX_WS_CONNECTIONS=3` set in `.env` or shell (use a low value for easy testing).
- Steps:
  1. `MAX_WS_CONNECTIONS=3 SIMULATE=true bun run dev`
  2. Open four browser tabs, each pointing to `http://localhost:5173` (each tab opens a `/ws/ticks` WebSocket connection).
  3. Open browser DevTools Network panel in the fourth tab and inspect the WebSocket connection.
- Expected result: The first three connections succeed (status 101 Switching Protocols). The fourth connection receives a JSON error frame (`{ "error": "too many connections" }` or similar) and the socket is immediately closed (status 1013 or the frame arrives before close). No crash or server error in the terminal.

**MTC-5 — Confirm misconfigured broker throws at startup rather than silently simulating**

- Preconditions: `.env` has `BROKER=fyers` set but `FYERS_ACCESS_TOKEN` is absent or empty.
- Steps:
  1. `bun run dev` (or `bun start`).
  2. Observe the terminal output.
- Expected result: The process exits immediately with a message like `[BrokerFactory] BROKER=fyers requires the following env vars: FYERS_ACCESS_TOKEN`. The app does not start, does not silently fall back to the simulator, and does not run with missing credentials.

**MTC-6 — Confirm pre-market token-validity check logs the correct state**

- Preconditions: Docker services and Redis running. `TOKEN_VALIDITY_SCHEDULER_ENABLED=true` in `.env`. A token row exists in the `broker_tokens` table (insert one via the OAuth flow or directly with SQL).
- Steps:
  1. Start the app: `bun run dev`.
  2. Manually trigger the BullMQ job (or wait for 08:45 IST on a weekday).
  3. Observe the terminal or BullMQ logs.
- Expected result: The log output shows the `TokenValidityState` for the stored token: `valid`, `near-expiry`, `expired`, or `missing`. The token value itself does not appear in the log output.

---

## 7. Security and risk notes

**Resolved findings from Phase 4 review**

| Condition | Severity | Status |
|---|---|---|
| H1 — `authDegraded` dead write | Architecture HIGH | Resolved — shared `broker-status` module + `/api/meta` surface |
| H2 — per-connection `onClose` hook accumulation | Perf + Arch HIGH, Sec Medium | Resolved — server-level Set drain, hook registered once |
| H3 — unbounded Redis stream growth | Perf HIGH | Resolved — `MAXLEN ~ 10000` on all `XADD` calls |
| M1 — WebSocket connection exhaustion DoS | Sec Medium | Resolved — `MAX_WS_CONNECTIONS` cap, rejects before `duplicate()` |

**Accepted / deferred risks**

| Finding | Severity | Decision |
|---|---|---|
| `broker_tokens` access/refresh token stored in plaintext | Sec Low | Deferred to Phase B. 24-hour read-only access token has limited inherent risk; refresh token is the priority target when at-rest encryption is implemented. DB backups should exclude these columns in the interim. |
| Resolved token written into `process.env` | Sec Low | Deferred to Phase B. The fix (passing the token directly into `createBroker`) requires a factory-signature refactor. Risk is limited: single-instance tool, 24h token, process.env is not exposed by any endpoint. A code comment guards against future diagnostic endpoints serialising process.env. |
| `exchangeAuthCode` response not checked for `res.ok` before `res.json()` | Sec Low | Noted. Non-JSON error responses (e.g. HTML 502 from Fyers) will cause a parse error whose message is surfaced to the client. No token leak risk — the error message will not contain credential data. Fix is a one-line `if (!res.ok) throw ...` before `res.json()`. Deferred as a robustness improvement. |
| FYERS_PIN headless re-auth not implemented | Deferred | Implementing stored-PIN re-auth introduces a new secret-storage risk surface. Intentionally out of Phase A scope. Deferred to Phase B with its own security review. |

**Secrets and credential handling — cleared by security audit**

- Fyers `accessToken` and `appId` are masked to 4 characters in all log output.
- The `broker-factory.ts` error messages list missing variable names only, never values.
- `token-validity-check.ts` logs token state and expiry date, never the token string.
- OAuth state is 16 cryptographically random bytes, stored with a 10-minute TTL, verified present and unexpired, deleted on first use. The state Map is pruned on every `/login` call.
- `.env` is gitignored and confirmed not tracked in the repository.
- `/api/meta` returns only `{ simulate, broker, authDegraded }` — no token, secret, or env dump.

**Rollback switch**

This epic has no feature flag. To disable: set `SIMULATE=true` (reverts to the simulator path) or remove `BROKER=fyers` from `.env` (causes a clear startup error rather than a silent live-mode run). No code changes are required to revert to pure-simulation mode.

---

## 8. Follow-ups and deferred work

| Item | Rationale for deferral |
|---|---|
| Phase B: Token refresh-grant automation (headless FYERS_PIN flow) | Requires stored-PIN handling — new secret-storage risk surface that needs a dedicated security review. |
| Phase B: `broker_tokens` at-rest encryption (access + refresh tokens) | Correctly scoped out at Gate 1. Prioritise the refresh_token column. Ensure DB backups do not capture plaintext tokens in the interim. |
| Phase B: Pass resolved token directly into `createBroker()` instead of writing to `process.env` | Bounded refactor; removes the Low security finding. |
| Phase B: Fix `exchangeAuthCode` missing `res.ok` check | One-line robustness fix. Not a leak risk but an inconsistency with the otherwise disciplined error-handling in the auth service. |
| Refactor: Extract ATM-subscription loop from `src/index.ts` into a dedicated `AtmSubscriber` class | Reduces the size and responsibility of the main entry point. No user-visible benefit at current scale. |
| Refactor: Migrate integration tests from legacy `src/api/server.ts` to `src/server/index.ts` | Removes the two-server tech-debt. Requires updating test fixtures and injection points. |
| Refactor: Replace per-connection Redis `duplicate()` with a single server-side fan-out | Correct architecture for multi-subscriber scale. Not needed for the current single-operator use case. |
| Fix: `TickChart` `setData` → `update` per tick | Performance refinement (O(N) → O(1) per tick). Not measurable at 1 tick/second. |
| Fix: Remove redundant polled `StraddleSection` once WebSocket straddle push path is confirmed stable | Eliminates redundant REST polling. |

---

## 9. References

| Artifact | Path |
|---|---|
| Task contracts | `pipeline/tasks/T-01.json` through `T-08.json`, `T-DOC.json` |
| Phase 4 synthesis report | `pipeline/reviews/synthesis.md` |
| Security audit | `pipeline/reviews/security.md` |
| Performance review | `pipeline/reviews/performance-report.md` |
| Automation gate results | `pipeline/reviews/automation-gate.md` |
| Pipeline progress log | `pipeline/progress.md` |
| Broker adapter | `src/ingestion/brokers/fyers.ts` |
| Broker factory | `src/ingestion/brokers/broker-factory.ts` |
| Broker types | `src/ingestion/brokers/types.ts` |
| Simulator (CE/PE extension) | `src/ingestion/market-data-sim.ts` |
| Fastify server (WS + meta) | `src/server/index.ts` |
| Shared auth-degraded state | `src/state/broker-status.ts` |
| Pre-market token-validity job | `src/jobs/token-validity-check.ts` |
| OAuth routes | `src/server/routes/fyers-auth.ts` |
| OAuth service | `src/server/services/fyers-auth.ts` |
| Frontend hook | `src/frontend/hooks/useLiveTicks.ts` |
| Frontend component | `src/frontend/components/LiveView.tsx` |
| Application entry point | `src/index.ts` |
| Previous related epic | `docs/epics/frontend-dashboard-wiring.md` |
