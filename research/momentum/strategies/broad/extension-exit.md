# Broad Momentum: extension exit (sell or trim far above the 200-day EMA)

**Status:** Tested · **Last updated:** 2026-11-16

## What it is

Sell a holding (or half of it) once its close is far above its 200-day EMA, the "parabolic, sell into
strength" rule. Checked every week, not only on rebalance weeks; while a stock stays above the level it is
not bought or topped up (it keeps its slot, as a stock locked at the upper circuit does), and the money waits
as cash until the next rebalance.

| Setting | Default (where) | Mechanism |
|---|---|---|
| `Config.extension_exit` | None = off (`engine.py`) | Level of close / 200-day EMA − 1 above which the exit acts (0.70 = 70 % above) |
| `Config.extension_action` | `sell` | `sell` the whole holding, or `trim` half once per crossing |

The EMA is `ewm(span=200, adjust=False)` on the split- and bonus-adjusted daily close
(`categories/extension.py`), read on the last day on or before the signal Friday and lagged with the ranks.
Research callers pass it through `run_broad_backtest` / `api._run_broad`; no API request sets it.

## Live value

Off. Nothing in the API, the weekly signal or the orders sets it.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| [BL-233](../../../../backlog/BL-233-ema-extension-exit.md) | Sell at 0.70 and trim half at 0.70 (tested); sell at 0.50 and 1.00 (description) | The 12 favourite groups of 2026-11-16 (headline, invested, paper, 9 watched; 46 sleeves), saved configs, 2017-01-06 to 2026-11-13, after tax | **Killed, both** | Median across groups: sell −4.6 CAGR points, trim −2.6; worst fall unchanged (median 0.0); 0 of 12 groups gain CAGR in either. Headline −2.0 (sell) / −0.8 (trim). Both halves of the record lose. [`bl233_result.json`](../../../../packages/momentum-backtesting/search_spaces/bl233_result.json) |

## What we know

- Selling stretched names costs return and does not reduce the worst fall: in 8 of 12 groups (selling at 70 %) the
  worst fall moves by under 1 point either way. The exit sells the names carrying the return, and the cash then waits.
- The lower the level, the worse: at 50 % the median group loses 8.7 CAGR points for a 2.7-point shallower
  worst fall. At 100 % it fires about half as often and changes almost
  nothing (median −0.1 points).
- The two groups where the worst fall did improve (Half Tilt −35 → −29 %, Stock Tilt −37 → −29 %) paid 5–7 CAGR points
  for it.
- It agrees with BL-050's M1 (stretched names kept outperforming) and BL-084 / BL-085 (extra sells cost more
  than they save).

## Not yet tested

- Other EMA lengths, money to the next-ranked name instead of cash, and the ETF and Stock datasets (listed
  under "will not run" in BL-233).

## In plain words

The rule says: when a stock is 70 % above its 200-day average, sell it (or half) before it breaks. On our
followed strategies it sold the best stocks in the middle of their run. Every group made less money, and the
worst falls stayed about the same.

## Related

- [Stop-loss](stop.md), [stock filters](filters.md) (M1 overextension gate), [Broad strategy](README.md).
