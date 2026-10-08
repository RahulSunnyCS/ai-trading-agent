# BL-053 — Weekly stop-loss on the Broad Momentum strategies

| | |
|---|---|
| **Priority** | P1 — the owner wants a drawdown rule before real money goes in, and the top configs trade only every 4 weeks |
| **Status** | In progress |
| **Type** | research (+ an opt-in engine feature) |
| **Area** | momentum |
| **Created** | 2026-10-08 |
| **Depends on** | BL-010 (the scored configs, the frozen ensemble, the criteria machinery) |
| **TODO.md row** | 3.13.6 |

## Context

The ten best Broad configs by the 2026-10-08 composite ranking
(`packages/momentum-backtesting/docs/top-strategies-2026-10-08.md`) mostly rebalance every 4
weeks and hold 4-6 stocks, so one stock falling 30% costs the portfolio 6-8 points before the
next rebalance can react. The owner asked (2026-10-08): check every Friday, sell a holding that
is 20% below its buy price or 30% below its peak (both configurable), and either hold the money
as cash or put it into the top stock (configurable).

The engine had no stop. `sell_every_week` sells off-cycle only on rank.

## Goal

A pre-registered answer to "does a weekly stop improve these strategies' falls without costing
more than 2 points of CAGR", and an opt-in engine stop that is off by default.

## Out of scope

Tuning a stop per strategy; a cool-down before re-buying; after-tax runs; the dashboard and the
live weekly signal (a separate item if the stop is adopted).

## Plan

### Phase 0 — Pre-register (committed before any run)

The binding rule is `packages/momentum-backtesting/search_spaces/bl053_criteria.json`. In words:

- **Hypothesis:** a weekly stop on each holding (from the buy price, from the peak, or both)
  makes the falls of these strategies shallower while costing at most 2 points of CAGR.
- **Universe:** the 10 top-ranked round 7 arm A configs and the frozen Phase 6 ensemble (11),
  on the point-in-time `turnover_rank` universe with curated tags, pre-tax at Rs 2 lakh, the
  space's fixed settings, 2017-01-01 to 2026-10-02. Each config on every rebalance phase,
  blended; the ensemble at its frozen phases.
- **Grid:** stop from buy off / 15 / 20 / 25%; from peak off / 20 / 25 / 30%; proceeds to cash
  or to the best-ranked stock not held. 30 cells.
- **Fill timing (owner chose Monday open):** the engine fills Broad only at a Friday close, so
  each cell runs twice: selling at the close the fall is seen on (optimistic) and at the next
  Friday close (pessimistic). A Monday open lies between them; a cell must pass at both. A
  Monday-open replay of the ensemble's sleeves is reported, not judged.
- **Look-ahead check:** the stop reads only closes up to the week it acts on
  (`tests/test_stop_loss.py::test_the_stop_uses_no_later_prices`); the peak is the highest
  weekly close since the first buy.
- **Pass / kill rule (owner, 2026-10-08):** per cell, Ulcer index and max drawdown both shallower
  than the baseline's in at least 7 of 11 strategies; the median CAGR change at least -2
  points; the median third-worst-FY excess over Nifty200 Momentum 30 TRI not lower than the
  baseline's. Verdict: helps if 10 or more of 30 cells pass; 1-9 inconclusive (named, not
  adopted); none, killed.
- **Hold-out:** 2012-2016 stays sealed; no data after 2026-10-02.
- **Will not run:** other thresholds, a re-buy cool-down, per-strategy tuning, after-tax runs.
- **Known bias:** the 11 strategies were chosen without a stop and on today's curated tags. The
  test is stop against no stop on the same strategies, so the bias largely cancels, but the
  absolute numbers are upper estimates.

### Phase 1 — Engine stop
- **Tasks:** `Config.stop_from_buy`, `stop_from_peak`, `stop_proceeds`, `stop_delay` (buffer rule,
  off by default), threaded through `broad.run_broad_backtest`; tests.
- **Done when:** the goldens are unchanged and `tests/test_stop_loss.py` passes.

### Phase 2 — The grid
- **Tasks:** `scripts/bl053_stop_loss.py` runs baseline + 30 cells x 2 delays on the 11
  strategies, applies the rule and writes `data/search/round7_A/bl053/report.md`.
- **Done when:** the verdict is recorded here and in `bl053_result.json`.

## Risks

- Thirty cells is a search: some can pass by chance. The 10-of-30 rule guards against reading
  one lucky cell.
- Whipsaw: a stopped stock still top-ranked is bought back at the next rebalance.

## Log

- 2026-10-08 — created and started; owner accepted the grid, the pass rule, Monday-open timing
  (bracketed as above) and this branch. Phase 0 committed before any run.
