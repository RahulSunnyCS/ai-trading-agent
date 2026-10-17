# Broad Momentum: the funnel (pool, categories, picks)

**Status:** Tested · **Last updated:** 2026-10-17

## What it is

Broad Momentum (`category_mode="on"`) is three sieves: a quarterly pool of the strongest stocks,
then the strongest categories within it, then the top stocks inside each held category. With
category mode off, stocks are ranked directly from the pool.

| Parameter | Default (where) | Mechanism | Grade |
|---|---|---|---|
| `pool_top_n` / `pool_exit_rank` | 200 / 250 (Broad) | Stocks qualifying from about 755 (Nifty Total Market, point-in-time membership), refreshed quarterly | M, TODO 3.9.23 |
| `coverage_floor` | 0.40 | Minimum share of a category's members that must be in the pool | M, TODO 3.9.23 |
| `category_top_n` / `category_exit_rank` | 4 / 8 | Category-level hysteresis | M, TODO 3.9.23 |
| `picks_per_category` | 2 | Top stocks per held category, by pool rank | M, TODO 3.9.23 |
| `off_top_n` / `off_exit_rank` (category mode off) | 10 / 20 | Direct stock ranking from the pool. Independent of the category numbers; not swept | R |

Code: `categories/broad.py` (`DEFAULT_*` constants, `run_broad_backtest`).

Note: the old reference doc described the Total Market pool as "point-in-time membership". BL-010
(F1) found that `total_market` is today's 755-name list for every year; the point-in-time
universe is `turnover_rank` ([universe](../../common/universe.md)).

## Live value

- A new dashboard run: 200 / 250, 0.40, 4 / 8, 2 picks (`categories/broad.py`).
- Search ranges, arm A
  ([`round7_A.toml`](../../../../packages/momentum-backtesting/search_spaces/round7_A.toml)):
  `coverage_floor` 0.0 to 0.3, `pool_top_n` 30 to 350, `pool_band` 0 to 200, `category_top_n`
  1 to 8, `category_band` 0 to 8, `picks_per_category` 1 to 3. Arms B and C2 (category mode off):
  `pool_top_n` 20 to 300, `pool_band` 0 to 150, `off_top_n` 3 to 25, `off_band` 0 to 25
  ([`round7_B.toml`](../../../../packages/momentum-backtesting/search_spaces/round7_B.toml),
  [`round7_C2.toml`](../../../../packages/momentum-backtesting/search_spaces/round7_C2.toml)).
  Round 1 searched wider: pool 30 to 400 (band 0 to 300), categories 3 to 15 (band 0 to 15),
  coverage 0.2 to 0.8
  ([`round1_A.toml`](../../../../packages/momentum-backtesting/search_spaces/round1_A.toml)).
- The frozen ensemble: coverage 0.0132 to 0.1702, pool 117 to 335, categories 6 to 8, 1 or 2
  picks, 8 or 12 holdings
  ([`bl010_phase6_frozen.json`](../../../../packages/momentum-backtesting/search_spaces/bl010_phase6_frozen.json)).

## Tested

All TODO 3.9.23 rows: Broad dashboard defaults, every week simulated, 2017-01 to 2026-09, 28
rolling 3-year windows; baseline 31.7% / 1.06 / -20.4%.

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| TODO 3.9.23 | pool 100 / 150 and 300 / 350 | as above | Keep 200 / 250; 300 / 350 a hint only (fork caveat) | 100 / 150: 25.5% / 0.98 / -21.3%, rolling 21 / 32 / 61%, median -5.9. 300 / 350: 33.8% / 1.10 / -21.7%, rolling 68 / 61 / 57%, median +1.9 |
| TODO 3.9.23 | coverage floor 0.25 (the 3.9.18 candidate), 0.60 | as above | Keep 0.40 (fork caveat) | 0.25: 29.0% / 0.97 / -24.1%, rolling 46 / 46 / 43%, median -1.0. 0.60 starves the strategy (20.4%) |
| TODO 3.9.23 | categories 3 / 6 and 6 / 12 | as above | Keep 4 / 8 (fork caveat) | 3 / 6: median -1.8 (29 / 43 / 82%). 6 / 12: median -4.3, MaxDD -29.8% |
| TODO 3.9.23 | picks 1 and 3 | as above | 3 wins most (more names, same categories); 1 loses | 1: 25.9% / 0.99 / -18.0%, median -5.4. 3: 34.1% / 1.16 / -20.6%, rolling 93 / 96 / 46%, median +3.0 |
| [BL-116](../../../../backlog/BL-116-broad-sector-position-and-score.md) | Do picks from the best-placed sector held (position 1) beat Nifty 500 more often than picks from the other fresh positions? Decided on the 9 saved groups other than Trio and Four Sectors | 2017-2022, 5,244 stock picks, pre-tax | **Passed**: +13.4 pts (90% interval +7.3 to +19.6), above zero in 9 of 9 | Position 1: 58% beat, +7.3% mean excess; positions 2-6: 42-46%, +0.4% to +2.7%. Trio does not show it (+2.7). Fresh positions only: under a stock tilt lingering sectors also buy, and those picks were left out. [`bl116_result.json`](../../../../packages/momentum-backtesting/search_spaces/bl116_result.json) |
| [BL-010](../../../../backlog/BL-010-momentum-evaluation-review.md) F5 / Phase 5 | number of holdings across the round 7 search | Broad, 2017-2026, pre-tax | Prefer 8-12 names | Median CAGR is flat at about 32% from 2 up to 24 holdings; the maximum rises from 51% (12-24 holdings) to 73% (2 or fewer): concentration plus picking the best is a winner's curse. Phase 5: 8-12 holdings match 2-6 on return with far shallower falls |

### Cold-start caveat

Cold-start caveat (TODO 3.9.18): levers that change category selection (pool, coverage, category
width, score, weights) fork the portfolio before `start`. Rolling windows restart the trading,
but not that selection history, so treat their numbers as indicative.

## What we know

- `picks_per_category=3` is one of the levers that won most in 3.9.23, by owning more names; it
  widens the bet.
- The rest of the funnel defaults held up: smaller pools, a looser or tighter coverage floor, and
  narrower or wider category lists all lost.
- The holdings count matters for risk, not for expected return (F5).

## Not yet tested

- `off_top_n` / `off_exit_rank` (category mode off) under the rolling-window rule.

## In plain words

Think of it as three sieves. Numbers are the shipped defaults.

1. **Pool: top 200 of about 755 stocks, exit at 250, refreshed quarterly.** First find the
   strongest stocks in the whole market. A smaller pool (100) did worse; a bigger one (300) did a
   little better in most stretches, but this changes which sectors get picked from the start,
   so treat it as a hint, not proof (TODO 3.9.23).
2. **Categories: top 4 fresh, exit at 8, with a 40% coverage floor.** Group stocks into sectors.
   A sector only counts if at least 40% of its stocks made the pool, so one lucky stock cannot
   carry a whole sector. The 25% floor that looked promising earlier lost once every week was
   counted, and 3 or 6 categories did worse than 4 (TODO 3.9.23).
3. **Picks: 2 stocks per category.** The two strongest stocks inside each held sector. Three
   picks did better in most stretches (about 3 points a year), mainly by owning more names;
   one pick did much worse (TODO 3.9.23).

## Related

- [Simulate every week](min-ranked.md), [category tags](category-tags.md),
  [universe](../../common/universe.md), [top N and exit rank](../../common/top-n-exit-rank.md).
