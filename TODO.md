# TODO — Live Paper Trading Platform

> Generated from pipeline/tasks/ by the Lead Orchestrator. Do not edit manually.
> Status: Phase 1 Planning — awaiting Human Gate 1 approval.

## Backend (API + WebSocket)
- [ ] T-01 · Fastify server bootstrap, origin-guard middleware, lifecycle + shutdown
- [ ] T-02 · evolution-guard.ts + Evolution REST API (approve/reject + auto-apply rewrite + migration 003)
- [ ] T-03 · Trades, signals, straddle, retrospection REST endpoints (Zod + IST date helpers)
- [ ] T-04 · WebSocket connection manager + priority broadcaster (live + sim both wired)

## Frontend (React Dashboard)
- [ ] T-05 · Vite + React + Tailwind frontend scaffold (build tooling + dev proxy)
- [ ] T-06 · Typed API client + WebSocket Zustand store + reconnect hook
- [ ] T-07 · Dashboard layout + 10-personality comparison grid (primary view)
- [ ] T-08 · Live straddle chart (Lightweight Charts, REST seed, WS deltas, signal markers)
- [ ] T-09 · Trade log (filters, WS cache invalidation) + signal feed
- [ ] T-10 · Evolution approval panel (approve/reject, 409/400 handling)
