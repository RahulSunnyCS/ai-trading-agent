# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this app.

For deep architecture/gotchas, see the monorepo root's
`.claude/project/technical.md` — this file stays a short, package-local
orientation pointer rather than duplicating that.

## What this app does

`@ata/dashboard` (Next.js + React 18 + Zustand + Tailwind) is the frontend: live
straddle/momentum charts (Lightweight Charts), active signals, per-personality
running P&L, EOD retrospection charts, pricing/payment UI, a "Backtest"
tab for `packages/option-backtesting`'s results, and an "Options Lab" tab
(`OptionsLabView.tsx` + `components/optionslab/`) — daily leg-wise option
strategies on the Fyers 1-minute data: saved `obt daily` results, the evening
run button, and an AlgoTest-style strategy builder that validates, backtests
and saves `strategies/legwise/*.yaml`, all via `/api/backtest/legwise/*`. Clicking a day replays it (`DayForensics.tsx`: MTM vs index, markers, per-leg attribution, via `/legwise/day`); the day grid carries per-segment anatomy chips (`/legwise/anatomy`); stats are ₹ per lot with sample-size guards (`lib/legwiseStats.ts` — keep that maths out of components). A "Market regimes" tab studies whether QUIET/CHOP/TREND periods persist (`RegimesPanel.tsx`; permutation-tested in `lib/regimeStats.ts` — new statistics belong there, seeded and unit-tested, never `Math.random`). Strategy P&L is joined to day type in `DayTypeCard.tsx` (`lib/legwiseJoin.ts`: same-day vs previous-day lenses); the builder diffs an edit against the saved version's stored results rather than re-running it (a re-run costs a credit). Use `lib/plotly.ts` for Plotly.
The Momentum view is the sole Momentum frontend; its Saved strategies section promotes saved
runs to weekly favourites and selects one global Telegram-active favourite. Weekly signal runs
render every favourite's result while only that active result is delivered. The Python package
serves its API;
its research chart uses a lazy-loaded Plotly basic bundle with optional wheel/
touchpad zoom and the shared CSS theme tokens.

**Routing:** the URL is the source of truth for tab and sub-tab (`app/[[...slug]]/page.tsx`
renders the shell; `lib/routes.ts` holds the path grammar, `hooks/useAppRoute.ts` reads/pushes
it). Paths: `/<tab>`, `/optionslab/<results|regimes|builder>`,
`/momentum/<backtest|scores|saved|weekly|rebalance>`, `/momentum/backtest/<dataset>`,
`/momentum/scores/<stocks|sectors>`. A new sub-tab = add its ids to `lib/routes.ts` and derive
state from `useAppRoute().rest` — don't add another `useState` for navigation. `useAppRoute`
moves with `window.history.pushState`/`replaceState`, never `router.push`: every path is the same
`[[...slug]]` page, and a router navigation to a different slug re-mounts the whole shell (all
state lost, every view refetches). Next keeps `usePathname` and back/forward in sync with it.

**Remote hosting:** `src/middleware.ts` (logic in `lib/accessGate.ts`, cookie signing in
`lib/session.ts`) puts a login in front of everything (a `/login` page and session cookie for
people, HTTP Basic for `/api/*` and curl) and adds the Cloudflare Access service token to forwarded `/api/*`
calls, so the dashboard can run off the laptop that serves the APIs. The password is
mandatory (fails closed) in production builds; plain `next dev` stays open. Runbook:
`docs/remote-dashboard.md`.

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
  `PersonalitiesView.tsx`, `BacktestView.tsx`, `PnlView.tsx`, …), plus
  `shell/` (layout chrome) and `ui/` (generic primitives)
- `src/pages/` — top-level routed pages
- `src/hooks/` — one hook per data resource, all built on `usePolledResource`
- `src/store/settings.ts` — density, defaults, notifications and the developer flag
  (Settings tab); `src/store/theme.ts` — Zustand theme store; `src/store/navigation.ts` owns the
  locally persisted tab visibility/order preferences. Personality/live state is
  fetched via hooks, not centralized in a store.
- `src/types/` — `backtest.ts` etc. — hand-kept in sync with `apps/server`'s
  API response shapes (see Cross-package links above)
- `e2e/` — Playwright specs

## Commands

Run from the repo root unless noted:
```bash
bun run --filter @ata/dashboard dev         # Next dev server (:5173), rewrites /api to :3000
# Options Lab without Postgres/Redis/apps/server: start `bun run py:api`, then
# OBT_DIRECT=1 routes ONLY /api/backtest/legwise/* straight to it (dev-only,
# off by default — the Fastify proxy stays the only production path)
(cd apps/dashboard && OBT_DIRECT=1 bun run dev)
bun run --filter @ata/dashboard typecheck   # NOT part of the root `bun run typecheck` — has one pre-existing error, run explicitly
bun run test:e2e                            # Playwright suite — start the Next dev server first
```
