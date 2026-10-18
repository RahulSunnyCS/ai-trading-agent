# Stock (Nifty 50 stocks)

**Last updated:** 2026-10-14

## What it is

The weekly rotation run on individual Nifty 50 stocks, from a survivorship-free data layer: every
company that has ever been a Nifty 50 member, including those that delisted, merged or renamed,
with corporate-action-adjusted daily and weekly prices. Gold, silver and debt can be ranked
alongside the stocks. Dataset `"stock"` in the API (for example
`{"dataset":"stock","universe":["C0001","C0002","Gold"],"top_n":2,"exit_rank":4}`).

## Where it lives in code

- `packages/momentum-backtesting/src/momentum_backtesting/stocks/` (`mbt stocks fetch`,
  `pin-manifest`, `validate`); curated files in `stocks/curated/`.
- `api.py` (`_Data.get_stock()`), `engine.py` for the rotation, `rebalance.py` for the on-demand
  preview (supports Nifty 50 Stocks).
- Package `README.md`, "Stocks data (Nifty 50, survivorship-free)", including known limitations.

## Defaults

The engine defaults (top 5 / exit 10, lookbacks 1 / 4 / 13 / 26 / 52, buffer, wait, 35% cap,
0.10% cost) unless a run sets its own.

## Variable pages that apply

All shared pages apply in principle: [universe](../../common/universe.md) ·
[lookbacks](../../common/lookbacks.md) · [score](../../common/score.md) ·
[top N and exit rank](../../common/top-n-exit-rank.md) · [caps](../../common/caps.md) ·
[costs](../../common/costs.md) · [tax](../../common/tax.md) · [execution](../../common/execution.md) ·
[cadence](../../common/cadence.md).

## Strategy-specific findings

- **No parameter has been tested on this dataset.** The 2026-10-01 dry run covered ETF and Broad
  only.
- The thin-week check of TODO 3.9.23 could not run here: `api.DATA.get_stock()` crashed on the
  real catalog at the time (stock rows but no TRI rows in `momentum_prices`), flagged as its own
  task.
- Stock favourites run only once the processed stock data is in; the 19:30 Friday run sends them.

## In plain words

The same weekly "buy the strongest, sell when they fade" rule, but choosing among the Nifty 50
companies of each year rather than among sector funds. Nothing about its settings has been
measured yet.

## Related

- [Broad](../broad/README.md), [ETF rotation](../etf-rotation/README.md), [index](../../README.md).
