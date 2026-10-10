# BL-029 — Point-in-time universe as a choice on the Broad tab

| | |
|---|---|
| **Priority** | P1 — a default Broad run still shows a number inflated by hindsight; BL-010 Phase 3 measured the inflation at a median 22–25 points for the best configs |
| **Status** | Done (delivered by BL-036 Phase 1) |
| **Type** | feature |
| **Area** | momentum, dashboard |
| **Created** | 2026-10-06 |
| **Depends on** | BL-010 Phase 3 (the universe exists in code); BL-001 (the new choice needs a frozen scenario) |
| **TODO.md row** | — (filled in when started) |

## Context

BL-010 Phase 3 built a point-in-time universe for Broad Momentum: for each year, the 750
most-traded stocks on the six months before it started, delisted names included
(`categories/liquidity.py::turnover_rank_members_by_year`, `broad` universe `turnover_rank`).
The stored Total Market list is today's 755 names applied to every year since 2017, so a
backtest on it can only ever buy companies that survived to 2026 (BL-010 finding F1). In 2017,
405 of the 750 point-in-time names are missing from today's list.

On the point-in-time universe the 50 best round 7 configs lose a median 22 to 25 points of
CAGR, and 45 of 50 lose more than 10 (`packages/momentum-backtesting/docs/evaluation-review.md`,
Phase 3). Today the universe is reachable only from the research commands
(`mbt search pit-rerun`, `mbt search score --universe turnover_rank`); the API rejects it and
the dashboard does not offer it. The Broad result carries an "upper bound, not an expected
return" warning (PR #19) because of exactly this.

## Goal

A Broad run on the dashboard can use the point-in-time universe, and its result says which
universe it used.

## Out of scope

- The universe's definition (most-traded as a stand-in for NSE's free-float market value);
  revisit only if market-cap data is added.
- Point-in-time category tags (BL-010 Phase 3 step 3, launch-dated taxonomy).
- Re-running saved favourites on the new universe; a saved run keeps its own setting.

## Plan

### Phase 1 — The choice
- **Tasks:** add `turnover_rank` to `BacktestRequest.broad_universe`; a third option in the
  Broad settings panel's Universe selector, labelled for what it is ("As each year saw it");
  show the universe on the result card and in Saved runs; the upper-bound warning no longer
  claims "today's list" for a point-in-time run; a frozen scenario in BL-001's suite (the
  coverage test requires it); `technical.md` and the package docs.
- **Deliverables:** API and dashboard change, tests, one accepted golden scenario.
- **Done when:** a dashboard run on the new universe matches `mbt search pit-rerun` for the
  same config, and the coverage test passes.

### Phase 2 — The default (only if the owner chooses it)
- **Tasks:** make it the dataset default for new Broad runs (`_broad_meta` defaults and the
  dashboard fallback), as PR #19 did for circuit locks; record the default run's CAGR before
  and after.
- **Done when:** a fresh Broad run uses it and saved runs re-run unchanged.

## Risks

- **Slower first run:** the point-in-time universe has about 1,700 distinct names since 2016
  against 755; the ranking cache is per universe. Measure before and after.
- **Curated category tags name only today's 755 stocks**, so in category mode a stock that
  later left the index can be ranked but never picked through a category. Say so next to the
  option, or offer it with the extended tags (BL-010 Phase 3 measured both).

## Open questions

1. **The default for a new Broad run:** keep Total Market (today's list) and add point in time
   as an option, or make point in time the default? Recommended: the default, because the
   upper-bound warning exists for this reason. A default run's CAGR drops by roughly 20 points;
   saved runs keep their own universe.
2. Curated or extended category tags with the point-in-time universe in category mode?

## Log

- 2026-10-06 — created from the BL-010 Phase 3 discussion; the owner chose to plan it now and
  build it later.
- 2026-10-10 — folded into BL-036 Phase 1 and delivered there: Phase 1 (the choice: a third universe
  card, the universe on the result and in Saved runs, a warning that no longer blames the stock list)
  and Phase 2 (the default). Open question 1 answered: point in time is the default; a default run
  went from 41.4% to 33.3% a year. Open question 2 answered: curated tags stay the request default,
  and the extended-tags figure is always computed beside it (BL-036). The golden-scenario deliverable
  is dropped: the fixture cannot build a turnover rank (see BL-036).
