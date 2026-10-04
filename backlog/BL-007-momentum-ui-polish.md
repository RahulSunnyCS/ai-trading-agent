# BL-007 — Momentum UI polish from the 2026-10-04 review

| | |
|---|---|
| **Priority** | P3 — small, independent fixes; none blocks research |
| **Status** | Planned |
| **Type** | improvement |
| **Area** | dashboard |
| **Created** | 2026-10-05 |
| **Depends on** | none |
| **TODO.md row** | — (filled in when started) |

## Context

Found while walking every Momentum page in Playwright, at desktop and phone widths
(production build, 2026-10-04). Each item is small and can ship alone.

1. **A finished result disappears on reload.** `store/momentumRuns.ts` persists only in-flight
   runs to localStorage. A finished run is auto-saved server-side as a saved run, but after a
   refresh the Backtest page comes back empty, and the run cannot be reopened as a full
   result (saved runs keep only the config, KPIs and the equity series).
2. **Wrong Saved-runs count on Rebalance.** The "Saved runs (N)" section tab counts the
   Backtest dataset's runs (ETF by default) while Rebalance works on Broad.
3. **Weekly signal is wider than a phone.** At 390 px the page lays out at 533 px, so the
   browser zooms out. Some row in the view has a min-width. Separately, the section tab bar
   scrolls but cuts off the active tab ("Week…"), and does not scroll it into view.
4. **A noisy 500 on every page in the research stack.** The shell asks `/api/meta` (Fastify),
   which is not running under `bun run start`. The console shows a failed request on every
   load; it should read as "server offline" quietly.
5. **The Plotly mode bar is always visible** on the equity chart, cluttering it. Show it on
   hover only.

## Goal

Each item fixed or explicitly dropped (with the reason recorded in the log).

## Out of scope

- Anything that changes results or the API contract.

## Plan

### Phase 1 — Quick fixes (items 2, 4, 5)
- **Tasks:** label the count with its dataset, or hide it outside Backtest/Saved. Treat a
  `/api/meta` failure in `MOMENTUM_DIRECT` mode as "server offline" with no console noise.
  Set Plotly `displayModeBar: 'hover'`.
- **Done when:** a cold load of each Momentum page logs no console errors in the research
  stack.

### Phase 2 — Mobile layout (item 3)
- **Tasks:** find the min-width culprit in `MomentumWeeklyView.tsx`, and scroll the active
  section tab into view on change.
- **Done when:** `document.documentElement.scrollWidth === innerWidth` on every Momentum page
  at 390 px.

### Phase 3 — Reopen the last result (item 1)
- **Tasks:** persist the last finished job id per dataset. Either re-fetch the job (if the
  service still holds it) or store the full result server-side alongside the saved run, and
  offer "Reopen last result".
- **Done when:** a reload after a finished run can bring the full result back in one click.

## Risks

- Item 1 needs storage decisions (result size: ~0.5–1.7 MB per run). Coordinate with
  BL-005 Phase 2, which splits the result into sections.

## Open questions

- Item 1: keep full results server-side for every saved run, or only the latest per dataset?

## Log

- 2026-10-05 — created from the Momentum UI performance review (2026-10-04 session).
