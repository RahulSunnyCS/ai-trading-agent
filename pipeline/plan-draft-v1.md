# Phase 1 Plan Draft — Live Paper Trading Platform

## Context
The AI Trading Agent backend is fully implemented: signal detection, 10-personality engine, 5-stage filters, paper trade execution, SL/TSL management, retrospection, and rule-based evolution. What does not exist is any visibility layer. There is no HTTP API, no WebSocket streaming, and no dashboard. The system runs entirely in the dark.

## What We Are Building

**Three new layers on top of the existing engine:**

### Layer 1: Fastify REST API
All endpoints return JSON. Zod validates every query param. pg parameterized queries throughout (already the codebase pattern). No authentication — local/LAN only.

Modules:
- `src/api/server.ts` — Fastify instance, CORS, health check
- `src/api/routes/personalities.ts` — GET /api/personalities, GET /api/personalities/:id
- `src/api/routes/trades.ts` — GET /api/trades (status?, personality_id?, date?, limit?), GET /api/trades/:id
- `src/api/routes/signals.ts` — GET /api/signals (underlying?, limit?, date?, min_probability?)
- `src/api/routes/straddle.ts` — GET /api/straddle/latest, GET /api/straddle/history
- `src/api/routes/retrospection.ts` — GET /api/retrospection (date?, personality_id?)
- `src/api/routes/evolution.ts` — GET /api/evolution/pending, POST /api/evolution/:id/approve, POST /api/evolution/:id/reject

### Layer 2: WebSocket Real-Time Streaming
- `src/api/ws/connection-manager.ts` — max 20 concurrent connections, ping/pong keepalive (30s timeout)
- `src/api/ws/broadcaster.ts` — broadcastSnapshot(), broadcastSignal(), broadcastTrade()
- Endpoint: ws://localhost:3000/ws/stream
- Message types: snapshot (every 15s during market hours), signal (on detection), trade_open, trade_close, system
- Trading loop integration: broadcaster called from computeAndSaveSnapshot() and trade executor/manager

### Layer 3: React + Vite Dashboard
- `frontend/` directory, separate from `src/`
- Vite + React + TypeScript + Tailwind CSS + Lightweight Charts + Zustand + TanStack Query
- Dev server on port 5173, proxying /api and /ws to port 3000
- Pages/panels:
  - System status header (LIVE/SIM mode, underlying, connection state, IST clock)
  - Straddle live chart (Lightweight Charts line chart, WebSocket updates, signal markers)
  - Personality P&L table (trades today, net P&L, beat-Clockwork delta, win rate — 30s polling)
  - Trade log (open + closed, filterable by personality/date/status)
  - Signal feed (real-time via WebSocket, confidence tier badges)
  - Evolution approval panel (pending suggestions with approve/reject)
- In production: Fastify serves frontend/dist/ as static files

### DB Migration
`src/db/migrations/003_evolution_approvals.sql` — new `evolution_approvals` table:
- id, personality_id, rule_id, parameter, current_value, proposed_value, rationale, regime
- requested_at, status (pending/approved/rejected/expired), reviewed_at
- The evolution engine checks this table before auto-applying high-impact rules when EVOLUTION_REQUIRE_APPROVAL=true

## Task Breakdown

| Task | Title | Scope |
|------|-------|-------|
| T-01 | Fastify server bootstrap | src/api/server.ts, src/api/index.ts, integrate into src/index.ts |
| T-02 | Personalities + Evolution API | routes/personalities.ts, routes/evolution.ts, 003 migration |
| T-03 | Trades + Signals + Data API | routes/trades.ts, routes/signals.ts, routes/straddle.ts, routes/retrospection.ts |
| T-04 | WebSocket streaming | ws/connection-manager.ts, ws/broadcaster.ts, trading loop integration |
| T-05 | Frontend scaffold | frontend/ Vite+React setup, bun scripts, proxy config |
| T-06 | API client + Zustand store | frontend/src/lib/api.ts, lib/ws.ts, store/trading.ts |
| T-07 | Dashboard layout | App.tsx, DashboardLayout.tsx, Header.tsx, DashboardPage.tsx |
| T-08 | Straddle chart panel | StraddleChart.tsx with Lightweight Charts + WebSocket live updates |
| T-09 | Personalities + Trade log | PersonalitiesTable.tsx, TradeLog.tsx |
| T-10 | Signal feed + Evolution panel | SignalFeed.tsx, EvolutionPanel.tsx |

## Architecture Decisions

1. **Same process:** Fastify server runs inside the same `main()` as the trading loop. Direct access to in-memory state (currentPrices, mode, underlying). No IPC needed. Fastify's error handler prevents route errors from crashing the trading loop.

2. **WebSocket cadence:** Snapshot messages only at 15s cadence during market hours. NOT raw ticks. Signal and trade events fire immediately when they occur. Message rate bounded at ~4/min + event-driven bursts.

3. **Evolution approval:** DB-backed `evolution_approvals` table. The evolution engine creates a row when a high-impact rule fires under EVOLUTION_REQUIRE_APPROVAL=true (instead of auto-applying). The API lists and processes these rows. Optimistic lock: UPDATE...WHERE status='pending' prevents double-apply.

4. **Frontend location:** `frontend/` at repo root. In dev: two processes (Bun trading engine + Vite dev server). In production: Fastify serves `frontend/dist/`.

5. **CORS:** @fastify/cors registered with allowed origins ['http://localhost:5173'] for dev. Production: same-origin (Fastify serves static files).

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| SQL injection via query params | Medium | High | Zod coerce on all params, no string interpolation in queries |
| WebSocket resource exhaustion | Low | Medium | 20-connection cap, 30s keepalive timeout, rate-bounded messages |
| Evolution approval race condition | Medium | Medium | DB status UPDATE...WHERE status='pending' optimistic lock |
| Clockwork mutation via evolution API | Low | Critical | Server-side is_frozen check, FrozenPersonalityError guard |
| Same-process API crash kills trading loop | Low | High | Fastify error handler, graceful shutdown coordination |
| No auth on API | High (by design) | Low (local tool) | CORS, documented as localhost-only |
| Frontend/Bun toolchain conflict | Low | Low | Vite runs independently as a bundler; no runtime overlap |
