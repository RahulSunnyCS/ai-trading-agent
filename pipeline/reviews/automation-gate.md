# Automation Gate — Result: CI-ONLY

**Date:** 2026-05-25
**Classifier:** orchestrator (Haiku-tier classification step)

## Outcome: CI-ONLY (non-blocking)

Per the Automation Gate rules in CLAUDE.md: when the dev server cannot start
(here: no Docker daemon in the execution environment → TimescaleDB + Redis are
unavailable, so the Fastify dev server and Playwright cannot run against live
data), the gate is marked **CI-ONLY** and does not block Gate 2/Gate 3.

- `bun test` (unit) — **PASS**, 1144 tests green (run in this environment; no
  services required).
- `bun run test:integration` — **CI-ONLY**: requires Docker services. Not run
  here.
- `npm run test:e2e` (Playwright) — **CI-ONLY**: requires the dev server +
  seeded TimescaleDB/Redis. Not run here.
  - Specs validated to compile/list cleanly: `npx playwright test --list` →
    **82 tests in 10 files**, no parse/import errors.
  - New M5 specs (this branch): dashboard-m5, multi-index-pipeline,
    observability, personalities-dashboard, sr-engine.
  - Tag distribution across the 5 new M5 specs: 45 @critical · 20 @functional
    · 39 @non-blocker.

## Action required (outside this environment)

Run in CI (or locally with `docker compose up -d` first):
```
bun run test:integration
npm run test:e2e
```
The @critical-tagged E2E tests must pass in CI before merge. They could not be
executed here only because the environment has no container runtime — this is
an environment limitation, not a test result.
