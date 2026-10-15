# Broad Momentum: stop-loss (weekly and daily)

**Status:** Tested · **Last updated:** 2026-10-14

## What it is

Sell a holding that has fallen a set amount below its buy price or below its peak, between
rebalances. Tested only on Broad, so this page lives in the Broad folder.

| Setting | Default (where) | Mechanism |
|---|---|---|
| `Config.stop_from_buy` / `stop_from_peak` | None = off | Fractions below the buy price / below the highest close since the first buy |
| `stop_proceeds` | `cash` | `cash` waits for the next rebalance; `top` buys the best buyable unheld name |
| `stop_delay` | 0 | Weekly stop: 0 sells at the close the fall is seen on, 1 a week later |
| `stop_granularity` | weekly | `daily` (BL-085): checked on each day's close, sold at the next open; a lower-circuit lock blocks the sale |

Buffer rule only; blocked by a lower-circuit lock; a stopped name is not re-bought that week.
`run_broad_backtest` takes the same arguments.

## Live value

Off. Nothing in the API or the weekly signal sets it.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| [BL-084](../../../../backlog/BL-084-momentum-stop-loss.md) weekly stop | from buy off / 15 / 20 / 25%; from peak off / 20 / 25 / 30%; proceeds cash or top stock: 30 cells, each at same-Friday and next-Friday fills | 11 strategies (10 top round 7 configs + frozen ensemble), point in time, curated tags, pre-tax at Rs 2 lakh, 2017-01 to 2026-10 | **Killed: 0 of 30 cells pass** (10 needed to "help") | Baseline medians: CAGR 40.2%, worst fall -27.1%, Ulcer 9.2%, third-worst FY +12.8 over Mom30 TRI. Nearest miss: 25% below buy, 7 of 11 at the same Friday, 3 of 11 at the next. 58 of 60 cell-timings cost under 2 points; Ulcer moves at most half a point. A 20% peak stop makes the worst fall 1.4-3.1 points shallower for about 1.6 points of CAGR. [`bl084_criteria.json`](../../../../packages/momentum-backtesting/search_spaces/bl084_criteria.json), [`bl084_result.json`](../../../../packages/momentum-backtesting/search_spaces/bl084_result.json) |
| BL-084 Monday-open replay (report only) | owner's 20% / 30% rule on the ensemble's four sleeves | same | Neutral | `1281e8ed` 34.3% / -27.9% to 35.7% / -25.2%; `08c4307d` 36.1% / -37.5% to 36.3% / -36.9%; `535b17b4` 32.7% / -34.7% to 30.8% / -36.6%; `bad83df3` 29.5% / -28.9% to 30.1% / -28.4%. Average +0.1 points |
| [BL-085](../../../../backlog/BL-085-momentum-improvement-levers.md) L4 daily stop | 15 / 20 / 25% below buy, 25 / 30% below peak, and pairs; next-open fill; cash | 11 strategies, after tax at Rs 5 lakh; choose FY2018-22, confirm FY2023-26 | **Killed** | 25% below peak passed FY2018-22 (8 of 11, -0.4 CAGR, worst fall +2.0) and failed FY2023-26 (0 of 11, -1.3). Owner's 20% / 30% rule: -0.9 then -4.1. [`bl085_result.json`](../../../../packages/momentum-backtesting/search_spaces/bl085_result.json), [write-up](../../../../packages/momentum-backtesting/docs/bl085-levers-2026-10-09.md) |

## What we know

- Stops are cheap but do not reduce pain. The rank exit already sells most collapsing stocks at
  the next rebalance; a stop mostly sells a momentum name in a dip that the strategy then buys
  back.
- The frozen ensemble (8-12 holdings, deeper falls) is where the owner's weekly rule looked best:
  same Friday +0.8 CAGR and a 5.2-point shallower worst fall; next Friday 0.0 and 1.0. The gap
  between the two timings says it catches one fall a few days early rather than working
  throughout.
- If a stop is wanted as a behavioural safety net, the 25% buy-price daily stop showed the least
  harm (+0.1 then 0.0 points). That cell failed the development rule (2 of 11) and its FY2023-26
  numbers were read outside the pre-registered gate, so it is a measurement, not a pass.
- **Research-gate deviation (BL-085):** FY2023-26 was computed for every lever, not only those
  that passed development. Every kill rests on development-window failures, so the verdicts
  stand; the window is treated as used up (owner `override` in the BL-085 Log).
- **File naming:** BL-084 was renumbered from BL-053 on 2026-10-10. `bl084_criteria.json` still
  says `"item": "BL-053"`, and the output stays in `data/search/round7_A/bl053/`. BL-085's files
  say BL-054 for the same reason.

## Not yet tested

- A re-buy cool-down after a stop, per-strategy thresholds, or stops after tax for the weekly
  version (each listed under "will not run" in BL-084).

## In plain words

A stop-loss sells a stock once it has fallen, say, 20% from where you bought it or 30% from its
best price. On these strategies it did not help, checked weekly or every evening. The strategy
already drops a weakening stock at its next rebalance, so a stop mostly sells a good stock on a
sharp dip, and it is bought back later.

## Related

- [Sizing and exposure overlays](../../common/sizing.md), [cadence](../../common/cadence.md)
  (`sell_every_week`), [Broad strategy](README.md).
