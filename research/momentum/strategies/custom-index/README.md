# Custom Index (category momentum)

**Last updated:** 2026-10-14

## What it is

Every category (the 16 official ones plus the custom ones in `category_extras.csv`) gets its own
inner stock rotation. Each inner equity curve becomes a column in a price table with no ETF
columns, and the ordinary engine then ranks the categories against each other. Holding the top 8
categories spreads the money across 8 sectors.

## Where it lives in code

- `packages/momentum-backtesting/src/momentum_backtesting/categories/compose.py`: inner backtests
  and the all-categories price table.
- `categories/resolve.py`, `categories/snapshots.py` (category membership; Wayback snapshots cover
  2020-2024), `api._custom_index_backtest`.
- `engine.py` for both rotations.

## Defaults

Outer top 8 / exit 16, inner top 2 / exit 8, commodity and debt copies 1 (API defaults).

## Variable pages that apply

- [Inner and outer rotation, copies](inner-outer-rotation.md) (Custom Index only).
- Shared: [top N and exit rank](../../common/top-n-exit-rank.md) (the TODO 3.9.8 numbers),
  [gates](../../common/gates.md) (the defensive filter, TODO 3.9.8),
  [benchmarks](../../common/benchmarks.md), [costs](../../common/costs.md),
  [cadence](../../common/cadence.md).

## Strategy-specific findings

- TODO 3.9.8 set out to reduce Custom Index's max drawdown (about 38-43% across real runs then).
  Raising the outer `top_n` from 5 to 8 (exit 10 to 16) did; a zero-cost re-run showed whipsaw
  was not the main driver.
- Custom Index results carry an "upper bound, not an expected return" note citing BL-010 F1 / F2
  ([BL-010](../../../../backlog/BL-010-momentum-evaluation-review.md) Log, 2026-10-05), like Broad.
- No Custom Index setting has been tested under a pre-registered rule.

## In plain words

Custom Index treats each sector as if it were a fund made of its best two stocks, then runs the
usual weekly rotation across those home-made sector funds, holding the best eight.

## Related

- [Broad](../broad/README.md), [ETF rotation](../etf-rotation/README.md), [index](../../README.md).
