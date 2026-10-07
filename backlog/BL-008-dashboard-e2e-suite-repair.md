# BL-008 — Repair the stale dashboard e2e suite and run it in CI

| | |
|---|---|
| **Priority** | P2 — a suite where most tests always fail hides real regressions |
| **Status** | Planned |
| **Type** | chore |
| **Area** | dashboard (+ infra for CI) |
| **Created** | 2026-10-05 |
| **Depends on** | none |
| **TODO.md row** | — (filled in when started) |

## Context

Running `apps/dashboard/e2e` (Playwright, APIs mocked with `page.route`) against a production
build on 2026-10-04 gave **~30 of 44 tests failing, on `main` as well as with the
`c04ec51` change**. A side-by-side run of both builds, repeated 3× on one worker, showed
identical results apart from three P&L tests. Those three had been passing **only by
accident**: their helper waited on a "P&L Summary" card that only shows while loading, so
they passed when the check landed mid-load. `c04ec51` fixed that helper.

Failing groups:

- `live-view.spec.ts` / `navigation.spec.ts`: expect a "NIFTY Index" heading and a
  `[role="status"][aria-label^="WebSocket status"]` pill. The Live view no longer renders
  either.
- `trades-view.spec.ts`: strict-mode violations. `getByText('Open')` and a `/45/` cell matcher
  each resolve to two elements.
- `pnl-view.spec.ts`: five tests failing on assertions about the current layout.
- `personalities-api.spec.ts`: nine API tests that need a running Fastify server and
  database. They are integration tests, not UI tests.

Infrastructure gaps:

- CI does not run the e2e suite at all (`.github/workflows/ci.yml` has no Playwright job),
  which is how it went stale.
- `playwright.config.ts` still documents a "Vite dev server at :5173".
- It cannot run against a production build: that needs `DASHBOARD_PASSWORD` plus
  `httpCredentials` (the 2026-10-04 run used a scratch-only config to add them).

## Goal

The suite is green against a production build, locally and in CI. Tests that need a real
backend are separated and skip with a clear reason when it is absent.

## Out of scope

- New coverage beyond fixing what exists, except where a stale test is replaced by its
  current equivalent.

## Plan

### Phase 1 — Triage
- **Tasks:** for each failing test, decide whether the test is stale or the app has a bug.
  Move selectors to roles or `data-testid`s that survive copy changes.
- **Deliverables:** a short table in this item (test → stale/bug → fix).
- **Done when:** every UI test passes against a production build, or has a linked bug.

### Phase 2 — Separate the backend-dependent tests
- **Tasks:** move `personalities-api.spec.ts` into an integration project gated on the server
  (`test.skip` with a reason when `/health` is unreachable).
- **Done when:** the default `bun run test:e2e` has no failures caused by a missing server.

### Phase 3 — CI
- **Tasks:** let `playwright.config.ts` read `DASHBOARD_PASSWORD` into `httpCredentials` from
  env. Add a CI job: `next build` → `next start` with a generated password → `playwright
  test`. Fix the stale config comments.
- **Done when:** the job runs on every PR and is green.

## Risks

- A flaky test blocking CI: keep the retry at 1 in CI (already configured), and quarantine
  rather than delete.

## Open questions

- Should the Live/Trades/P&L tabs, which need the Fastify server, stay in the default suite
  with mocks, or move with the integration tests?

## Log

- 2026-10-05 — created from the Momentum UI performance review (2026-10-04 session).
- 2026-10-07 — `personalities-api.spec.ts` calls `/personalities/...` (the routes are
  `/api/personalities/...`) and the production server mounts only `GET /api/personalities`, so
  it cannot pass against any process. Seven of its nine cases were already in the server's
  Vitest integration tests; the 8pp comparison-integrity 409 is now ported too
  (`personalities-api.integration.test.ts`). The 400 range-check case was not ported: the PUT
  route does not bound `min_probability` at all. Deleting the spec (instead of Phase 2's move)
  is the owner's call.
