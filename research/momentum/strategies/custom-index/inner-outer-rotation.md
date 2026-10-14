# Custom Index: inner and outer rotation, commodity and debt copies

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

Custom Index runs two rotations. Inside each category, an inner backtest holds the top stocks of
that category; its equity curve becomes the category's price series. An outer backtest then ranks
the categories against each other with the usual `top_n` / `exit_rank`.

| Parameter | Default (where) | Mechanism | Grade |
|---|---|---|---|
| `inner_top_n` / `inner_exit_rank` | 2 / 8 (`compose.py`) | Stock rotation inside each held category | R |
| Outer `top_n` / `exit_rank` | 8 / 16 | Category-vs-category rotation across 62 to 68 categories | M, TODO 3.9.8 |
| `commodity_copies`, `debt_copies` | 1 (API) | Duplicate ranked slots for gold / silver or cash / gilt in Custom Index. Default 1 = ordinary single-instrument behaviour | R |

Code: `categories/compose.py` (`all_category_names`, `build_all_categories_price_table`,
`atomic_copy_names`), `api._custom_index_backtest`.

## Live value

Inner 2 / 8, outer 8 / 16, one copy each (API defaults).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| TODO 3.9.8 | outer 5 / 10 to 8 / 16 | Custom Index real runs | 8 / 16 adopted: a win on both drawdown and return | Numbers on [top N and exit rank](../../common/top-n-exit-rank.md) |
| TODO 3.9.23 | thin-week check | Custom Index defaults | No skipped weeks | 456 weeks, 0 gaps |

## What we know

- Holding the top 8 categories at once spreads money across 8 sectors; that is where the tab's
  diversification comes from (`compose.py` docstring).
- The category list is in-sample selected (`categories/broad.py` docstring, cited in BL-088), and
  `category_extras.csv` applies custom themes to every year, so results carry the same taxonomy
  hindsight as Broad ([category tags](../broad/category-tags.md)).
- The inner settings and the copies have never been isolated by a backtest.

## Not yet tested

- Inner `top_n` / `exit_rank` other than 2 / 8.
- `commodity_copies` / `debt_copies` above 1 under the rolling-window rule.

## In plain words

**Inner top-2, exit 8.** Inside each sector, hold the top 2 stocks and swap at rank 8.

**Outer top 8, exit 16.** Across sectors, hold the top 8. Measured win-win versus the old 5 and 10
(TODO 3.9.8).

## Related

- [Custom Index](README.md), [top N and exit rank](../../common/top-n-exit-rank.md),
  [Broad category tags](../broad/category-tags.md).
