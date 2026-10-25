# Broad Momentum (stock funnel)

> **Caveat, 2026-10-25 (BL-001 F6):** every Broad figure on these pages was measured with a ranking whose cross-section included stocks that were not members that week, so a past week's ranks depended on later data. Fixed on branch `fix/momentum-f6-point-in-time-ranking` (not yet merged): on live data the followed strategy's headline CAGR fell from 42.9% to 35.0% and most favourites lost 3.5 to 10 points; see `packages/momentum-backtesting/docs/lookahead-requests-2026-10-24.md`. The pages have not been re-measured.

**Last updated:** 2026-10-14

## What it is

A weekly stock-picking funnel over a large NSE stock universe. Three sieves: a quarterly pool of
the strongest stocks (top 200 of about 750), the strongest categories inside that pool (top 4,
each with at least 40% of its members in the pool), then the top 2 stocks of each held category.
With category mode off it ranks pool stocks directly (top 10, exit 20).

## Where it lives in code

- `packages/momentum-backtesting/src/momentum_backtesting/categories/broad.py`:
  `run_broad_backtest`, the funnel and its `DEFAULT_*` constants.
- `categories/liquidity.py` (tradability gate, `turnover_rank` universe), `categories/prices.py`
  (stock price series), `engine.py` (the shared backtest engine underneath).
- `api.py` (`_broad_backtest`, `BacktestRequest.broad_*` fields); `search.py`, `criteria.py`,
  `choose.py`, `phase5.py`, `phase6.py`, `tracker.py` (the BL-010 search and selection machinery).
- Search spaces and committed criteria: `packages/momentum-backtesting/search_spaces/`.

## Defaults (a new dashboard run)

Point-in-time `turnover_rank` universe with the tradability gate on, circuit-lock fills on,
every week simulated, curated category tags; pool 200 / 250, coverage 0.40, categories 4 / 8,
2 picks; 15% per stock, 30% per category, Rs 20,000 price ceiling; weekly; signal delay 0;
Friday-close fills. (`api.py` meta defaults, `categories/broad.py`.)

The search spaces and the frozen ensemble instead pin `signal_delay = 1`, itemised costs with
15 bps slippage, Rs 2 lakh capital and a Rs 10,000 ceiling
([`round7_A.toml`](../../../../packages/momentum-backtesting/search_spaces/round7_A.toml)).

## Variable pages that apply

Broad-only pages (this folder):
[simulate every week](min-ranked.md) · [funnel](funnel.md) · [category tags](category-tags.md) ·
[stop-loss](stop.md) · [stock filters](filters.md) · [chart patterns](patterns.md)

Shared pages: [universe](../../common/universe.md) · [benchmarks](../../common/benchmarks.md) ·
[lookbacks](../../common/lookbacks.md) · [skip-month](../../common/skip-month.md) ·
[score](../../common/score.md) · [portfolio rule and entry](../../common/portfolio-entry.md) ·
[caps](../../common/caps.md) · [gates](../../common/gates.md) · [sizing](../../common/sizing.md) ·
[costs](../../common/costs.md) · [tax](../../common/tax.md) · [execution](../../common/execution.md) ·
[cadence](../../common/cadence.md) · [reversal sleeve](../../common/reversal-sleeve.md)

## Strategy-specific findings

**Baselines.**

- 2026-10-01 dry run (TODO 3.9.23), the dashboard defaults of that date, every week simulated: 31.7% / 1.06 / -20.4% full (2017-01 to 2026-09), 31.5% / 1.06 / -19.1% last 5 years,
  30.2% / 0.99 / -19.1% last 3 years. It buys about 115 names a year with a 3.6-week average hold.
- Default run, 2026-10-10 (BL-036): today's list 41.4%, point in time 33.3% (worst fall -33.6%),
  extended tags 24.2%. Circuit locks and the tradability filter have been on since 2026-10-05 and
  the engine has been fixed since, so this is not comparable with the 3.9.23 baseline.
- BL-085 baseline, after tax at Rs 5 lakh, median of 11 strategies: 29.9% (FY2018-22) and 32.4%
  (FY2023-26); before tax 38.3% and 41.2%.

**The BL-010 evaluation review** ([BL-010](../../../../backlog/BL-010-momentum-evaluation-review.md)):

- The round 7 headline of 55-63% CAGR was not a believable expected return. The point-in-time
  universe cut the 50 best configs by a median 22-25 points ([universe](../../common/universe.md)).
- Picking "the best" config does not persist. Arm A: rank correlation between first-half and
  second-half CAGR -0.08 (F4). PBO 0.48 on today's list, 0.69 point in time: the single-winner
  rule is killed.
- Phase 5's committed choice rule failed its walk-forward in all three baskets (picks 18.6% /
  28.5% / 28.5% against a median config of 31-32% and Mom30 TRI 15%, FY2020-FY2026, pre-tax). No
  config named.
- Phase 6: an ensemble of four typical configs (equal capital, reset each April) passed its own
  walk-forward (36.7% a year against 32.6% for the group's median config and 15.0% for Mom30 TRI)
  and was frozen: full history 32.3% a year, max drawdown -31.5%
  ([`bl010_phase6_frozen.json`](../../../../packages/momentum-backtesting/search_spaces/bl010_phase6_frozen.json)).
- **The one-shot 2012-2016 backcast failed:** ensemble 20.1% a year, worst fall -24.0%, against
  Nifty 500 TRI 12.3% (+7.8) and Nifty Midcap 150 TRI 17.7% (+2.5; +5 was needed against both)
  ([`bl010_phase6_backcast_result.json`](../../../../packages/momentum-backtesting/search_spaces/bl010_phase6_backcast_result.json),
  rule in [`bl010_criteria_addendum_5.json`](../../../../packages/momentum-backtesting/search_spaces/bl010_criteria_addendum_5.json)).
  In-sample 32% a year, unseen 20%, against 21% for Nifty200 Momentum 30 TRI.
- Default realism (BL-010 Log, 2026-10-05, today's list): 53.2% as shipped; 48.7% with circuit
  locks; 41.3% with the tradability filter; 40.4% with both. Circuit locks and the tradability
  filter are now on for a new run.
- Concentration: the top five companies are 42-81% of the compounded return in the six Phase 2
  configs; CUPID alone 17-33% (F17).
- Paper tracking of the frozen ensemble (`mbt search track`) is built but waits for the owner.

**Levers that won on Broad in 2026-10-01 (TODO 3.9.23):** trading every 2 or 4 weeks, or a
one-week signal delay (+4 to +5 points, better Sharpe in 89-100% of windows; prefer the 2-tranche
blend or every 4 weeks); `picks_per_category=3` (+3.0). Everything tested since (stops, filters,
patterns, sizing, residual momentum, lookback-following `voladj`, slower cadences, ETF blend) was
killed.

## In plain words

Broad looks at the whole stock market, keeps the strongest few hundred, finds the sectors where
many of them cluster, and buys the best two stocks in each of the top sectors. Its backtest
numbers are high, but they are upper estimates: the sector list is today's, and a strategy frozen
on 2017-2026 made much less on the unseen 2012-2016 years.

## Related

- [ETF rotation](../etf-rotation/README.md), [Custom Index](../custom-index/README.md),
  [Stock](../stock/README.md), [index](../../README.md).
