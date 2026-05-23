# Pipeline Progress

**Task:** Create relevant frontend changes for the current workflow (wire dashboard tabs to the running backend).
**Branch:** claude/sweet-wright-ORLM0
**Lane:** feature-fast | **Risk:** LOW | **Sprints:** 1 | **Effort:** medium (default)
**Recommendation rounds used:** 1 (R2 accepted)

## Resolved decisions
- Live straddle value: use continuous polling (auto-updates when backend goes live) — user confirmed.
- R2 accepted: delete the stale top-level `frontend/` tree (verified unreferenced; frontend-only, safe).
- R2 server-consolidation portion: DEFERRED — it is a backend refactor that conflicts with the
  strictly-frontend-only constraint and touches payment routes. Surfaced as a decision at Gate 1.

## User constraints (locked at clarification)
- Scope: surface "whatever is completed in the backend, only needing a frontend change."
- **Strictly frontend-only** — zero backend files may be modified.
- Duplicate handling: orchestrator's decision → leave stale `frontend/` tree and orphaned `src/api` server in place; flag, do not remove.

## Phase status
- [x] Phase 0 — Triage (risk_manifest.json written)
- [x] Phase 1 — APPROVED at Gate 1 (option A: defer server consolidation)
- [~] Phase 2 — Decomposition done (T-01..T-05 contracts written); awaiting "proceed with implementation"
  - Internal score ~8.5/10 (>8 → no extra sprint, per feature-fast = 1 sprint)
  - Red Team fixes accepted: running WS shape; realized-only P&L; synthetic labeling on chart; one-shot straddle fetch; StrictMode-safe + backoff reconnect; null-safe NUMERIC coercion; IST-explicit dates.
  - QA checklist: 16 Critical / 17 Functional / 9 Non-blocker (42 total). File: pipeline/qa-checklist.md
- [ ] Phase 2 — Decomposition
- [ ] Phase 3 — Implementation
- [ ] Phase 4 — Architecture review (LOW → architecture only) → Human Gate 2
- [ ] Phase 5 — Tests + Docs + E2E
- [ ] Phase 6 — Test execution + Automation Gate
- [ ] Phase 7 — Final review + epic doc → Human Gate 3

## Key technical finding (surfaced per General Rule 4)
The production-running server (`src/server/index.ts`) serves mostly STUBS:
`/api/straddle/latest`→null, `/api/positions`→[], `/ws/ticks`→synthetic random ticks.
Only `/api/trades` returns real DB rows (shape `{ data: PaperTrade[] }`).
A complete real-data server (`src/api/server.ts`) exists and is tested but is NOT mounted
at runtime. User chose strictly-frontend-only, so the FE wires to the running (partly-stub)
endpoints and degrades gracefully; it will light up automatically once the backend is mounted.
