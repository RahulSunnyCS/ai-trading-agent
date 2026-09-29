# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working in this app.

For deep architecture/gotchas/env-var reference, see the monorepo root's
`.claude/project/technical.md` — this file stays a short, package-local
orientation pointer rather than duplicating that.

## What this app does

`@ata/server` (Fastify 4.x on Bun) is the trading backend: ingests market
ticks (Fyers WebSocket, Angel One, or a random-walk simulator), computes
straddle values and momentum signals, runs signals through the 10-personality
decision engine, records simulated paper trades to PostgreSQL/TimescaleDB,
and runs the nightly BullMQ retrospection job. It also serves the React
dashboard's API, the `/ws/ticks` WebSocket, Razorpay payment routes, and
proxies `/api/backtest/*` to the loopback-only Python `option-backtesting`
FastAPI service.

## Cross-package links

- Imports `@trading/broker-identity` (`src/ingestion/brokers/angelone.ts`) for
  the one RFC 6238 TOTP generator — see that package's `CLAUDE.md`. Never add
  a second TOTP implementation here.
- Imports `@trading/market-reference` (`src/trading/paper-trade-executor.ts`,
  `src/trading/portfolio-risk.ts`) for lot-size/strike-step lookups — never
  hard-code either value inline, see that package's `CLAUDE.md` for why.
- Proxies to `packages/option-backtesting`'s FastAPI service over HTTP only
  (`BACKTEST_API_URL`, default `127.0.0.1:8000`) — never imports it as code,
  and the proxy validates at startup that the URL resolves to loopback/private
  address space (`apps/server/src/server/routes/backtest.ts`).
- `apps/dashboard` is the only consumer of this app, over HTTP — nothing in
  this repo imports `@ata/server` as a package.
- Does **not** talk to `packages/momentum-backtesting`, `packages/broker-login`,
  or `packages/contract-notes` at all — those are independent, separately
  scheduled jobs with no runtime relationship to this app.

## Utility functions worth knowing before you duplicate one

- `src/utils/clock.ts` — the injectable `Clock` used everywhere instead of
  `Date.now()`/`new Date()` directly, so tests can control time. `src/utils/pnl.ts`
  holds shared P&L math (straddle/paper-trade calculations) — see the root
  `technical.md`'s decimal.js convention before adding new monetary math here.
- `src/ingestion/brokers/instrument-registry.ts` — the Fyers weekly/monthly
  option-symbol encoder/decoder. Never hand-build a Fyers symbol string inline.
- `src/ingestion/brokers/broker-factory.ts` — `createBroker()`, the one place
  that selects Fyers/Angel One/simulator by env var. New brokers register here.
- `src/db/schema.ts` — the canonical TypeScript type for every DB table; query
  results should be typed against this, not redefined per-call-site.

## Source layout (see root `technical.md` for the full annotated tree)

- `src/index.ts` — entry point, branches on `SIMULATE`
- `src/ingestion/` — tick ingestion, straddle calc, VIX feed, broker adapters
- `src/trading/` — personalities, signal detection, paper trade execution
- `src/retrospection/` — EOD metrics, Brier scores, evolution engine
- `src/backtesting/` — T-51 replay engine (a different question from
  `packages/option-backtesting`: this replays the *live personalities*
  historically, that package answers "is this strategy worth becoming one")
- `src/server/routes/`, `src/api/routes/` — Fastify route handlers
- `src/payment/` — Razorpay order creation, webhook verification, geolocation
- `src/db/migrations/` — sequential SQL migrations, `NNN_description.sql`
- `scripts/` — `replay.ts`, `backtest.ts`, `backfill-legs.ts`, `reconstruct.ts`
  (operational scripts, not part of the running server)

## Commands

Run from the repo root (see root `technical.md`'s Essential Commands for the
full list) — `bun run dev` / `bun run sim` / `bun run typecheck` / `bun run
test:unit` / `bun run test:integration` (needs Docker services running).
