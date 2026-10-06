# Backlog index

Rules and workflow: [README.md](README.md). New item: copy [_TEMPLATE.md](_TEMPLATE.md).
Committed work lives in [`../TODO.md`](../TODO.md).

Last updated: 2026-10-06

## Open

Sorted by priority (P0 first), then ID.

| ID | Title | Priority | Status | Type | Area |
|---|---|---|---|---|---|
| [BL-001](BL-001-momentum-result-integrity.md) | Momentum result integrity: goldens, parameter coverage, drift alerts | P0 | In progress | improvement | momentum |
| [BL-010](BL-010-momentum-evaluation-review.md) | Momentum evaluation review: prove the arithmetic, remove hindsight, fix selection | P0 | In progress | research | momentum |
| [BL-012](BL-012-scheduler-service.md) | Scheduler service: one home for every recurring ingestion and maintenance job (laptop now, hostable later) | P0 | In progress | feature | infra |
| [BL-014](BL-014-ci-and-merge-gates.md) | CI and merge gates: nothing reaches `main` while checks are red | P0 | In progress | chore | infra |
| [BL-024](BL-024-forward-signal-journal.md) | Forward-signal journal: record every weekly signal from now on | P0 | In progress | feature | momentum |
| [BL-034](BL-034-options-history-lake.md) | Options history lake: two years of vendor 1-minute data in `trading-data`, derived tables for straddle backtests, daily top-up | P0 | Planned | feature | trading-data |
| [BL-005](BL-005-faster-momentum-backtests.md) | Faster Momentum backtests (Broad: 55 s cold, 21 s warm) | P1 | Planned | improvement | momentum |
| [BL-009](BL-009-intraday-options-backtesting-platform.md) | Intraday options backtesting platform: AlgoTest-verified engine, vendor history, portfolios, event triggers, sweeps | P1 | Planned | feature | options |
| [BL-015](BL-015-research-gate.md) | Research gate: pre-register every experiment, log every override | P1 | Ready | chore | cross-cutting |
| [BL-021](BL-021-pro-readiness.md) | End of the Max month: make the project cheap to run on Pro | P1 | Ready | chore | cross-cutting |
| [BL-022](BL-022-analog-day-search.md) | "Days like today": analog-day search for intraday options | P1 | Idea | research | options |
| [BL-025](BL-025-live-money-rules.md) | Live-money rules for Momentum: written before the first rupee, enforced by alerts | P1 | Planned | feature | momentum |
| [BL-026](BL-026-realised-vs-backtest-options.md) | Options: realised P&L against the backtest of the same days | P1 | Planned | feature | options |
| [BL-029](BL-029-point-in-time-universe-in-ui.md) | Point-in-time universe as a choice on the Broad tab | P1 | Planned | feature | momentum |
| [BL-030](BL-030-choose-journal-favourites.md) | Choose the ~8 favourites to track and trade | P1 | Idea | research | momentum |
| [BL-035](BL-035-consolidation-tightness-feature.md) | Consolidation tightness as a Momentum ranking feature (the cheap "flag") | P1 | Idea | research | momentum |
| [BL-002](BL-002-vercel-dashboard-laptop-backend.md) | Go live: dashboard on Vercel, research backend on the laptop | P2 | Planned | chore | infra |
| [BL-003](BL-003-momentum-weekly-rebalance-loading.md) | Momentum: honest loading states on Weekly signal and Rebalance | P2 | Planned | improvement | dashboard |
| [BL-004](BL-004-research-stack-production-mode.md) | Production-build mode for the local research stack (`bun run start:prod`) | P2 | Planned | improvement | infra |
| [BL-008](BL-008-dashboard-e2e-suite-repair.md) | Repair the stale dashboard e2e suite and run it in CI | P2 | Planned | chore | dashboard |
| [BL-016](BL-016-validation-status-in-ui.md) | Show validation status and known assumptions next to every result | P2 | Planned | improvement | momentum |
| [BL-017](BL-017-momentum-settings-module.md) | Momentum: one settings module, and split `api.py` | P2 | Ready | improvement | momentum |
| [BL-018](BL-018-brittle-benchmark-tests.md) | Momentum benchmark tests fail when the data is refreshed | P2 | Planned | bug | momentum |
| [BL-020](BL-020-claude-code-workflow-setup.md) | Claude Code working set-up: model per role, saved commands, session habits | P2 | Ready | chore | cross-cutting |
| [BL-027](BL-027-rebalance-basket-file.md) | Weekly rebalance as a broker basket-order file | P2 | Planned | feature | momentum |
| [BL-031](BL-031-chart-pattern-detectors.md) | Classical chart-pattern detectors on weekly and daily stock data | P2 | Idea | research | momentum |
| [BL-032](BL-032-stock-analog-search.md) | "Stocks like this": analog-path search for six-month stock outcomes | P2 | Idea | research | momentum |
| [BL-033](BL-033-pattern-features-in-ranking.md) | Pattern and analog features in the Momentum ranking | P2 | Idea | feature | momentum |
| [BL-006](BL-006-momentum-scores-table-responsiveness.md) | Momentum Scores table: responsive sort and filter | P3 | Planned | improvement | dashboard |
| [BL-007](BL-007-momentum-ui-polish.md) | Momentum UI polish from the 2026-10-04 review | P3 | Planned | improvement | dashboard |
| [BL-023](BL-023-personalities-over-history.md) | Personalities as strategy-plus-filters over historical data | P3 | Idea | research | options |
| [BL-028](BL-028-month-3-workbench-decision.md) | Month-3 decision: is the workbench worth offering beyond friends? | P3 | Planned | research | cross-cutting |

## Done / Dropped

| ID | Title | Outcome | Closed |
|---|---|---|---|
| [BL-019](BL-019-product-focus-and-freeze.md) | Product focus: rewrite the overview, freeze the dormant parts | Done: overview and business rewritten; personality engine, payments and TODO §3.1–3.4, 3.7 marked frozen | 2026-10-06 |
| [BL-011](BL-011-laptop-scheduler.md) | Laptop as scheduler: broker login at 08:00 (Phases 2–4 moved to BL-012) | Done: 08:00 IST dispatch verified on 5 and 6 Oct; the rest continues as BL-012 | 2026-10-06 |
| [BL-013](BL-013-dashboard-redesign.md) | Dashboard redesign: design system, shell, and per-tab UX for Momentum and Options Lab | Done: Phases 1–8 shipped; Phase 9 parked | 2026-10-05 |
