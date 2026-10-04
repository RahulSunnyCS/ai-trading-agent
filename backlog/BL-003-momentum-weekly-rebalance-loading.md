# BL-003 — Momentum: honest loading states on Weekly signal and Rebalance

| | |
|---|---|
| **Priority** | P2 — the Weekly page shows placeholder values that read as real answers about what Telegram will send |
| **Status** | Planned |
| **Type** | improvement |
| **Area** | dashboard |
| **Created** | 2026-10-05 |
| **Depends on** | none — builds on `c04ec51` (cache option, `Shimmer`, `MomentumSkeletons.tsx`) |
| **TODO.md row** | — (filled in when started) |

## Context

A Playwright review of every Momentum page on 2026-10-04 (filmstrips at 250 ms / 600 ms /
1.2 s / 2.5 s, production build) found loading states that either show nothing or show
something false. `c04ec51` fixed Backtest (blank settings area), Scores (a line of text) and
Saved runs (a false "0 runs — run a backtest" empty state), and made section revisits instant
(`usePolledResource({ cache: true })`, `fetchCached()`). Two pages remain.

**Weekly signal** (`components/momentum/MomentumWeeklyView.tsx`):

- While `/weekly/status` and `/favorite-strategies` load, "This week's status" shows
  **"None saved yet"**, **"Default live strategy"** and **"Check default strategy data below"**.
  All three look like real answers. The real ones that week were "02 Oct 2026 · ETF Weekly
  Core", "ETF Weekly Core" and "Data ready".
- The help line says "The default live strategy will be evaluated." until favourites load,
  and the Telegram note says the same.
- A favourites load error is swallowed: the page falls back to "Default live strategy". That
  is how a missing `favorite-strategies` rewrite went unnoticed until PR #3.
- "Data & schedule" and the stock-action alerts show a bare "Loading…".

**Rebalance preview** (`components/momentum/MomentumRebalanceView.tsx`):

- The page waits on `Promise.all([saved-runs, meta, scores])`. `/api/momentum/scores` is
  ~300 KB (76 KB gzipped), the slowest of the three (~590 ms on a production build), and is
  only used for the asset autocomplete. Until it lands, the strategy select is disabled and
  "Data through —" shows.
- No placeholder for "Data through" or for the config summary line, so the card grows when
  they arrive.
- `biome check` reports one error in this file. It was already there before the review.

## Goal

No Momentum page shows a value during loading that could be mistaken for data. Rebalance is
usable as soon as its saved runs and meta arrive, independent of the scores download.

## Out of scope

- The Rebalance preview computation itself (`POST /rebalance-preview`).
- Weekly run orchestration — this is presentation only.

## Plan

### Phase 1 — Weekly signal
- **Tasks:** `cache: true` on `weekly/status`, `favorite-strategies` and `stock-actions`. While
  `loading && !data`, render `<Shimmer inline />` for the three status values instead of the
  fallbacks. When `favorites.error && !favorites.data`, show "Couldn't load favourites"
  (not "Default live strategy"). Hide the "…will be evaluated" sentence and the Telegram
  target until favourites are known. Use `MomentumListSkeleton` (bordered) for Data & schedule
  and the stock-action alerts.
- **Deliverables:** updated `MomentumWeeklyView.tsx`; a component test for the
  favourites-error state.
- **Done when:** at 250 ms after a cold load, the filmstrip shows shimmers and no fallback
  text. A 500 from `favorite-strategies` renders an error, not "Default live strategy".

### Phase 2 — Rebalance
- **Tasks:** drop scores from the `Promise.all`. Load suggestions separately with
  `fetchCached('/api/momentum/scores')`, which is instant when Scores was visited first. Add a
  `Shimmer` for "Data through" and the config summary line. Fix the existing Biome error.
- **Deliverables:** updated `MomentumRebalanceView.tsx`.
- **Done when:** time-to-ready ≈ max(saved-runs, meta), measured with the scratch Playwright
  script. `e2e/momentum-rebalance.spec.ts` passes and `biome check` is clean for the file.

### Phase 3 — Verify
- **Tasks:** re-run the load/filmstrip measurement on a production build, plus the dashboard
  unit and e2e suites.
- **Done when:** filmstrips attached to the PR; no new e2e failures versus `main`.

## Risks

- A shimmer that never resolves on a silent failure. Every shimmer must be gated on
  `loading && !data && !error`, with an error state as the alternative.

## Open questions

- None expected; confirm the wording for the favourites-error message.

## Log

- 2026-10-05 — created from the Momentum UI performance review (2026-10-04 session).
