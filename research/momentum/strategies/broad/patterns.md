# Broad Momentum: chart patterns (tight range, flag, cup and handle)

**Status:** Tested · **Last updated:** 2026-10-28

## What it is

Detect chart patterns on daily stock bars and use them either to re-rank the Broad pool (BL-042)
or as a separate daily swing system on the same point-in-time universe (BL-043). Stocks only:
index and ETF series have no highs, lows or volume. Code: `momentum_backtesting/patterns/`
(`tight_range.py`, `flag.py`, `cup_handle.py`, `ranking.py`, `swing/`).

| Pattern | How it is identified (frozen detectors, BL-042 addendum 2) |
|---|---|
| Tight range / VCP | Prior uptrend; the last 3 / 5 / 8 weeks' high-low range small relative to price and to the stock's own usual range; optional volume dry-up |
| Bull flag / pennant (and high tight flag) | A sharp pole, then a shallow, quiet pullback in an uptrend |
| Cup and handle | Prior advance, a U-shaped cup, a handle of at least 2 weeks in the upper half; the left lip the highest high of the 26 weeks up to it |

Every pattern must sit within 25% of its 52-week high. States: forming, near pivot, broke out.
Full starting rules: [`bl042_criteria.json`](../../../../packages/momentum-backtesting/search_spaces/bl042_criteria.json).

## Live value

None. The default ranking, favourites, goldens and the Friday signal were untouched.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| [BL-042](../../../../backlog/BL-042-chart-pattern-poc.md) gallery (Phase 3) | owner labels 159 of 165 charts cut at the detection date | 2011-2023 | Detectors fixed, no pattern dropped | Tight range 34 / 34 correct, flag 26 / 30, cup 19 / 23. [`bl042_criteria_addendum_2.json`](../../../../packages/momentum-backtesting/search_spaces/bl042_criteria_addendum_2.json) |
| BL-042 Phase 2b (ranks only) | momentum rank while a base forms | development window | Pattern stocks rarely reach Broad's buys | At detection only 1-2% of bases are in the pool's top 20; most sit in the market's upper third but outside the pool's top 40 |
| BL-042 event study (Phase 4) | 13-week excess over momentum-decile-matched peers, Holm across 9 tests | 2012-2023 | **Kill, all three** | Tight range +0.18% (t 0.29), flag +0.28% (t 0.38), cup -0.84% (t -1.35). [`bl042_event_study_result.json`](../../../../packages/momentum-backtesting/search_spaces/bl042_event_study_result.json) |
| BL-042 ranking test (Phase 5) | blend 0.25 / 0.5 / 0.75, filter, bonus, learned score: 24 trials | plain Broad, off mode, top 10, weekly, delay 1, itemised costs; 2012-04 to 2023-12; baseline 11.9%, max drawdown -73.2% | **Kill, all three: PBO 0.57** (limit 0.3) | Joined walk-forward 2017-2023: tight range +4.7 pts a year, flag -5.9, cup +1.2. [`bl042_dev_result.json`](../../../../packages/momentum-backtesting/search_spaces/bl042_dev_result.json) |
| BL-042 hold-out | 2024-01-01 to 2026-09-25 | — | Not run; passed unread to BL-043 | [`bl042_holdout_result.json`](../../../../packages/momentum-backtesting/search_spaces/bl042_holdout_result.json) |
| [BL-043](../../../../backlog/BL-043-daily-pattern-trading-system.md) daily swing system | tight range and flag; 2 entries x 3 stops x 3 targets; 3 cut-offs x health switch; 42 trials | 2012-2023 walk-forward (2015-2023), next-open fills, itemised costs + 15 bps | **Kill on development** | Trade level passes (tight range +0.62R, PBO 0.04; flag +0.44R, PBO 0.20); portfolio fails: 7.8% CAGR vs Nifty 500 TRI 13.5%, PBO 0.32. [`bl043_criteria.json`](../../../../packages/momentum-backtesting/search_spaces/bl043_criteria.json), [`bl043_dev_result.json`](../../../../packages/momentum-backtesting/search_spaces/bl043_dev_result.json) |

## What we know

- Patterns add nothing beyond momentum in the Broad pool, and better-formed bases do no better.
- Exploratory, after the result (27 post-hoc looks, not evidence): a pullback inside a tight range
  or flag near the highs beat momentum peers (+3.3% at 13 weeks, t 2.7; flag +2.2% at 4 weeks,
  t 3.1); breakouts bought the next Friday added nothing.
- BL-043's trade-level metric (mean R) rewarded tiny stops: the top combination wins 18% / 9% of
  the time with winners of 10-40R on stops under 1-3% away. Its score did not rank.
- As simple 10-slot portfolios (exploratory), "all four kinds, 8% stop" made 20.0% with a -43.7%
  max drawdown in 2012-2023, tracking the mid/small-cap indices (Midcap 150 TRI 21.5%, Smallcap
  250 TRI 19.1%): mid/small-cap exposure, not a pattern edge.
- The 2024-26 hold-out is still sealed and unclaimed by both items. BL-043 was closed as killed on
  2026-10-28 (owner) without running it.

## Not yet tested

- **Consolidation tightness as a ranking feature** ([BL-035](../../../../backlog/BL-035-consolidation-tightness-feature.md),
  status Idea): rank the Broad pool by momentum and recent tightness (range or ATR relative to the
  run-up or the stock's own history), as a blend or a filter, against plain momentum. Its first
  phases ran under BL-042 as "tight range / VCP"; the standalone numeric-feature test is not done.
- Patterns 5-10 of BL-042's catalogue (flat base, ascending triangle, double bottom, head and
  shoulders, 52-week-high breakout, Darvas box): [BL-031](../../../../backlog/BL-031-chart-pattern-detectors.md).
- A true breakout-day entry with a stop, on the sealed 2024-26 data (proposed after BL-042).

## In plain words

We taught the code to spot three classic chart shapes and checked them by eye. Then we asked:
do stocks showing these shapes do better than similar-momentum stocks without them? They did
not, and adding them to the Broad ranking did not help either. Run as their own day-by-day
trading system with stops and targets, they made less than simply holding a mid-cap index.

## Related

- [Broad filters](filters.md), [Broad funnel](funnel.md), [universe](../../common/universe.md).
