# TODO — Frontend wiring for the current workflow

> Mirror of `pipeline/tasks/T-XX.json`. Orchestrator-written, read-only for agents.
> Lane: feature-fast · Risk: LOW · Strictly frontend-only (no backend edits).

## Status: Planning — awaiting Human Gate 1

High-level task list (decomposed into contracts after Gate 1 approval):

- [ ] **T-01 — LiveView**: WebSocket to running `/ws/ticks`, connection-status pill, live NIFTY index number, honestly-labeled synthetic sparkline, one-shot `/api/straddle/latest` fetch with "feed not yet connected" notice. New hook `useLiveTicks.ts`.
- [ ] **T-02 — TradesView**: poll `/api/trades`, normalize `{data}` envelope + empty case, null-safe NUMERIC parsing, trades table with IST times, status badge, sign-colored P&L, empty/error states. New hook `usePaperTrades.ts`.
- [ ] **T-03 — PnlView**: reuse `usePaperTrades`, compute realized P&L (closed trades only), today's P&L (IST), win rate, open/closed counts, cumulative-P&L line chart; empty/error states.
- [ ] **T-04 — Shared scaffolding**: fetch helper, IST/number-format utils, shared types in `src/frontend/types/`; Vitest unit tests for the pure parse/aggregate functions and a mock-WebSocket test for the hook.
- [ ] **T-05 — Delete stale frontend (R2)**: remove the unreferenced top-level `frontend/` tree (verified: no config or import references it). Frontend-only deletion.

### Decision pending at Gate 1
- R2 server consolidation: it is a BACKEND refactor (running `src/server/index.ts` also hosts payment/Fyers routes; the complete `src/api/server.ts` is the orphaned one). Conflicts with frontend-only constraint → propose deferring to a separate backend task.

### Out of scope this task
- No UI for personalities / retrospection / signals (no backend API exists for them).
