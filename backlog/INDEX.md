# Backlog index

Rules and workflow: [README.md](README.md). New item: copy [_TEMPLATE.md](_TEMPLATE.md).
Committed work lives in [`../TODO.md`](../TODO.md).

Last updated: 2026-10-09

## Open

Sorted by priority (P0 first), then ID.

| ID | Title | Priority | Status | Type | Area |
|---|---|---|---|---|---|
| [BL-001](BL-001-momentum-result-integrity.md) | Momentum result integrity: goldens, parameter coverage, drift alerts | P0 | In progress | improvement | momentum |
| [BL-010](BL-010-momentum-evaluation-review.md) | Momentum evaluation review: prove the arithmetic, remove hindsight, fix selection | P0 | In progress | research | momentum |
| [BL-012](BL-012-scheduler-service.md) | Scheduler service: one home for every recurring ingestion and maintenance job (laptop now, hostable later) | P0 | In progress | feature | infra |
| [BL-014](BL-014-ci-and-merge-gates.md) | CI and merge gates: nothing reaches `main` while checks are red | P0 | In progress | chore | infra |
| [BL-024](BL-024-forward-signal-journal.md) | Forward-signal journal: record every weekly signal from now on | P0 | In progress | feature | momentum |
| [BL-034](BL-034-options-history-lake.md) | Options history lake: two years of vendor 1-minute data in `trading-data`, derived tables for straddle backtests, daily top-up | P0 | In progress | feature | trading-data |
| [BL-058](BL-058-options-rotation-forward-journal-and-ui.md) | Options rotation: forward paper journal from Mon 12 Oct (picks recorded before 09:17, scored nightly) and the Options Lab screens it needs | P0 | Planned | feature | options |
| [BL-009](BL-009-intraday-options-backtesting-platform.md) | Intraday options backtesting platform: AlgoTest-verified engine, vendor history, portfolios, event triggers, sweeps | P1 | Planned | feature | options |
| [BL-015](BL-015-research-gate.md) | Research gate: pre-register every experiment, log every override | P1 | In progress | chore | cross-cutting |
| [BL-021](BL-021-pro-readiness.md) | End of the Max month: make the project cheap to run on Pro | P1 | Ready | chore | cross-cutting |
| [BL-022](BL-022-analog-day-search.md) | "Days like today": analog-day search for intraday options | P1 | Idea | research | options |
| [BL-025](BL-025-live-money-rules.md) | Live-money rules for Momentum: written before the first rupee, enforced by alerts | P1 | In progress | feature | momentum |
| [BL-026](BL-026-realised-vs-backtest-options.md) | Options: realised P&L against the backtest of the same days | P1 | Planned | feature | options |
| [BL-029](BL-029-point-in-time-universe-in-ui.md) | Point-in-time universe as a choice on the Broad tab | P1 | Planned | feature | momentum |
| [BL-030](BL-030-choose-journal-favourites.md) | Choose the ~8 favourites to track and trade | P1 | Idea | research | momentum |
| [BL-035](BL-035-consolidation-tightness-feature.md) | Consolidation tightness as a Momentum ranking feature (the cheap "flag") | P1 | Idea | research | momentum |
| [BL-038](BL-038-monthly-expiry-stock-options-collection.md) | Collect every F&O stock's options on its monthly expiry day, from Fyers, from October 2026 | P1 | Planned | feature | options |
| [BL-040](BL-040-fill-the-vendor-gap-from-algotest.md) | Fill the vendor gap (26 Aug – 24 Sep 2026) from AlgoTest, for every index and stock (on hold: owner asks the vendor first) | P1 | Planned | feature | trading-data |
| [BL-044](BL-044-local-service-auth-and-network-hardening.md) | Local-service auth and network hardening: Host/Origin guards, OAuth state bound to the browser, an internal token, tunnel checks | P1 | Planned | improvement | cross-cutting |
| [BL-050](BL-050-momentum-filter-poc.md) | Momentum filter POC: volume, relative strength, overextension, residual momentum, trend quality (Broad only) | P1 | Planned | research | momentum |
| [BL-051](BL-051-momentum-this-week-and-journal.md) | Momentum "This week" and Journal redesign: favourite statuses, Friday timeline, orders from Fyers holdings, alerts | P1 | In progress | feature | momentum |
| [BL-002](BL-002-vercel-dashboard-laptop-backend.md) | Go live: dashboard on Vercel, research backend on the laptop | P2 | Planned | chore | infra |
| [BL-039](BL-039-broad-warm-path-and-weekly-job-cost.md) | Broad warm path and weekly-job cost (follow-up to BL-005) | P2 | Planned | improvement | momentum |
| [BL-041](BL-041-in-app-guide.md) | In-app Guide: what each dashboard section does and how to use it | P2 | In progress | feature | dashboard |
| [BL-036](BL-036-momentum-ui-from-bl010.md) | Momentum dashboard: what the BL-010 review changes on screen | P2 | Planned | improvement | dashboard |
| [BL-008](BL-008-dashboard-e2e-suite-repair.md) | Repair the stale dashboard e2e suite and run it in CI | P2 | Planned | chore | dashboard |
| [BL-016](BL-016-validation-status-in-ui.md) | Show validation status and known assumptions next to every result | P2 | Planned | improvement | momentum |
| [BL-017](BL-017-momentum-settings-module.md) | Momentum: one settings module, and split `api.py` | P2 | Ready | improvement | momentum |
| [BL-020](BL-020-claude-code-workflow-setup.md) | Claude Code working set-up: model per role, saved commands, session habits | P2 | Ready | chore | cross-cutting |
| [BL-031](BL-031-chart-pattern-detectors.md) | Classical chart-pattern detectors on weekly and daily stock data | P2 | Idea | research | momentum |
| [BL-032](BL-032-stock-analog-search.md) | "Stocks like this": analog-path search for six-month stock outcomes | P2 | Idea | research | momentum |
| [BL-033](BL-033-pattern-features-in-ranking.md) | Pattern and analog features in the Momentum ranking | P2 | Idea | feature | momentum |
| [BL-043](BL-043-daily-pattern-trading-system.md) | Daily pattern trading system: scored entries, stop-loss, target, a health switch | P2 | In progress | research | momentum |
| [BL-045](BL-045-dashboard-load-diet.md) | Dashboard load diet: code-split views and the Guide, landing tab before mount, last hand-rolled fetches | P2 | Planned | improvement | dashboard |
| [BL-046](BL-046-options-api-performance.md) | Options API performance: bounded anatomy/backtest/results loads, reused connections, streamed proxies | P2 | Planned | improvement | options |
| [BL-047](BL-047-shared-python-plumbing-and-job-locks.md) | Shared Python plumbing in `trading-data` (token, `.env`, notify, IST) and cross-process job locks | P2 | Planned | improvement | trading-data |
| [BL-053](BL-053-vix-at-10am-strategy-mix.md) | Pick the NIFTY strategy mix at 10:00 from India VIX's first 45 minutes | P2 | Done: killed | research | options |
| [BL-054](BL-054-weekly-strategy-slot-rotation.md) | Weekly rotation of NIFTY strategy start times: rank 33 variants on two weeks' P&L, hold the top 5 Widesl/Dir (≥2 Widesl) plus 2 Buy when Buy is positive (POC) | P2 | Done: killed | research | options |
| [BL-055](BL-055-daily-portfolio-stop-loss.md) | Daily portfolio stop-loss (₹8k / ₹10k / ₹12.5k) on the NIFTY benchmark mixes: worst days, drawdown, cost in profit | P2 | Done: inconclusive | research | options |
| [BL-056](BL-056-weekday-dte-vix-breakdown.md) | Weekday, days-to-expiry and VIX-band breakdown of the 33 start-time variants, NIFTY and SENSEX | P2 | Done: descriptive | research | options |
| [BL-059](BL-059-whole-day-start-time-curve.md) | Whole-day start-time curve: NIFTY and SENSEX Widesl, Dir ATM and Buy from 12:02 to 15:02 (78 more variants) | P2 | Done: descriptive | research | options |
| [BL-060](BL-060-sensex-widesl-closest-premium.md) | SENSEX Widesl by closest premium (₹250 and ₹320) across the whole day, beside the live OTM2 strike | P2 | Done: descriptive | research | options |
| [BL-061](BL-061-rotation-with-closest-premium-widesl.md) | Daily rotation with closest-premium Widesl in the candidate list: their share of the 5 daily lots, and on which days | P2 | Done: descriptive | research | options |
| [BL-062](BL-062-whole-day-rotation.md) | Daily rotation over the whole day (start times 09:17 to 15:17, 248 variants) with closest-premium Widesl | P2 | Done: passes (exploratory) | research | options |
| [BL-063](BL-063-rotation-after-charges.md) | The rotations after brokerage (₹13 a lot) and statutory charges (STT, exchange, GST …) | P2 | In progress | research | options |
| [BL-057](BL-057-daily-four-criteria-rotation.md) | Daily four-criteria rotation (recent P&L, weekday, days-to-expiry, VIX fit) over the 66 NIFTY + SENSEX variants (POC) | P2 | Done: inconclusive | research | options |
| [BL-007](BL-007-momentum-ui-polish.md) | Momentum UI polish from the 2026-10-04 review | P3 | Planned | improvement | dashboard |
| [BL-023](BL-023-personalities-over-history.md) | Personalities as strategy-plus-filters over historical data | P3 | Idea | research | options |
| [BL-028](BL-028-month-3-workbench-decision.md) | Month-3 decision: is the workbench worth offering beyond friends? | P3 | Planned | research | cross-cutting |
| [BL-037](BL-037-stock-options-in-the-lake.md) | Stock options in the lake: finish loading the vendor's 216 stocks (deferred) | P3 | Planned | feature | trading-data |
| [BL-048](BL-048-dormant-server-surfaces.md) | Dormant surfaces: test-only server, broken personality edit, unwritten regime tags, the YAML engine's future | P3 | Planned | chore | server |

## Done / Dropped

| ID | Title | Outcome | Closed |
|---|---|---|---|
| [BL-052](BL-052-momentum-saved-runs-redesign.md) | Momentum Saved runs: one row per strategy, why a result moved, findings | Done: one strategy per normalised set of settings, run fingerprints and the why-it-moved log, the merge (applied live), the strategies page and drawer, findings; Phases 1–3 merged (#138, #139, Phase 3 PR). Follow-ups in its Log | 2026-10-08 |
| [BL-003](BL-003-momentum-weekly-rebalance-loading.md) | Momentum: honest loading states on Weekly signal and Rebalance | Superseded by BL-051: its findings are Phase 2's loading-state task on the merged This week page | 2026-10-08 |
| [BL-027](BL-027-rebalance-basket-file.md) | Weekly rebalance as a broker basket-order file | Superseded by BL-051: Fyers basket file and recorded fills are its Phase 4; broker answered (Fyers) | 2026-10-08 |
| [BL-049](BL-049-momentum-scores-redesign.md) | Momentum Scores redesign: market strip, sector rotation map, 1–10 score strips, stock drawer | Done: Sectors and Stocks views, rotation map, sector page, stock drawer, saved views, circuit locks and the strip guide; Phases 1–3 and review fixes merged (#124, #126–#128) | 2026-10-08 |
| [BL-006](BL-006-momentum-scores-table-responsiveness.md) | Momentum Scores table: responsive sort and filter | Superseded by BL-049: paged, memoised rows with a deferred filter are in its Phase 1 | 2026-10-07 |
| [BL-018](BL-018-brittle-benchmark-tests.md) | Momentum tests fail when the live data is refreshed | Done: six data-dependent tests fixed (sessions checked against the bhavcopy calendar, isolated reference tests, current list matched to a curated day, tax classes over priced companies); tests only | 2026-10-07 |
| [BL-004](BL-004-research-stack-production-mode.md) | Production-build mode for the local research stack (`bun run start:prod`) | Done: `bun run start:prod` serves a password-gated production build on 127.0.0.1:5190, rebuilt only on change (restart 4.2 s); page shell 3.5–4.9 s → ~0.1 s, JS 4.8 MB → 437 KB. Pages still wait 17–20 s on slow Momentum API calls (PRs #101/#104), so the ≤ 1.5 s goal is unmet on live data | 2026-10-07 |
| [BL-042](BL-042-chart-pattern-poc.md) | Chart-pattern POC for Momentum: tight range, flag, cup and handle | Informative, not adopted: no pattern beat momentum-matched peers; PBO 0.57 over 24 ranking trials; hold-out unread, passed to BL-043 | 2026-10-07 |
| [BL-005](BL-005-faster-momentum-backtests.md) | Faster Momentum backtests (Broad: 55 s cold, 21 s warm) | Done: Phases 1–4 merged, results identical; identical re-run 62 s → 0.0 s, ETF/Stock 3–4× faster; the warm-Broad goal was missed on real data, so the rest moved to BL-039 | 2026-10-07 |
| [BL-019](BL-019-product-focus-and-freeze.md) | Product focus: rewrite the overview, freeze the dormant parts | Done: overview and business rewritten; personality engine, payments and TODO §3.1–3.4, 3.7 marked frozen | 2026-10-06 |
| [BL-011](BL-011-laptop-scheduler.md) | Laptop as scheduler: broker login at 08:00 (Phases 2–4 moved to BL-012) | Done: 08:00 IST dispatch verified on 5 and 6 Oct; the rest continues as BL-012 | 2026-10-06 |
| [BL-013](BL-013-dashboard-redesign.md) | Dashboard redesign: design system, shell, and per-tab UX for Momentum and Options Lab | Done: Phases 1–8 shipped; Phase 9 parked | 2026-10-05 |
