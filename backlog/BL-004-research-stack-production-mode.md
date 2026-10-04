# BL-004 — Production-build mode for the local research stack (`bun run start:prod`)

| | |
|---|---|
| **Priority** | P2 — the single biggest page-load win (5–10×) for daily local use, and cheap |
| **Status** | Planned |
| **Type** | improvement |
| **Area** | infra (+ dashboard config) |
| **Created** | 2026-10-05 |
| **Depends on** | none. Related: BL-002 (on Vercel the dashboard is already a production build, so this is only about local use) |
| **TODO.md row** | — (filled in when started) |

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

- Should `bun run start` itself switch to production mode, keeping a `start:dev` for UI
  editing? Or should production stay opt-in?
- Is a password prompt acceptable locally? The alternative is an explicit loopback-only
  exception in the gate (bind `-H 127.0.0.1` plus a flag). That weakens a fail-closed control
  and needs its own review.

## Log

- 2026-10-05 — created from the Momentum UI performance review (2026-10-04 session).
