# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this app.

For deep architecture/gotchas, see the monorepo root's
`.claude/project/technical.md` — this file stays a short, package-local
orientation pointer rather than duplicating that.

## What this app does

`@ata/dashboard` (Next.js + React 18 + Zustand + Tailwind) is the frontend: live
straddle/momentum charts (Lightweight Charts), active signals, per-personality
running P&L, EOD retrospection charts, pricing/payment UI, and an "Options Lab" tab
(`OptionsLabView.tsx` + `components/optionslab/`) — daily leg-wise option
strategies on the Fyers 1-minute data: saved `obt daily` results, the evening
run button, and an AlgoTest-style strategy builder that validates, backtests
and saves `strategies/legwise/*.yaml`, all via `/api/backtest/legwise/*`. Clicking a day replays it (`DayForensics.tsx`: MTM vs index, markers, per-leg attribution, via `/legwise/day`); the day grid carries per-segment anatomy chips (`/legwise/anatomy`); stats are ₹ per lot with sample-size guards (`lib/legwiseStats.ts` — keep that maths out of components). A "Market regimes" tab studies whether QUIET/CHOP/TREND periods persist (`RegimesPanel.tsx`; permutation-tested in `lib/regimeStats.ts` — new statistics belong there, seeded and unit-tested, never `Math.random`). Strategy P&L is joined to day type in `DayTypeCard.tsx` (`lib/legwiseJoin.ts`: same-day vs previous-day lenses); the builder diffs an edit against the saved version's stored results rather than re-running it (a re-run costs a credit). Use `lib/plotly.ts` for Plotly.
The Momentum view is the sole Momentum frontend. Its Saved runs section (BL-052,
`components/momentum/saved/SavedStrategiesView.tsx`) lists one row per saved *strategy* across
every dataset from `/api/momentum/saved-strategies`, sets each favourite's status, makes the
headline and groups, and opens a strategy drawer (`?strategy=<id>`) with why a result moved;
names, differences from the defaults, trust and change wording are in `lib/momentumSaved.ts`.
Every favourite is evaluated each Friday while only the headline's result is delivered. The Python package
serves its API;
its research chart uses a lazy-loaded Plotly basic bundle with optional wheel/
touchpad zoom and the shared CSS theme tokens.

**Routing:** the URL is the source of truth for tab and sub-tab (`app/[[...slug]]/page.tsx`
renders the shell; `lib/routes.ts` holds the path grammar, `hooks/useAppRoute.ts` reads/pushes
it). Paths: `/<tab>`, `/optionslab/<strategies|builder|runs|results|regimes>`,
`/optionslab/builder/yaml` (the YAML engine; `/backtest` redirects there),
`/coverage/<backfill|replay>` (old `/backfill`, `/replay` redirect), `/jobs` (the scheduler's Jobs page, read from `/api/scheduler/*` — needs `SCHEDULER_DIRECT=1`), `/billing` (`/pricing` redirects),
`/momentum/<backtest|scores|saved|week|rebalance|journal>` (`/momentum/weekly` redirects to `week`; This week's state is in the query: `?week=`, `?fav=`, `?panel=run`, `?review=`, `?stock=`), `/momentum/backtest/<dataset>`,
`/momentum/scores/<stocks|sectors>`, `/guide/<chapter>/<page>` (`/help` and `/docs` redirect). A new sub-tab = add its ids to `lib/routes.ts` and derive
state from `useAppRoute().rest` — don't add another `useState` for navigation. `useAppRoute`
moves with `window.history.pushState`/`replaceState`, never `router.push`: every path is the same
`[[...slug]]` page, and a router navigation to a different slug re-mounts the whole shell (all
state lost, every view refetches). Next keeps `usePathname` and back/forward in sync with it.

**Guide (BL-041):** the in-app docs for people who know basic options and momentum but not this tool.
Pages are Markdown in `src/guide/content/<chapter>/<page>.md`, imported as strings (`?raw`; the one
webpack rule is in `next.config.ts`) and listed in `src/guide/registry.ts`, which also drives the
index, previous/next, search and the "How this works" link in the top bar (`GuideLink`, looked up
by tab and sub-section). Terms live in `src/guide/glossary.ts`. In a page, `[x](app:/path)` opens a
screen, `[x](guide:chapter/page)` another page, `[x](glossary:id)` a hover definition, and
`> [!NOTE]` / `[!TIP]` / `[!WARNING]` make callouts. **Upkeep rule: a change to a screen's controls,
labels, defaults or metrics updates its guide page in the same commit.** A new screen or
sub-section gets a page and a registry entry. `guide/__tests__/registry.test.ts` fails on a broken
link, a screen that no longer exists, or a Momentum / Options Lab sub-screen with no page.

**Remote hosting:** `src/middleware.ts` (logic in `lib/accessGate.ts`, cookie signing in
`lib/session.ts`) puts a login in front of everything (a `/login` page and session cookie for
people, HTTP Basic for `/api/*` and curl) and adds the Cloudflare Access service token to forwarded `/api/*`
calls, so the dashboard can run off the laptop that serves the APIs. The password is
mandatory (fails closed) in production builds; plain `next dev` stays open. Runbook:
`docs/remote-dashboard.md`.

## Analytics page pattern

First built on Momentum › Backtest (owner-approved from mockups, 2026-10-07; the mockups are
`backlog/assets/BL-049/` for Scores). Use it for any page that shows the result of a run:
backtests, Options Lab runs, P&L, journals, the Scores page (BL-049). Words used in prompts
and code comments are in *italics*.

1. **One sidebar.** On an analytics page (`isAnalyticsPage` in `lib/routes.ts`) the app
   navigation is an icon rail and the page uses the full width. It never adds a second
   permanent side column.
2. **Run bar.** One line at the top: the current inputs as chips (a chip opens that section of
   the settings), then reload, share, **Settings** and **Run**. Settings open in a *settings
   drawer*, `components/ui/Drawer.tsx`, from the right. Run closes it once the run has started.
3. **Headline strip.** The 4–5 numbers that decide whether the result is good, large, each with
   the benchmark's figure and the gap as a badge (`+6.5pp`, `1.78×`). Secondary metrics go on
   one line that never wraps and fades out at the edge, with "All metrics" for the rest.
4. **Benchmarks are first-class.** Every headline number is shown against a benchmark; the
   *benchmark picker* on the strip switches every comparison on the page at once without a
   re-run. The server sends all choices with the result (`result.benchmarks`);
   `lib/momentumBenchmark.ts` resolves the pick. A pick with no usable data for the run falls
   back to the run's own benchmark and says so (`view.replaced`), never silently.
5. **Hero chart.** Full width, as tall as the first screen allows (aim for two-thirds), main
   series and benchmark only; other series are added by the reader. Secondary panes (drawdown)
   are off by default behind a toggle.
6. **First-screen rule.** In a 1600×1000 window the run bar, headline strip and hero chart
   answer "is this good?" without scrolling.
7. **Follow tooltip.** A short tooltip centred about 1 cm (40 px) *below* the cursor; flips
   above near the bottom edge, clamps at the sides, and ignores the mouse (`pointer-events:
   none`) so the next point is always reachable. Click pins the full-detail card (Esc or a second
   click closes it); ← → step between events such as rebalances. The placement maths is
   `tooltipPlacement` in `lib/momentumResult.ts`; place the tooltip once per animation frame.
8. **Widgets, not tabs, below the first screen.** A scrolling grid of cards (`Widget` in
   `components/momentum/MomentumResultWidgets.tsx`): title, one-line description, actions on the
   right. A widget that does not apply to the current mode is left out, not disabled.
9. **Progressive loading.** The first screen renders from the core response alone. Widgets
   wait for the hero chart's first paint (`onPainted`), then load in the background in order,
   or at once when scrolled near (`hooks/useWidgetActivation.ts`). An expensive widget (a second
   engine run) loads only when scrolled to, with a short margin. Every widget shows a placeholder
   while loading and an error with Retry on failure (`useRunSection` and `Loaded`).
10. **Dense one-line tables.** 32 px rows that never wrap: long text is cut with an ellipsis and
    the full text is in the tooltip; figures in the mono face, right-aligned; an inline bar or a
    badge instead of a second line; "Show all" for long lists.
11. **Charts must not redraw on unrelated renders.** Anything derived from the picked benchmark
    is memoised, so a ticking timer or a settings keystroke does not redraw Plotly.

The repo-wide rules still apply: token colours only, `lib/format.ts` for display formatting,
controls from `components/ui/`, fetching through `usePolledResource` / `useRunSection`, and
the guide page updated in the same commit.

## Cross-package links

This app has **no internal package dependencies** (`package.json` declares
none) — it talks to `apps/server` exclusively over HTTP (`/api/*`, `/ws/ticks`),
never imports `@ata/server` or any `@trading/*` package directly, and never
talks to the Python `option-backtesting` service directly either (always
through `apps/server`'s Fastify proxy — see that app's `CLAUDE.md`). If a type
needs to be shared with the server, it is currently hand-duplicated in
`src/types/`, not imported from `@ata/server`.

## Utility functions worth knowing before you duplicate one

- **`src/hooks/usePolledResource.ts`** — the shared data-fetching hook. Every
  other data hook (`usePersonalities`, `usePaperTrades`, `useRegimeTags`, …)
  is built on this rather than hand-rolling another AbortController +
  in-flight-guard fetch loop; see root `technical.md`'s Key Patterns section
  for the exact bug this fixed (two hooks got stuck on "loading" forever from
  duplicated logic before the extraction). Pass `{ intervalMs }` for polling,
  omit it for fetch-once-with-manual-refresh; `{ cache: true }` is in root
  `technical.md`.
- `src/hooks/useNow.ts` — the one ticking clock (`Date | null`, null until mounted). Every caller
  re-renders on each tick, so call a fast one in a small leaf (`components/live/LiveClock.tsx`),
  not at the top of a view.
- `src/hooks/useRunSection.ts` — a Momentum background run's result holds the core only; the
  heavy parts (trades, instruments, timeline, this week's signals, the Broad circuit card) are
  fetched when the widget showing them activates (`hooks/useWidgetActivation.ts`: near the screen,
  or in the background after the chart, in `MomentumResultWidgets.tsx`'s order): `useRunSection(runId, 'trades')` returns
  `{data, loading, error, retry}`, backed by `loadSection` in `store/momentumRuns.ts`. Render with
  `Loaded` in `MomentumResultDetails.tsx` (skeleton, error with retry, content) rather than reading
  `result.trades` directly: it is `undefined` until fetched.
- `src/lib/api.ts` — the one HTTP client wrapper; route new API calls through
  this rather than a fresh `fetch()` call site.
- `src/lib/pnl.ts` / `src/lib/format.ts` — shared P&L and number/currency
  formatting helpers (keep display formatting here, not per-component).
- `src/lib/chartTheme.ts` — the one Lightweight Charts theme config; every
  chart component should reuse this rather than defining its own colors. It
  returns `rgb()`/`rgba()` on purpose: Lightweight Charts 4.x cannot parse
  `hsl()` and throws, blanking the chart (fixed 2026-09-30).
- `src/lib/cn.ts` — the `clsx`/Tailwind class-merge helper used throughout
  `components/`.

## Source layout

- `src/components/` — one file per dashboard view/dialog (`LiveView.tsx`,
  `PersonalitiesView.tsx`, `OptionsLabView.tsx`, `PnlView.tsx`, …), plus
  `shell/` (layout chrome) and `ui/` (generic primitives)
- `src/pages/` — top-level routed pages
- `src/hooks/` — one hook per data resource, all built on `usePolledResource`
- `src/store/settings.ts` — density, defaults, notifications and the developer flag
  (Settings tab); `src/store/theme.ts` — Zustand theme store; `src/store/navigation.ts` owns the
  locally persisted tab visibility/order preferences; `src/store/momentumScores.ts` and
  `src/store/momentumScoresViews.ts` what the reader keeps on Momentum › Scores (hidden columns, the map's
  minimum stocks; saved views of the Stocks list and the strip card's open state); `src/store/momentumView.ts` the Momentum
  result layout (the headline benchmark pick, the chart's drawdown pane and week list, the full metric set). Personality/live state is
  fetched via hooks, not centralized in a store.
- `src/guide/` — the Guide's registry, glossary and Markdown pages; `components/guide/` renders them
- `src/types/` — `backtest.ts` etc. — hand-kept in sync with `apps/server`'s
  API response shapes (see Cross-package links above)
- `e2e/` — Playwright specs

## Commands

Run from the repo root unless noted:
```bash
bun run start                               # research stack: APIs + `next dev` on 127.0.0.1:5190 (UI editing)
bun run start:prod                          # same with a production build (.next-prod, BL-004): ~1 s pages;
                                            # needs DASHBOARD_PASSWORD in apps/dashboard/.env.local; rebuilds only on change
bun run --filter @ata/dashboard dev         # Next dev server (:5173), rewrites /api to :3000
# Options Lab without Postgres/Redis/apps/server: start `bun run py:api`, then
# OBT_DIRECT=1 routes ONLY /api/backtest/legwise/* straight to it (dev-only,
# off by default — the Fastify proxy stays the only production path)
(cd apps/dashboard && OBT_DIRECT=1 bun run dev)
bun run --filter @ata/dashboard typecheck   # NOT part of the root `bun run typecheck` — run explicitly (CI runs it in the dashboard job)
bun run test:e2e                            # Playwright suite — start the Next dev server first
```
