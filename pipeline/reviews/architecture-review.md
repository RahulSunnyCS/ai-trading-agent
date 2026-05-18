# Architecture Review Report

## Summary
Verdict: CONDITIONAL PASS

The backend structure is clean and well-layered for a Phase 1 MVP. Concerns are
concentrated in three areas: a silent dropped-await on the broker connect call
that can mask startup failures, a structural inconsistency in how the
`ClockWithTick` extension is defined (duplicated across four files instead of
one), and a small but concrete env-var naming mismatch that will confuse any
operator configuring Angel One for the first time. None of these are show-stoppers,
but two of them carry real operational risk before Phase 2 expands the system.

---

## Findings

### 🔴 Critical

**broker.connect() is unawaited at startup — failures are silently swallowed**

File: `/home/user/ai-trading-agent/src/index.ts` line 99

`broker.connect()` returns `Promise<void>` (confirmed in `BrokerFeed.connect()` and
both concrete implementations). The call site in `main()` drops the promise on the
floor without `await`. Because `connect()` in the Fyers and Angel One adapters
performs authentication and opens a WebSocket, any failure in those steps — expired
token, network error, bad credentials — is swallowed silently. The application
continues to "start" (the HTTP server comes up, migrations succeed), but the
data feed is dead from the first line of startup and no error surfaces.

The simulator's `connect()` is safe (it only registers a clock tick), so this is
invisible in simulation mode and will only bite on a live market day.

Recommendation: `await broker.connect()` in `main()`. The existing SIGTERM handler
and fail-fast pattern in `runMigrations()` make this a one-line fix that is
consistent with the rest of the startup sequence.

---

### 🟡 Medium

**`ClockWithTick` intersection type is defined four times independently**

Files:
- `/home/user/ai-trading-agent/src/ingestion/straddle-calc.ts` (line 30, named `ClockWithTick`)
- `/home/user/ai-trading-agent/src/ingestion/brokers/broker-factory.ts` (line 33, named `ClockWithTick`)
- `/home/user/ai-trading-agent/src/trading/position-monitor.ts` (line 60, named `ClockWithTick`)
- `/home/user/ai-trading-agent/src/ingestion/market-data-sim.ts` (line 35, named `SimulatorClock`)
- `/home/user/ai-trading-agent/src/ingestion/vix-feed.ts` (line 38, named `VixClock`)

Five local type aliases for the same structural shape: `Clock & { tick(intervalMs: number, callback: () => void): void }`. They are structurally identical, but because they live in different files under different names, a reader cannot immediately see that they are the same contract, and a future change to the tick signature (e.g. adding a return value for deregistration) must be made in five places.

The comment in `straddle-calc.ts` explains the rationale ("avoids modifying the shared Clock interface for simulator-specific concerns"), but that rationale applies equally to a single exported type in `clock.ts`. The current approach is copy-paste, not structural sharing.

Recommendation: export one named type `ClockWithTick` from `/home/user/ai-trading-agent/src/utils/clock.ts` and import it wherever needed. `VixClock` and `SimulatorClock` can be type aliases of it or can be replaced by it directly — the shapes are identical.

---

**Angel One env-var naming mismatch between `.env.example` and code**

Files:
- `/home/user/ai-trading-agent/.env.example` (lines 45-48): documents `ANGEL_API_KEY`, `ANGEL_CLIENT_CODE`, `ANGEL_CLIENT_PIN`, `ANGEL_TOTP_SECRET`
- `/home/user/ai-trading-agent/src/ingestion/brokers/broker-factory.ts` (lines 131-140): reads `AO_API_KEY`, `AO_CLIENT_CODE`, `AO_CLIENT_PIN`, `AO_TOTP_SECRET`

An operator following `.env.example` to configure Angel One will set `ANGEL_*` variables; the code reads `AO_*`. The factory will fail with "missing env vars: AO_API_KEY, AO_CLIENT_CODE, AO_CLIENT_PIN, AO_TOTP_SECRET" — a confusing error when all four vars appear to be set under the wrong names.

Recommendation: Align `.env.example` to use `AO_` prefix to match the code, or rename the `process.env` reads to `ANGEL_`. The code names are the authoritative source; the example file should match.

---

**Duplicate JSON response schema for `paper_trades` rows between two route files**

Files:
- `/home/user/ai-trading-agent/src/api/routes/trades.ts` (`PAPER_TRADE_SCHEMA`, lines 20-54)
- `/home/user/ai-trading-agent/src/api/routes/paper-trades.ts` (`PAPER_TRADE_ITEM_SCHEMA`, lines 19-53)

The two schema objects are nearly identical (same 20 properties, same nullable types, same required list). They define the same wire shape for a `paper_trades` row. When a DB column is added or renamed, both files must be updated independently — one will inevitably drift out of sync, producing inconsistent API responses from `/api/trades` vs `/paper-trades`.

Recommendation: Extract a single shared `PAPER_TRADE_RESPONSE_SCHEMA` constant into a shared file (e.g. `src/api/schemas.ts`) and import it into both route files. This is the only duplicated schema in the codebase; the rest of the API uses distinct shapes.

---

**`EntryEngine` accepts `redis: Redis` but never stores or uses the injected client**

File: `/home/user/ai-trading-agent/src/trading/entry-engine.ts` lines 113-118

The constructor signature declares `redis: Redis` as a dependency but immediately discards it (acknowledged in the inline comment: "streamConsume uses the module-level singleton from src/redis/client.ts, not an injected client"). This means:

1. Tests cannot inject a mock Redis for the stream-consumer path. The comment says "callers that inject a test Redis client are intentionally NOT supported at the streamConsume level; that layer is tested separately" — but this is not a design choice, it is a limitation that is undisclosed to callers.
2. The interface implies dependency injection but does not honour it. A caller that constructs `new EntryEngine({ ..., redis: testRedis })` expecting isolation will be surprised.

Recommendation for Phase 2: either remove `redis` from the constructor signature and document that stream consumption uses the module-level singleton explicitly, or thread the injected client into `streamConsume` by passing it as a parameter. The latter is architecturally correct but requires a small refactor of `streamConsume` in `src/redis/client.ts` to accept a client argument.

---

**`lastFiredAt` field in `VirtualClock.TickEntry` is stored but not used in boundary comparison**

File: `/home/user/ai-trading-agent/src/utils/clock.ts` lines 84-151

`TickEntry.lastFiredAt` is set at registration time and updated on each firing, but the boundary computation in `advance()` reads `prev` (the clock's timestamp before the advance) rather than `entry.lastFiredAt`. This means `lastFiredAt` is effectively unused for its stated purpose. The comment says "Update lastFiredAt so the next advance() calculates from the right baseline" but the next `advance()` call uses the local `prev` variable (which equals `this._current` before the increment), not `entry.lastFiredAt`.

This does not produce incorrect behaviour because `prev` will always equal what `lastFiredAt` would have been — they track the same value. But the unused field adds noise, and the comment creates a false impression that the field participates in the calculation.

Recommendation: remove `lastFiredAt` from `TickEntry` and its update in `advance()`, or document clearly why it is kept (e.g. for future deregistration support). Do not leave a field that the code comments say is load-bearing when it is not.

---

**`VirtualClock` has no tick-deregistration API; stop guards are scattered across five classes**

Files: `straddle-calc.ts`, `position-monitor.ts`, `market-data-sim.ts`, `vix-feed.ts`, `entry-engine.ts`

Every class that registers a `clock.tick()` callback must keep its own `_running` or `_stopped` boolean and guard the callback body against firing after `stop()`. This is a known limitation acknowledged in comments, but it means the guard logic is duplicated in five places, and any new consumer of `clock.tick()` must remember to add its own guard.

This is a low-urgency issue for Phase 1 with one personality, but Phase 2 will add 10 personalities plus retrospection and signal components — each needing its own guard. The accumulated boilerplate becomes a maintenance risk.

Recommendation: add a `dispose(): () => void` return value to `VirtualClock.tick()` (a standard cleanup pattern). The returned function, when called, removes the entry from `this._ticks`. This does not break the existing pattern; callers that ignore the return value continue to work with their current guard flags. New Phase 2 components can use the returned disposer instead.

---

### 🟢 Low / Informational

**`.env.example` documents four env vars that are never read by the code**

File: `/home/user/ai-trading-agent/.env.example`

The following vars appear in `.env.example` but have no corresponding `process.env.*` reads in `src/`:
- `BROKER_FALLBACK` — no fallback-broker logic exists; the factory picks one adapter or the simulator.
- `ENTRY_TIME` — the code reads `ENTRY_START_TIME`, not `ENTRY_TIME`.
- `LOG_LEVEL` — Fastify/pino support this but no code reads it; Fastify picks up `LOG_LEVEL` automatically via environment only if explicitly wired.
- `STALE_FEED_THRESHOLD_MS` — the code hard-codes the default (30 000 ms) and reads it from the `PositionMonitorOptions.staleThresholdMs` option injected by `index.ts`, which does not read this env var.

These vars will silently do nothing if set by an operator. `ENTRY_TIME` vs `ENTRY_START_TIME` is the most dangerous — the entry window will not move even if the operator sets it.

Recommendation: remove undocumented/ghost vars from `.env.example`, or wire the actual `process.env` reads. At minimum add a comment to `STALE_FEED_THRESHOLD_MS` noting it is not currently wired.

---

**`VirtualClock.advance()` fires callbacks multiple times per call for large jumps, but component guards do not account for this**

File: `/home/user/ai-trading-agent/src/utils/clock.ts` lines 144-147

If `advance()` crosses N boundaries in one call, the registered callbacks fire N times synchronously. Components like `PositionMonitor` chain their handlers with `this._inFlight = handlerPromise.then(...)` specifically to serialise async work. But under a large advance that fires the watchdog 50 times in a tight loop, 50 watchdog fire-and-forget chains are queued simultaneously. Each one queries the DB and may call `closeTrade()`. If the first watchdog closes the trade and the remaining 49 each attempt to close the same already-closed trade, the executor's `closeTrade()` will throw "trade not found" 49 times.

In practice the smoke test advances in 60-second chunks to limit this (integration test line 235-242), but this is a workaround, not a fix.

Recommendation: document that large single-step advances are unsafe for async consumers, or add a guard in `PositionMonitor._runWatchdog()` that checks `status = 'open'` before attempting `closeTrade()`.

---

**Docker Compose does not declare `depends_on` for an app service**

File: `/home/user/ai-trading-agent/docker-compose.yml`

The compose file defines only infrastructure services (`postgres`, `redis`) — no `app` service. This is correct for the dev workflow (run infra in Docker, run the app locally with Bun). However, there is no `depends_on` guard, so if a future compose service is added for the app, it will need health-check dependencies added at that point. The current file is fine; this is a flag for the Phase 2 deployment story.

---

**Integration CI workflow runs on a nightly schedule rather than on every PR**

File: `/home/user/ai-trading-agent/.github/workflows/integration.yml`

Integration tests run Mon–Fri at 2 AM UTC, not on every pull request. This means a PR can break integration tests and the CI badge stays green until the nightly run. For a solo-operator research tool this is a reasonable tradeoff, but the design decision should be recorded explicitly.

---

**Frontend WebSocket message parsing expects `straddle_value` but server sends `straddleValue`**

Files:
- `/home/user/ai-trading-agent/frontend/src/hooks/useWebSocket.ts` line 41: checks `msg.straddle_value`
- `/home/user/ai-trading-agent/src/api/websocket.ts` line 107: the server sends the raw Redis fields verbatim; the straddle calculator publishes the field as `straddleValue` (camelCase, `straddle-calc.ts` line 194)

The WebSocket hook checks for `msg.straddle_value` (snake_case), but the stream payload field is `straddleValue` (camelCase). The dashboard will receive WebSocket messages but never detect a tick value and `addStraddleTick()` will never be called. The chart will appear empty during a live session.

Recommendation: update `useWebSocket.ts` to check `msg.fields?.straddleValue` (the actual nesting is `{ id, fields }` as serialised in `websocket.ts` line 106), or normalise the field name in the server's WebSocket handler before broadcasting.

---

**`QuantiplyClient.recordTrade(trade: unknown)` is too weak an interface**

File: `/home/user/ai-trading-agent/src/trading/quantiply-stub.ts` lines 27-29

The `trade` parameter is typed as `unknown`. This is acknowledged in the comment as a placeholder until the API shape is locked. For a stub this is fine, but both the interface and the stub should carry a `// TODO Phase 2` comment with the expected payload shape, so the Phase 2 implementor does not have to reverse-engineer what `trade` should look like from the call site.

---

**`StraddleChart` uses a fixed pixel width (800px)**

File: `/home/user/ai-trading-agent/frontend/src/components/StraddleChart.tsx` line 18

`createChart(containerRef.current, { width: 800, height: 300 })` uses a hardcoded pixel width. Lightweight Charts supports responsive sizing via `chart.resize()` and a `ResizeObserver`. On a narrow viewport (laptop in portrait, or a mobile device) the chart will overflow or be clipped.

This is cosmetic-only for a single-operator research tool, but worth fixing before any screen sharing or demo.

---

## Backend lens summary

The four-layer pipeline (ingestion → straddle calc → entry/exit signals → paper
trade execution) has clean module boundaries, no business logic in API routes, and
good injection patterns throughout. The main structural weakness is the unawaited
`broker.connect()` at startup (Critical) and the duplicated `ClockWithTick` type that
should live once in `clock.ts`. The `streamConsume` module-level singleton bypass
in `EntryEngine` is the one place where the injection pattern breaks down and needs
documentation or a fix before Phase 2 introduces parallel personalities.

## Infra lens summary

Docker Compose is correctly configured with healthchecks on both services, the
correct TimescaleDB image, and named volumes for data persistence. CI is split into
fast unit/lint checks on every push and nightly integration tests — appropriate for
a solo research project. The principal infra gap is the Angel One env-var naming
mismatch in `.env.example` (Medium), which would cause a confusing failure on first
live configuration, and four ghost env vars in the example file that silently do
nothing when set.
