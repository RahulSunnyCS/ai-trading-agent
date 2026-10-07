# BL-004 — Production-build mode for the local research stack (`bun run start:prod`)

| | |
|---|---|
| **Priority** | P2 — the single biggest page-load win (5–10×) for daily local use, and cheap |
| **Status** | Done (Phases 1–3, 2026-10-07) |
| **Type** | improvement |
| **Area** | infra (+ dashboard config) |
| **Created** | 2026-10-05 |
| **Depends on** | none. Related: BL-002 (on Vercel the dashboard is already a production build, so this is only about local use) |
| **TODO.md row** | 3.12.15 |

## Context

`bun run start` (`scripts/dev-stack.mjs research`) serves the dashboard with
`bun run --bun next dev --port 5190`. Under `next dev` the Momentum pages are slow regardless of
the Momentum code. Measured 2026-10-04 with Playwright, cold load of each page, same code and
APIs:

| Page | `next dev` | production build |
|---|---|---|
| Backtest · ETF | 7.9 s | 1.4 s |
| Backtest · Broad | 6.6 s | 0.8 s |
| Scores · Stocks | 8.4 s | 1.5 s |
| Scores · Sectors | 9.5 s | 0.8 s |
| Saved runs | 6.2 s | 0.8 s |
| Weekly signal | 7.1 s | 0.8 s |
| Rebalance | ~8.8 s | ~0.9 s |

- JavaScript: 3.1 MB transferred / 13.6 MB decoded in dev, against 267 KB / 889 KB built. No
  API call starts until 4–6 s after navigation in dev.
- The dev rewrite proxy: six parallel API calls take 2.6 s through Next dev, against 0.47 s
  direct to the Python service.
- A cold dev compile of `/[[...slug]]` took 77 s.
- Dev under Bun proved fragile. The long-running dev server on 5190 stopped picking up file
  edits after ~20 h, and a fresh dev server in a copy hung after compiling.

Constraint: `lib/accessGate.ts` fails closed. A production build (`NODE_ENV=production`)
returns 503 on every request unless `DASHBOARD_PASSWORD` is set. That is deliberate (see
`docs/remote-dashboard.md`) and must not be weakened without a security review.

## Goal

`bun run start:prod` brings up both research APIs plus a production-built dashboard on :5190,
with every Momentum page ready in ~1 s. A restart with no code changes skips the build.

## Out of scope

- Changing what `bun run start` does by default (open question below).
- Hosting (BL-002).

## Plan

### Phase 1 — `--prod` flag in `dev-stack.mjs`
- **Tasks:**
  - Add a `--prod` flag. Before spawning, run `bun run --bun next build` with
    `MOMENTUM_DIRECT=1 OBT_DIRECT=1` (rewrites are baked in at build time), then spawn
    `next start --port 5190`.
  - Build into its own `distDir` (`.next-prod`, via `NEXT_DIST_DIR` in `next.config.ts`) so a
    concurrent `next dev` cannot overwrite the served build, or the build its cache. Add
    `.next-prod/types/**/*.ts` to `apps/dashboard/tsconfig.json`'s include (Next would
    otherwise edit it during the build), `.next-prod/` to `.gitignore` and to Biome's ignore.
  - Refuse to start, with a clear message, when `DASHBOARD_PASSWORD` is absent from the
    environment and from `apps/dashboard/.env.local` / `.env.production.local`. The message
    should name the file and `openssl rand -base64 24`.
  - Add root scripts `start:prod` and `start:frontend:prod`.
- **Deliverables:** `scripts/dev-stack.mjs`, `next.config.ts`, `tsconfig.json`, `.gitignore`,
  `biome.json`, `package.json`.
- **Done when:** `bun run start:prod` serves :5190 behind the password prompt, and the
  Playwright load script shows every Momentum page ready in ≤ 1.5 s.

### Phase 2 — Skip unchanged rebuilds
- **Tasks:** write `.next-prod/research-stack.json` after a build, recording the newest mtime
  across `apps/dashboard/{src,public}`, the config files, `bun.lock`, and the baked env values.
  Rebuild only when something is newer or the env differs.
- **Done when:** a second `start:prod` with no edits is ready in < 5 s.

### Phase 3 — Docs
- **Tasks:** `technical.md` Essential Commands. In `docs/remote-dashboard.md`, the line "Only
  plain local `next dev` (`bun run start`) is open" should mention `start:prod` and its
  password. The dashboard `CLAUDE.md` commands block.
- **Done when:** the docs match the scripts.

## Risks

- A stale `.next-prod` served after a dependency bump: include `bun.lock` and
  `package.json` in the change check.
- The Basic-Auth prompt is a small daily cost locally. The browser remembers it for the
  session.

## Open questions

None left. Both were answered by the owner on 2026-10-07 (see Decisions).

## Decisions (owner, 2026-10-07)

- **Production stays opt-in.** `bun run start:prod` is new; `bun run start` stays `next dev`
  (no default switch, no `start:dev`).
- **A local password prompt is acceptable.** `start:prod` refuses to start without
  `DASHBOARD_PASSWORD` (environment, or `apps/dashboard/.env.local` /
  `.env.production.local`); the message names the file and `openssl rand -base64 24`.
  `lib/accessGate.ts` is not weakened: no loopback exception.
- **Bind to loopback.** `next start -H 127.0.0.1`. The same `-H 127.0.0.1` goes on the existing
  `next dev` in `scripts/dev-stack.mjs`: a security audit found `next dev` listening on every
  interface with no password while proxying `/api/scheduler/*`, so anyone on the same Wi-Fi
  could start scheduler jobs.

## Log

- 2026-10-05 — created from the Momentum UI performance review (2026-10-04 session).
- 2026-10-06 — owner decisions on PR #27: keep it — not dropped, even with BL-002 coming.
- 2026-10-07 — owner decisions recorded above; started and finished the same day.
  - **Phase 1:** `scripts/dev-stack.mjs --prod` builds the dashboard into `.next-prod`
    (`NEXT_DIST_DIR`, the one `next.config.ts` change) with `MOMENTUM_DIRECT=1 OBT_DIRECT=1
    SCHEDULER_DIRECT=1` baked in, then runs `next start --port 5190 -H 127.0.0.1`. Root scripts
    `start:prod` and `start:frontend:prod`; `--rebuild` forces a build, `--port <n>` serves on
    another port. `.next-prod` is in `.gitignore`, Biome's ignore and the dashboard
    `tsconfig.json` include. `next build` rewrites the tracked `next-env.d.ts` to point at its
    distDir; the script puts the file back after the build. `next dev` now binds 127.0.0.1 too.
  - **Phase 2:** `.next-prod/research-stack.json` records the newest mtime across
    `apps/dashboard/{src,public}` (directories included, so a deleted file counts), the
    dashboard config and `.env*` files, the root `bun.lock`, `package.json` and
    `tsconfig.base.json`, plus the baked env (`*_DIRECT`, the direct origins,
    `DASHBOARD_API_URL`, `NEXT_PUBLIC_*`). A restart with nothing changed was ready in 4.2 s
    (target < 5 s).
  - **Phase 3:** `technical.md` Essential Commands, `docs/remote-dashboard.md`,
    `apps/dashboard/CLAUDE.md`.
  - **Measured** (Playwright, fresh browser context and cache disabled per load, median of 3
    interleaved runs, dev = the owner's long-running `next dev` on :5190, prod = this build on
    :5191, same Python APIs). Page shell loaded / first API call started: Overview 4.7 s →
    0.11 s, Momentum Backtest 3.5 s → 0.11 s, Scores 3.5 s → 0.14 s, Weekly signal 3.7 s →
    0.12 s, Options Lab 4.9 s → 0.13 s. JavaScript per page 4.8–5.8 MB transferred /
    20.5–23.6 MB decoded in dev against 437 KB / 1.4 MB built. `next build` First Load JS:
    `/[[...slug]]` 441 kB (338 kB page + 103 kB shared), `/login` 106 kB, middleware 36.5 kB.
  - **Goal not fully met: "every Momentum page ready in ≤ 1.5 s".** The production shell is
    ready in ~0.1 s, but the pages' first wave of API calls still ends 17–20 s after
    navigation, because the Momentum API itself took 18–40 s per catalog-backed call that
    evening (`/api/momentum-scores` 40 s, `/api/stock-actions` 31 s, `/api/weekly/status`,
    `/api/favorite-strategies`, `/api/saved-runs` ~18 s each, measured straight against
    :8765). That is the shared-catalog lock / view binding that PRs #101 and #104 address, not
    the dashboard. Dev was 22–59 s on the same measure. The machine was heavily loaded during
    the build (load average ~20–28 from parallel sessions): the first `next build` took 39 min
    there, which is not representative.
