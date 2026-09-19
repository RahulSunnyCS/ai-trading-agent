# AI Trading Agent

Paper-trading research platform for weekly index options strategies on Indian
markets (NSE/BSE). A Bun-workspaces monorepo: the trading engine, a React
dashboard, two daily broker-ops jobs, and a Python options-backtesting
workbench.

## The Approach

Most trading research suffers from a fundamental flaw: you tune a single strategy until it looks good, then discover it was curve-fitted to the regime you happened to study. This platform attacks that problem differently — by running **10 competing trading personalities in parallel**, each with its own risk tolerance, entry thresholds, and trade management style, all trading the same signals at the same time on paper.

The idea is simple: instead of asking "is this strategy good?", we ask "which personality survives across regimes, and why?". Every personality sees the same momentum-exhaustion signals generated from NSE/BSE ATM straddle data. Each one independently decides whether to act — filtering the signal through five stages (hard risk limits → position state → market context → signal quality → optional profit gate). The result is a controlled experiment: identical market exposure, divergent decision logic, measurable outcomes.

A frozen **Clockwork** personality acts as the immutable benchmark. Its parameters never change. Every other personality is measured against it — not against the market, not against itself from last week, but against a stable reference. This makes regime-to-regime comparison honest: if Clockwork bleeds in a trending market and Precision thrives, that's signal, not noise.

At end-of-day, a retrospection engine tags each day's results by market regime (`RANGING`, `TRENDING_STRONG`, `VOLATILE_REVERTING`, `EVENT_DAY`) and computes per-personality metrics: Beat-Clockwork delta, signal calibration score, management effectiveness. Rule-based parameter evolution then proposes adjustments — with human approval gates — so the personalities adapt to evidence rather than intuition.

## Quick start

```bash
docker compose up -d          # TimescaleDB + Redis — wait for (healthy)
bun install
bun run migrate
bun run sim                   # simulation mode, no broker credentials needed
```

Server on `http://localhost:3000`. For the dashboard:
`bun run --filter @ata/dashboard dev` (Vite on `:5173`, proxies `/api` and `/ws`).

Full install matrix — Docker, local, hosted, corporate proxy — and production
deployment: **[`docs/setup.md`](docs/setup.md)**.

## Documentation

| Document | What it holds |
|---|---|
| [`docs/product.md`](docs/product.md) | Why these strategies, how decisions are made, success criteria, risks, and the full 10-personality reference |
| [`docs/architecture.md`](docs/architecture.md) | System architecture, database schema, signal and evolution engines, API endpoints, backfill/replay/regime reference |
| [`docs/setup.md`](docs/setup.md) | Local development (four paths), troubleshooting, production deployment |
| [`docs/testing.md`](docs/testing.md) | Manual verification — numbered steps with expected values, plus the E2E catalogue |
| [`docs/roadmap.md`](docs/roadmap.md) | Task catalogue: what each T-number covers and what "done" meant |
| [`docs/ideas.md`](docs/ideas.md) | Candidate work that is not committed to — with the case against each |
| [`docs/algotest-execution-plan.md`](docs/algotest-execution-plan.md) | The AlgoTest execution loop: phases, API contract, decision log |
| [`docs/pending-actions.md`](docs/pending-actions.md) | Everything blocked on the repo owner |
| [`docs/runbooks/`](docs/runbooks/) | Operational procedures |
| [`docs/epics/`](docs/epics/) | Delivery records, one per completed epic — archival |

**Current status** lives in [`.claude/project/overview.md`](.claude/project/overview.md);
the stack, commands, layout and environment variables in
[`.claude/project/technical.md`](.claude/project/technical.md). Both are
auto-loaded into every Claude Code session, and both are the single source of
truth for what they cover — nothing here repeats them.

## Packages

| Path | Runtime | Purpose |
|---|---|---|
| `apps/server` | Bun | Fastify backend — ingestion, signals, personalities, paper execution |
| `apps/dashboard` | Bun / Vite | React dashboard |
| `packages/broker-login` | Node 20 | Daily AlgoTest broker login via Playwright + TOTP |
| `packages/contract-notes` | Node 20 | Contract-note emails → realised F&O P&L in a Google Sheet |
| `packages/option-backtesting` | Python 3.12 / uv | Strategy-research workbench — DSL, bar-by-bar engine, walk-forward, sweeps |
