# Phase 1 Plan Draft v2 — Live Paper Trading Platform
# (Revised after Red Team Sprint 1)

## Summary of Sprint 1 Revisions

Valid criticisms incorporated:
1. **Bind API to 127.0.0.1** — explicit localhost bind, not 0.0.0.0, to defeat LAN exposure
2. **Origin/Host header allowlist** — defeat DNS-rebinding attacks on the evolution write path
3. **Approval goes through guard chain in a single transaction** — approve handler re-invokes frozen check, FROZEN_ATTRIBUTES check, comparison-integrity (>8pp) check from `evolution-rules.ts` inside one DB transaction that atomically flips `evolution_approvals.status='applied'` AND updates `personality_configs`; if guard throws, transaction rolls back
4. **Reconcile two approval paths** — the existing `requires_approval` branch inside `applyProposal()` is replaced by enqueue-into-`evolution_approvals`; there is now ONE apply path: the approval API
5. **WS broadcaster placement** — broadcaster is called from the two `setInterval` callers in `src/index.ts` AFTER `computeAndSaveSnapshot()` resolves (both live path at line ~128 and sim path at line ~153), never inside the persistence function; fire-and-forget with per-socket try/catch
6. **Both snapshot call sites wired** — explicit requirement that sim mode also emits WS events; regression test asserts WS events fire in sim mode
7. **Hard limit cap on /api/trades** — max 500, default 100, enforced server-side by Zod; date params interpreted as IST (UTC+5:30) consistently with market-hours.ts
8. **WS URL derived at runtime** — `frontend/src/lib/ws.ts` derives URL from `window.location` (protocol + host); no hardcoded port
9. **Optimistic lock is a full transaction** — `withTransaction()` wraps: status flip + guard chain execution + `personality_configs` UPDATE; any exception rolls back the entire set
10. **Shutdown updated** — `src/index.ts` `shutdown()` calls `app.close()` (drain HTTP connections) and terminates WS sockets before `closePool()`

Dismissed criticisms:
- "Split into separate process" — The single-researcher LAN scope does not need Redis pub/sub or IPC overhead. Same-process is correct; its risks are fully mitigated by error handler + Fastify isolation.
- "Add auth framework" — Explicitly out of scope for a local research tool. 127.0.0.1 binding + CORS + Origin/Host allowlist is the correct level of protection.

---

## What We Are Building

The trading engine runs and produces data — signals, trades, personality evolution — but is entirely opaque. This plan adds three observable layers:

### Layer 1: Fastify REST API
**New directory:** `src/api/`

- `server.ts` — Fastify instance, plugins, listen on `127.0.0.1:3000` (NOT 0.0.0.0)
- `index.ts` — exports `startApiServer()`, called from `src/index.ts` after `await runMigrations()`
- `middleware/origin-guard.ts` — onRequest hook checking Origin/Host header against allowlist; rejects non-localhost origins before any route handler executes (defeats DNS-rebinding)
- Shutdown: `shutdown()` in `src/index.ts` calls `app.close()` before `closePool()`

**Route modules with Zod validation:**
- `routes/personalities.ts` — `GET /api/personalities`, `GET /api/personalities/:id`
- `routes/trades.ts` — `GET /api/trades` (Zod: status?, personality_id?, date as IST?, limit 1–500 default 100), `GET /api/trades/:id`
- `routes/signals.ts` — `GET /api/signals` (Zod: underlying?, limit 1–200 default 50, date as IST?, min_probability 0–1?)
- `routes/straddle.ts` — `GET /api/straddle/latest`, `GET /api/straddle/history` (Zod: underlying required, expiry?, from IST?, to IST?, limit 1–500 default 200)
- `routes/retrospection.ts` — `GET /api/retrospection` (Zod: date as IST?, personality_id?)
- `routes/evolution.ts` — `GET /api/evolution/pending`, `POST /api/evolution/:id/approve`, `POST /api/evolution/:id/reject`
  - Approve handler: `withTransaction()` wrapping: (1) SELECT...FOR UPDATE on evolution_approvals row, (2) validate status='pending', (3) re-run guard chain from evolution-rules.ts (frozen check, FROZEN_ATTRIBUTES, comparison-integrity), (4) UPDATE personality_configs, (5) UPDATE evolution_approvals status='applied'; any throw rolls back
  - Reject handler: `withTransaction()` flips status='rejected' with optional reason

**System endpoints:**
- `GET /health` — 200 OK
- `GET /api/status` — mode (live/sim), underlying, uptime, connection count

### Layer 2: WebSocket Real-Time Streaming
**New directory:** `src/api/ws/`

- `connection-manager.ts` — tracks active WS connections, max 20 cap (new connections above cap receive 503 close frame), 30s ping/pong keepalive (dead sockets cleaned up)
- `broadcaster.ts` — exports `broadcastSnapshot()`, `broadcastSignal()`, `broadcastTrade(type, trade)`; all fire-and-forget; per-socket send wrapped in try/catch; backed by a bounded per-socket send queue (max 20 queued messages — oldest dropped if exceeded)

**Integration in `src/index.ts` (explicit call sites):**
- Live path snapshot interval (~line 128): after `await computeAndSaveSnapshot(...)` resolves, call `broadcastSnapshot(snapshotData)`
- Sim path snapshot interval (~line 153): after `await computeAndSaveSnapshot(...)` resolves, call `broadcastSnapshot(snapshotData)` — BOTH call sites required
- `executeSignalEntry()` in trade-executor.ts: after successful INSERT, call `broadcastSignal(signalData)`
- `openTrade()` in trade-executor.ts: after INSERT, call `broadcastTrade('trade_open', tradeData)`
- `closeTrade()` in trade-manager.ts: after UPDATE, call `broadcastTrade('trade_close', tradeData)`

**Message schema (TypeScript interface in `src/api/ws/types.ts`):**
```typescript
type WsMessage =
  | { type: 'snapshot'; payload: SnapshotPayload }
  | { type: 'signal'; payload: SignalPayload }
  | { type: 'trade_open'; payload: TradePayload }
  | { type: 'trade_close'; payload: TradePayload }
  | { type: 'system'; payload: { status: string; mode: string } }
```

**Endpoint:** `ws://localhost:3000/ws/stream`

### Layer 3: React + Vite Dashboard
**New directory:** `frontend/`

**Setup:**
- `frontend/package.json` — Vite + React + TypeScript + Tailwind + Lightweight Charts + Zustand + @tanstack/react-query
- `frontend/vite.config.ts` — dev server proxy: `/api` → `http://localhost:3000`, `/ws` → `ws://localhost:3000`
- Root `package.json` scripts: `"frontend:dev"`, `"frontend:build"`, `"frontend:preview"`

**API client:**
- `frontend/src/lib/api.ts` — typed Axios client for all REST endpoints
- `frontend/src/lib/ws.ts` — WebSocket client with exponential backoff reconnect (1s, 2s, 4s, 8s, max 30s); URL derived from `window.location.protocol === 'https:' ? 'wss:' : 'ws:' + '//' + window.location.host + '/ws/stream'`

**State:**
- `frontend/src/store/trading.ts` — Zustand store with personalities, openTrades, recentSignals, straddleHistory, connectionStatus
- TanStack Query for all REST fetches (30s stale time for personality/trade data)

**Pages and components:**
- `App.tsx` + `DashboardLayout.tsx` — header with LIVE/SIM badge, IST clock, connection indicator; responsive Tailwind grid
- `StraddleChart.tsx` — Lightweight Charts line chart; WebSocket snapshot events appended as new points; signal markers overlaid with confidence-tier colours
- `PersonalitiesTable.tsx` — per-personality row: trades today, net P&L (₹), beat-Clockwork delta, win rate; refreshes every 30s via TanStack Query
- `TradeLog.tsx` — open + closed trades table; filters by personality/date/status; virtual scroll for long lists
- `SignalFeed.tsx` — real-time signal cards from WebSocket; HIGH/MEDIUM/LOW tier badges; last 20 signals
- `EvolutionPanel.tsx` — pending approval cards; approve/reject buttons; mutation via Axios POST with TanStack Query cache invalidation

**Production serving:**
- Fastify serves `frontend/dist/` as static files via `@fastify/static`
- Single deployment: `bun start` starts both trading engine and Fastify serving the built dashboard

### DB Migration
`src/db/migrations/003_evolution_approvals.sql`

```sql
CREATE TABLE IF NOT EXISTS evolution_approvals (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  personality_id  UUID        REFERENCES personality_configs(id),
  rule_id         TEXT        NOT NULL,
  parameter       TEXT        NOT NULL,
  current_value   NUMERIC,
  proposed_value  NUMERIC,
  rationale       TEXT,
  regime          TEXT,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status          TEXT        NOT NULL DEFAULT 'pending'  -- pending|applied|rejected|expired
    CHECK (status IN ('pending','applied','rejected','expired')),
  reviewed_at     TIMESTAMPTZ,
  review_reason   TEXT
);
CREATE INDEX IF NOT EXISTS idx_evolution_approvals_pending
  ON evolution_approvals (personality_id) WHERE status = 'pending';
```

**Evolution engine change:** In `evolution-rules.ts`, the `applyProposal()` branch `if (requires_approval)` is replaced by an INSERT into `evolution_approvals` with status='pending'. The `applyEvolutionRules()` function only executes the config UPDATE for proposals NOT requiring approval. The single apply path for approval-required proposals is now the `POST /api/evolution/:id/approve` handler.

## Task Breakdown (unchanged from v1 with refined scope per revision)

| Task | Title | Key scope additions from v2 |
|------|-------|----------------------------|
| T-01 | Fastify server bootstrap | 127.0.0.1 bind, origin-guard middleware, shutdown drain |
| T-02 | Personalities + Evolution API | withTransaction approve, guard chain re-invocation, reconcile applyProposal |
| T-03 | Trades + Signals + Data API | IST-consistent date parsing, hard limit caps |
| T-04 | WebSocket streaming | Both live+sim call sites, fire-and-forget, bounded send queue |
| T-05 | Frontend scaffold | Vite setup, prod static serving via @fastify/static |
| T-06 | API client + Zustand store | Runtime WS URL derivation, reconnect backoff |
| T-07 | Dashboard layout | System status header, LIVE/SIM badge |
| T-08 | Straddle chart panel | Lightweight Charts + WebSocket updates + signal markers |
| T-09 | Personalities + Trade log | 30s polling, virtual scroll |
| T-10 | Signal feed + Evolution panel | TanStack Query cache invalidation on approve/reject |

## Risk Register (updated)

| Risk | Likelihood | Impact | Mitigation (v2) |
|------|-----------|--------|-----------------|
| DNS-rebinding → evolution mutation | Low | Critical | 127.0.0.1 bind + Origin/Host allowlist middleware |
| Double-apply of evolution proposal | Low | High | Single withTransaction: status flip + guard chain + config update |
| Guard chain bypassed on approve | Low | Critical | approve handler re-runs frozen/FROZEN_ATTRS/comparison-integrity checks |
| WS broadcaster stalls persistence | Low | High | Broadcaster called after persistence resolves, fire-and-forget |
| Sim mode emits no WS events | High (without fix) | Medium | Explicit both-call-site requirement + sim smoke test |
| /api/trades unbounded response | Medium | Medium | Zod: max 500, default 100; IST date parsing |
| Hardcoded WS URL breaks in prod | High (without fix) | Medium | Runtime window.location derivation |
| Incomplete optimistic lock | Medium | High | withTransaction atomically covers both table flip and config update |
| Same-process API crash | Low | High | Fastify setErrorHandler, no-throw-escapes, no impact on trading intervals |
| No auth on write paths | By design | Accepted | 127.0.0.1 + Origin/Host allowlist adequate for single-researcher LAN tool |
