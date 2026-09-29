# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this app.

For deep architecture/gotchas, see the monorepo root's
`.claude/project/technical.md` — this file stays a short, package-local
orientation pointer rather than duplicating that.

## What this app does

`@ata/dashboard` (React 18 + Vite + Zustand + Tailwind) is the SPA: live
straddle/momentum charts (Lightweight Charts), active signals, per-personality
running P&L, EOD retrospection charts, pricing/payment UI, a "Backtest"
tab for `packages/option-backtesting`'s results, and an "Options Lab" tab
(`OptionsLabView.tsx` + `components/optionslab/`) — daily leg-wise option
strategies on the Fyers 1-minute data: saved `obt daily` results, the evening
run button, and an AlgoTest-style strategy builder that validates, backtests
and saves `strategies/legwise/*.yaml`, all via `/api/backtest/legwise/*`.

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
  omit it for fetch-once-with-manual-refresh.
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
- `src/store/theme.ts` — Zustand store (currently just theme; personality/live
  state is fetched via hooks, not centralized in a store)
- `src/types/` — `backtest.ts` etc. — hand-kept in sync with `apps/server`'s
  API response shapes (see Cross-package links above)
- `e2e/` — Playwright specs

## Commands

Run from the repo root unless noted:
```bash
bun run --filter @ata/dashboard dev         # Vite dev server, proxies /api to :3000
# Options Lab without Postgres/Redis/apps/server: start `bun run py:api`, then
# OBT_DIRECT=1 routes ONLY /api/backtest/legwise/* straight to it (dev-only,
# off by default — the Fastify proxy stays the only production path)
(cd apps/dashboard && OBT_DIRECT=1 bun x vite)
bun run --filter @ata/dashboard typecheck   # NOT part of the root `bun run typecheck` — has one pre-existing error, run explicitly
bun run test:e2e                            # Playwright suite — start the Vite dev server first
```
