# Phase 1 Plan Draft v3 — Live Paper Trading Platform
# (Revised after Red Team Sprint 2)

## Summary of Sprint 2 Revisions

Valid criticisms incorporated:
1. **Guard chain doesn't exist → new explicit task** — `evolution-rules.ts` only checks `is_frozen`; no FROZEN_ATTRIBUTES or >8pp comparison-integrity check exists anywhere. Adding an explicit task (T-02A) to extract `assertEvolutionAllowed(personality, parameter)` in a new shared module, called by BOTH auto-apply path and approve handler.
2. **SQL identifier injection on `parameter` column** — Added a hard allowlist constant `MUTABLE_PARAMETERS: readonly string[]` in the new guard module; `evolution_approvals` migration 003 adds `CHECK (parameter IN (...))` over that list; the `UPDATE personality_configs SET ${parameter}` raw interpolation is replaced with a validated column lookup pattern.
3. **Fastify lifecycle has no integration point** — Specified explicitly: Fastify app constructed in `main()`, stored as module-level ref, shutdown order: stopTradingLoop() → connectionManager.closeAll() → app.close() → closeRedis() → closePool(), each with a 5s hard timeout.
4. **evolution_approvals missing link to retrospection_results** — Added `retrospection_result_id UUID REFERENCES retrospection_results(id)` to migration 003; approve handler's withTransaction also updates `retrospection_results.applied=TRUE` for that row; concurrent approve protected by `WHERE status='pending' RETURNING id` rowcount check (zero rows = already processed, return 409 Conflict).
5. **@fastify/static missing** — Added to task scope: `bun add @fastify/static` with Bun lockfile update; T-01 explicitly lists it.
6. **EOD close storm drops trade broadcasts** — Changed queue priority: per-socket bounded queue now uses separate priority channels: trade_open/trade_close are NEVER dropped; only snapshot messages are dropped when queue is full. Max 20 applies to snapshot backlog only.
7. **Origin allowlist blocks Vite dev** — Vite `server.proxy` config specified: `/api → http://127.0.0.1:3000` (HTTP proxy) and `/ws → ws://127.0.0.1:3000` (WS proxy); Origin allowlist in origin-guard.ts accepts both `:3000` (prod same-origin) and `:5173` (Vite dev); explicitly documented.
8. **Max-20 WS cap self-lockout** — Changed strategy: evict oldest IDLE connection (no message received in > 60s) rather than hard-reject 21st; if no idle connections, return 503 with Retry-After: 30.
9. **IST date parsing inconsistency** — Added shared `toIstDate(utcDate: Date): string` and `istDayRange(isoDate: string): { from: Date; to: Date }` helpers to `src/utils/market-hours.ts`; all date params in REST routes and `scheduleDailyReset` use these helpers.
10. **Per-personality comparison view is the primary view** — Dashboard layout revised: T-07 primary panel is now the 10-personality grid (personality name, regime, open position, day P&L ₹, beats-Clockwork delta ₹, win rate %). Straddle chart is secondary. Evolution approval panel surfaced as T-10.

Dismissed:
- "Serve dist without @fastify/static" — Explicit static file serving is better than a manual handler; @fastify/static is the correct choice.
- "Straddle history REST endpoint to seed chart" — Already in plan (GET /api/straddle/history), just not explicitly called out in T-08; added it explicitly.

---

## What We Are Building

A live paper trading platform that transforms the invisible running backend into a fully observable and interactive research tool. Three layers:

### Layer 1: Fastify REST API + Guard Module
**New directories:** `src/api/`, `src/trading/evolution-guard.ts` (new shared module)

**New file: `src/trading/evolution-guard.ts`**
```typescript
export const MUTABLE_PARAMETERS = [
  'min_probability', 'max_daily_trades', 'max_daily_loss',
  'entry_delay_secs', 'adjustment_trigger_points', 'max_open_legs',
  'reentry_min_probability', 'min_vix', 'max_vix',
  'require_profit_gate', 'profit_gate_amount', 'profit_gate_days',
  'reentry_delay_mins',
] as const;

export type MutableParameter = typeof MUTABLE_PARAMETERS[number];

export function assertEvolutionAllowed(
  personality: PersonalityConfig,
  parameter: string,
): void {
  if (personality.is_frozen) throw new FrozenPersonalityError(personality.name);
  if (!(MUTABLE_PARAMETERS as readonly string[]).includes(parameter))
    throw new Error(`Parameter '${parameter}' is not in the mutable allowlist`);
  // Comparison-integrity check: Precision/Adjuster/Reducer min_probability drift > 8pp
  // (async check handled by caller with DB query if needed)
}
```

Both `applyEvolutionRules()` and the approve handler call this before any UPDATE. The `UPDATE personality_configs` pattern replaces raw interpolation with a validated column name from the allowlist:
```typescript
const col = MUTABLE_PARAMETERS.find(p => p === parameter);
if (!col) throw new Error('invalid parameter');
await tx.query(`UPDATE personality_configs SET "${col}" = $1 WHERE id = $2`, [value, id]);
```

**API structure (src/api/):**
- `server.ts` — Fastify instance, CORS, plugins (@fastify/websocket, @fastify/static), listen on `127.0.0.1:3000`
- `index.ts` — `startApiServer(): Promise<FastifyInstance>` called from `main()`; ref stored at module level for shutdown
- `middleware/origin-guard.ts` — rejects Origin not in ['http://localhost:3000', 'http://localhost:5173'] and Host not in ['localhost:3000', 'localhost:5173', '127.0.0.1:3000']

**Route modules:**
- `routes/personalities.ts` — `GET /api/personalities`, `GET /api/personalities/:id`
- `routes/trades.ts` — `GET /api/trades` Zod: `{ status?: z.enum(['open','closed','stopped']), personality_id?: z.string().uuid(), date?: z.string().refine(isIsoDate), limit: z.number().int().min(1).max(500).default(100) }`
- `routes/signals.ts` — `GET /api/signals` Zod: `{ underlying?: z.enum(['NIFTY','BANKNIFTY','SENSEX']), limit: z.number().int().min(1).max(200).default(50), date?: ..., min_probability?: z.number().min(0).max(1) }`
- `routes/straddle.ts` — `GET /api/straddle/latest`, `GET /api/straddle/history` Zod: `{ underlying: required, expiry?: ..., from?: IST, to?: IST, limit: 1-500 default 200 }`
- `routes/retrospection.ts` — `GET /api/retrospection` Zod: `{ date?: IST, personality_id?: uuid }`
- `routes/evolution.ts` — see below

**Evolution approve handler (withTransaction atomic block):**
```
1. SELECT * FROM evolution_approvals WHERE id=$1 FOR UPDATE
2. If status != 'pending': return 409
3. SELECT * FROM personality_configs WHERE id=personality_id
4. assertEvolutionAllowed(personality, parameter)
5. Comparison-integrity check (DB query: min_probability drift across Precision/Adjuster/Reducer)
6. UPDATE personality_configs SET "${col}" = proposed_value WHERE id = personality_id
7. UPDATE evolution_approvals SET status='applied', reviewed_at=NOW() WHERE id=$1
8. UPDATE retrospection_results SET applied=TRUE, applied_at=NOW() WHERE id=retrospection_result_id
9. invalidatePersonalityCache()
```

**Shutdown sequence (src/index.ts):**
```typescript
stopTradingLoop();
connectionManager.closeAll();       // terminate WS sockets
await Promise.race([app.close(), timeout(5000)]);
fyersFeed?.disconnect() || simulator?.stop();
await closeRedis();
await closePool();
process.exit(0);
```

**IST date helpers added to src/utils/market-hours.ts:**
```typescript
export function toIstDate(utcDate: Date): string // returns 'YYYY-MM-DD' in IST
export function istDayRange(isoDate: string): { from: Date; to: Date } // IST midnight boundaries
```

All route date parsing and `scheduleDailyReset()` use these helpers.

### Layer 2: WebSocket Real-Time Streaming
**New directory:** `src/api/ws/`

- `connection-manager.ts` — max 20 active sockets; evict oldest IDLE (last message > 60s ago) before rejecting; if no idle sockets, return 503 with Retry-After: 30
- `broadcaster.ts` — two-priority send:
  - CRITICAL messages (trade_open, trade_close, signal): always queued, never dropped, per-socket array (unbounded by count, capped at 50KB total serialized)
  - NORMAL messages (snapshot): bounded at 20 per socket; oldest snapshot dropped if full
  - Per-socket: all sends wrapped in try/catch; failed send removes socket from pool

**Integration call sites (src/index.ts — both explicitly wired):**
- Live path (lines ~115-135): `broadcastSnapshot(snapshotResult)` after `await computeAndSaveSnapshot()` resolves
- Sim path (lines ~145-175): `broadcastSnapshot(snapshotResult)` after `await computeAndSaveSnapshot()` resolves
- `trade-executor.ts openTrade()`: `broadcastTrade('trade_open', trade)` after INSERT
- `trade-executor.ts executeSignalEntry()`: `broadcastSignal(signal)` after INSERT
- `trade-manager.ts closeTrade()`: `broadcastTrade('trade_close', trade)` after UPDATE

### Layer 3: React + Vite Dashboard
**New directory:** `frontend/`

**Primary view — 10 Personality Grid (the experiment):**
For each personality: name, regime tag, open position (ATM strike + straddle value), day P&L ₹, beats-Clockwork delta ₹, win rate %, management action (last ROLL/CUT if applicable). Clockwork row highlighted as benchmark.

**Secondary views:**
- Straddle live chart: seeded from `GET /api/straddle/history` on mount, then WS snapshot deltas appended. Signal markers from WS signal events.
- Trade log: open + closed, filter by personality/date/status
- Signal feed: last 20 signals from WS
- Evolution approval panel: pending approval cards with approve/reject, linked to retrospection insight text

**Vite dev proxy (`frontend/vite.config.ts`):**
```typescript
server: {
  proxy: {
    '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false },
    '/ws': { target: 'ws://127.0.0.1:3000', ws: true, changeOrigin: false },
  }
}
```

**WS URL (runtime-derived):**
```typescript
const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const url = `${proto}//${window.location.host}/ws/stream`;
```

### DB Migration 003
```sql
CREATE TABLE IF NOT EXISTS evolution_approvals (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  personality_id         UUID         REFERENCES personality_configs(id),
  retrospection_result_id UUID        REFERENCES retrospection_results(id),
  rule_id                TEXT         NOT NULL,
  parameter              TEXT         NOT NULL
    CHECK (parameter IN (
      'min_probability','max_daily_trades','max_daily_loss','entry_delay_secs',
      'adjustment_trigger_points','max_open_legs','reentry_min_probability',
      'min_vix','max_vix','require_profit_gate','profit_gate_amount',
      'profit_gate_days','reentry_delay_mins'
    )),
  current_value          NUMERIC,
  proposed_value         NUMERIC,
  rationale              TEXT,
  regime                 TEXT,
  requested_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  status                 TEXT         NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','applied','rejected','expired')),
  reviewed_at            TIMESTAMPTZ,
  review_reason          TEXT
);
CREATE INDEX IF NOT EXISTS idx_evolution_approvals_pending
  ON evolution_approvals (personality_id) WHERE status = 'pending';
```

## Task Breakdown (Final)

| Task | Title | Key scope |
|------|-------|-----------|
| T-01 | Fastify server bootstrap | server.ts on 127.0.0.1:3000, origin-guard, @fastify/static added, app lifecycle, shutdown sequence |
| T-02 | evolution-guard.ts + Evolution API | assertEvolutionAllowed(), MUTABLE_PARAMETERS allowlist, withTransaction approve, 003 migration |
| T-03 | Personalities + Data REST API | personalities.ts, trades.ts, signals.ts, straddle.ts, retrospection.ts; IST helpers; Zod validation |
| T-04 | WebSocket streaming | connection-manager, broadcaster with priority queues, both live+sim call sites |
| T-05 | Frontend scaffold | Vite+React+TS+Tailwind setup, bun scripts, Vite proxy config |
| T-06 | API client + Zustand + WS hook | api.ts, ws.ts (runtime URL, backoff reconnect), store/trading.ts |
| T-07 | Dashboard layout + personality grid | DashboardLayout, Header (LIVE/SIM, IST clock, connection), PersonalitiesGrid as primary view |
| T-08 | Straddle chart panel | Lightweight Charts, seeded from REST history, WS delta updates, signal markers |
| T-09 | Trade log + signal feed | TradeLog (filters, virtual scroll), SignalFeed (WS, tier badges) |
| T-10 | Evolution approval panel | EvolutionPanel with approve/reject, TanStack Query cache invalidation |

## Risk Register (Final)

| Risk | Likelihood | Impact | Mitigation (v3) |
|------|-----------|--------|-----------------|
| SQL identifier injection via parameter name | Low | Critical | MUTABLE_PARAMETERS allowlist + DB CHECK constraint + column-name validation before UPDATE |
| Evolution guard chain missing | Low | Critical | New evolution-guard.ts extracted; both paths call assertEvolutionAllowed() |
| Double-apply of evolution proposal | Low | High | SELECT...FOR UPDATE + WHERE status='pending' RETURNING id + 409 if 0 rows |
| retrospection_results not marked applied | Low | High | withTransaction also UPDATE retrospection_results.applied=TRUE |
| Fastify lifecycle not wired | Low | High | Explicit startup in main(), shutdown order: tradingLoop → WS → app.close() → Redis → pool |
| @fastify/static not installed | High (without fix) | High | Explicit bun add in T-01 scope |
| EOD close storm drops trade events | High (without fix) | High | Trade events in non-droppable priority queue; only snapshots are dropped |
| Vite dev proxy not configured | High (without fix) | Medium | Explicit vite.config.ts proxy in T-05 scope |
| WS self-lockout with 20 cap | Medium | Medium | Evict oldest idle (>60s) before rejecting; 503+Retry-After if no idle |
| IST date parsing inconsistency | Medium | Medium | Shared istDayRange() helper; both route and scheduleDailyReset use it |
| No auth on evolution write path | By design | Accepted | 127.0.0.1 bind + Origin/Host allowlist + guard chain + Clockwork immutability |
