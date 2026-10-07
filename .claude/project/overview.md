# Project Overview

**AI Trading Agent** (`ai-trading-agent`) is a personal research workbench for Indian markets
(NSE/BSE): weekly momentum rotation, and intraday index-options strategies backtested on
collected 1-minute data. It does not place orders. Real trades are placed by hand or by the
owner's own strategies on AlgoTest. This repo logs the brokers into AlgoTest, records realised
P&L from contract notes, and measures strategies against it.

## Who uses it

The owner, plus two or three friends who see the Momentum results. There are no paying users,
and none are planned for now (`business.md`).

- **This month (from 2026-10-06):** finish the Momentum strategy to a standard the owner will
  put real money behind (BL-010, BL-001, BL-024, BL-025).
- **Next 2–3 months:** the options and momentum research workbench, used by the same few
  people, to learn what to improve (BL-028 decides whether it goes further).
- **Later, undecided:** personalities running over the backtest data (BL-023).

## Active

| Area | Where | What it is |
|---|---|---|
| Momentum | `packages/momentum-backtesting` | Weekly rotation across indices, ETFs and survivorship-free Nifty 50 stocks; Custom Index and Broad Momentum; Friday Telegram signal; forward-signal journal. Detail: the package's `CLAUDE.md` |
| Options research | `packages/option-backtesting` | YAML strategy DSL and bar-by-bar engine (golden-verified to the rupee); leg-wise AlgoTest-style backtests over daily-collected Fyers 1-minute data (`obt daily`); walk-forward, sweeps, overfitting guard; FastAPI + MCP server |
| Research database | `packages/trading-data` | DuckDB catalog + Parquet lake under `TRADING_DATA_ROOT`, shared by both research packages |
| Dashboard | `apps/dashboard` | Next.js: Overview, Options Lab, Momentum, Data › Coverage, Broker logins, Settings, and a Guide (plain-English docs for every screen, a glossary and walkthroughs); behind `/login` when hosted remotely. Talks to the research APIs through Fastify proxies or direct rewrites |
| Broker login | `packages/broker-login` | Daily AlgoTest login (Angel One, Finvasia) and headless Fyers token, triggered from the laptop at 08:00/08:05 IST |
| Contract notes | `packages/contract-notes` | Gmail → PDF → Google Sheet realised F&O P&L. Cutover from the `trade-analytics` repo pending (TODO §2) |
| Scheduler | `apps/scheduler` (BL-012; built, awaiting install) | Runs 19 recurring jobs from one launchd-kept process — logins, the 09:00 morning summary, `obt daily`, Friday momentum, the monthly backup, alert-only data checks and a Saturday digest — with run history, catch-up after sleep, Telegram alerts, a loopback API and dashboard Jobs / Telegram-alerts pages; replaced the per-job launchd plists in `deploy/launchd/` |

`apps/server` stays active only as the host of the Fastify proxies (`/api/backtest/*`,
`/api/momentum/*`) and the Fyers OAuth routes; its trading engine is frozen (below).

## Frozen

Kept, type-checked and tested in CI (Razorpay included), bug fixes only, **not extended**. Unfreeze
only when a research result gives a validated edge to build on, and record that decision in
`TODO.md`.

- **Personality engine** — `apps/server/src/trading/`: the 10 personalities, 5-stage filter,
  peak detection, paper-trade execution, Clockwork benchmark.
- **Retrospection and evolution** — `apps/server/src/retrospection/`,
  `jobs/eod-retrospection-job.ts`; T-51 replay in `src/backtesting/`. Built, but only their
  presence is recorded, not an audit of their completeness (TODO 3.3.0).
- **Payments** — Razorpay orders, webhook, credits and the access gate (`business.md`).
- **The AlgoTest execution loop built on the personalities** — Telegram approval gate,
  strategy activation, signal measurement and live execution (TODO §3.1–3.4), and the later
  personality milestones (§3.7).

Delivery history for these parts: `docs/epics.md`. Task catalogue: `docs/roadmap.md`.

## Start here

| Document | What it holds |
|---|---|
| **`TODO.md`** | The single source of truth for every open work item |
| `backlog/INDEX.md` | Ideas and plans not yet committed to |
| `docs/algotest-execution.md` | Reference: the verified AlgoTest API contract, decision log, contract-notes cutover runbook |
| `docs/roadmap.md` | Reference: the T-number task catalogue and the case for and against each uncommitted idea |
| `docs/epics.md` | Permanent delivery record |

Nothing trades live from this repo. Probability scores in the frozen engine are not calibrated;
Momentum and options results count only once their validation (BL-010, BL-001) passes.

## Project File Maintenance

Update the relevant `.claude/project/` file in the same commit as the code change that affects it:

- **`overview.md` (this file):** when the product, its users, or the active/frozen split changes.
- **`business.md`:** when users, pricing, payment processors or compliance obligations change.
- **`technical.md`:** when the tech stack, commands, repository structure, conventions or
  environment variables change.

One fact lives in one file. Never duplicate across the three files.
