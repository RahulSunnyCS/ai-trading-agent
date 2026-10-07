# BL-045 — Dashboard load diet: split the bundle, stop duplicate and wasted requests

| | |
|---|---|
| **Priority** | P2: BL-004 (production mode) is the big win; this is the next 2–3× |
| **Status** | Planned |
| **Type** | improvement |
| **Area** | dashboard |
| **Created** | 2026-10-07 |
| **Depends on** | BL-004 (measure against a production build). Related: BL-003, BL-006 |
| **TODO.md row** | none yet (filled in when started) |

## Context

The audit of 2026-10-07 found that every dashboard screen ships in the first bundle:

- `app/[[...slug]]/page.tsx` renders `DashboardClient` → `App.tsx`, which imports all 14 views
  directly. There is no `next/dynamic` or `React.lazy`; only Plotly is lazy.
- So the first load of any page carries:
  - Lightweight Charts;
  - `react-markdown` and `remark-gfm`;
  - all 30 guide pages (about 63 KB of text);
  - the 1,800-line `MomentumSettingsPanel`.
- The guide pages come in because `GuideLink`, which is always in the top bar, imports
  `guide/registry.ts`, which imports every page with `?raw`.

The audit PR `perf/dashboard-quick-wins` already does three things: requests are shared per URL
in `usePolledResource`, polling pauses while the browser tab is hidden, and `useDailyJob` polls
only while a run is in progress. What remains:

- **The landing-tab redirect wastes requests.** On a cold load of `/`, Overview mounts and fires
  about 15 requests, and only then does the app redirect to the saved landing tab, aborting them
  (`App.tsx`, `lib/routes.ts:28`).
- **Some views still fetch by hand, with no cache and no cancellation:**
  - `MomentumBacktestingView.tsx` (lines 468, 521, 564, 583–600);
  - `MomentumRebalanceView.tsx` (117–140);
  - `YamlBacktest.tsx` (60, 130).

  An older response can overwrite a newer one.
- **`/api/trades` is fetched in full every 10 s** (`usePaperTrades.ts:57`) for an Overview
  summary card. The endpoint has no `limit` or `since`.
- **Nothing is virtualised or paged.** No table is virtualised and `React.memo` is not used.
  Scores is BL-006; Trades and the Momentum results tables don't page either.
- **The Live chart redraws its whole series on every tick** (`LiveLineChart.tsx:111-119`).

## Goal

On a production build, First Load JS for Overview drops by at least 40% against the BL-004
baseline, and a cold `/` load fires requests only for the landing tab.

## Out of scope

- Server-side rendering or React Server Components. That rewrite does not pay for itself at
  this scale.
- Changes to the shape of the Python API responses (BL-046).

## Plan

### Phase 1 — Code-split the views and the Guide
- **Tasks:**
  - Load each view in `App.tsx` with `next/dynamic`, showing a skeleton while it loads.
  - Split `guide/registry.ts` into a small metadata module (titles, slugs; used by `GuideLink`)
    plus page bodies loaded with dynamic `import()`.
  - Load `GuideMarkdown` (react-markdown) dynamically.
- **Done when:** `next build`'s First Load JS for `/` is at least 40% smaller, and the
  Guide and every view still render (Playwright smoke test).

### Phase 2 — Landing tab before mount
- **Tasks:** resolve the stored landing tab before the first view mounts. Read it synchronously
  with try/catch, or render nothing until it is resolved.
- **Done when:** a cold `/` load with landing = Momentum makes no Overview request.

### Phase 3 — Last hand-rolled fetches
- **Tasks:**
  - Move `MomentumBacktestingView`, `MomentumRebalanceView` and `YamlBacktest` onto
    `usePolledResource` (`cache:true` where they remount).
  - Add `limit` (default 50) and `since` to `/api/trades`; the Overview card asks for a summary only.
- **Done when:** none of those files constructs its own `fetch` or `AbortController`.

### Phase 4 — Render cost
- **Tasks:**
  - Virtualise or page the Trades and Momentum results tables (shared with BL-006).
  - Append to the Live chart with `series.update()` instead of `setData`.
- **Done when:** sorting Scores takes under 100 ms, and Live CPU stays flat over a minute of ticks.

## Risks

- Dynamic imports add a loading flash when switching tabs. Prefetch the neighbouring views on
  idle (`import()` inside `requestIdleCallback`).

## Open questions

None yet.

## Log

- 2026-10-07: created from the whole-repo audit.
