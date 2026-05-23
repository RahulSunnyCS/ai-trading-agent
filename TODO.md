# TODO — Frontend wiring for the current workflow

> Mirror of `pipeline/tasks/T-XX.json`. Orchestrator-written, read-only for agents.
> Lane: feature-fast · Risk: LOW · Strictly frontend-only (no backend edits).
> Gate 1: APPROVED (option A — server consolidation deferred to a separate backend task).

## Status: Decomposed — awaiting confirmation to implement (Phase 2 → Phase 3)

| Task | Title | Depends on | Files |
|---|---|---|---|
| T-04 | Shared scaffolding (api helper, IST/number format, types) + tests | — | create: lib/api.ts, lib/format.ts, types/trading.ts, lib/__tests__/format.test.ts |
| T-01 | Live tab: WebSocket feed + polled straddle value | T-04 | create: hooks/useLiveTicks.ts · modify: components/LiveView.tsx |
| T-02 | Trades tab: poll /api/trades, trades table | T-04 | create: hooks/usePaperTrades.ts · modify: components/TradesView.tsx |
| T-03 | P&L tab: realized aggregates + cumulative chart | T-04, T-02 | create: lib/pnl.ts, lib/__tests__/pnl.test.ts · modify: components/PnlView.tsx |
| T-05 | Delete stale top-level frontend/ tree (R2) | — | delete: frontend/ |

### Implementation ordering (no shared file writes between parallel tasks)
1. **T-04** first (others import its lib/types — read-only consumers).
2. **T-01**, **T-02**, **T-05** in parallel after T-04 (T-05 has no dep, can start anytime).
3. **T-03** after T-02 (reuses usePaperTrades as the single trade-data source).

### Deferred / out of scope
- Server consolidation (mounting the complete `src/api` server, relocating payment routes) — separate BACKEND task, per Gate 1 decision A.
- No UI for personalities / retrospection / signals (no backend API exists yet).
