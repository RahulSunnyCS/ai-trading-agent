# Automation Gate — Phase 6

**Result: CI-ONLY (non-blocking)**

## What ran
- `bunx playwright test --list` → 30 tests discovered across 4 files, **zero parse/syntax errors**.
- `bun run test:e2e` → could not execute: Chromium binary not installed in this environment
  (`browserType.launch: Executable doesn't exist ... run: npx playwright install`), and no live
  Vite dev server / backend is available here. Per the Automation Gate rule, a suite that cannot
  start is marked CI-ONLY and does not block Gate 2/3.

## Tag breakdown (from the discovered suite)
- 🔴 @critical    : 14
- 🟡 @functional  : 9
- 🟢 @non-blocker  : 7
- Total: 30 (e2e/live-view, trades-view, pnl-view, navigation .spec.ts)

## To run in CI / locally
1. Start backend: `SIMULATE=true bun run sim` (port 3000)
2. Start frontend: `bunx vite` (port 5173)
3. `npx playwright install chromium`
4. `bun run test:e2e`

Note: all specs use `page.route()` intercepts to mock `/api/trades` and `/api/straddle/latest`,
so they are deterministic and do NOT require real trades/DB — only the Vite dev server + chromium.

## Unit/integration (Vitest) — the blocking signal for this frontend change
- `bun run test:unit` → **360 passed / 4 skipped** (skips are pre-existing Redis/Docker integration).
- Frontend one-off typecheck → clean (exit 0).
These are green; the E2E layer is supplementary and CI-deferred.
