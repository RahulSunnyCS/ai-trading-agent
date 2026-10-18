# Momentum: benchmark and comparison lines

**Status:** Descriptive · **Last updated:** 2026-10-14

## What it is

What a result is compared with. Not a lever: it changes no trade.

| Parameter | Default (where) | Mechanism | Grade |
|---|---|---|---|
| `benchmark` | `Nifty 50` (Config, API) | Column used as the chart's comparison line, priced like the strategy: the price index in index mode, NIFTYBEES (dividends kept) in ETF mode | M, TODO 3.9.23 |
| Comparison lines (`reference_benchmarks.py`) | always on | Every payload carries `comparisons`: Nifty 50 TRI and Nifty200 Momentum 30 TRI (back-calculated by NSE before 2020-08-11), with the CAGR edge | M, TODO 3.9.23 |

## Live value

Both lines on every ETF, Stock, Custom Index and Broad result. Four more TRIs (Midcap 150,
Smallcap 250, Midcap150 Momentum 50, Nifty500 Momentum 50) are loaded for BL-010 but not drawn;
adding Midcap 150, Smallcap 250 and Nifty 500 lines is
[BL-036](../../../backlog/BL-036-momentum-ui-from-bl010.md) Phase 1 task 3.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| TODO 3.9.23 check (a) | ETF-mode benchmark vs Nifty 50 TRI | 2017-2026 | ETF mode is NOT inflated by dividends | NIFTYBEES 12.48% vs Nifty 50 TRI 12.58% a year. Index mode compares price with price, so its edge is honest relative to the index but about 1.3 points above the edge over Nifty 50 TRI |
| TODO 3.9.23 | edge of each baseline | full window 2017-01 to 2026-09 | Both strategies clear both lines | ETF live strategy: +13.2 points a year over Nifty 50 TRI, +8.7 over Momentum 30 TRI. Broad: +19.1 and +14.6 |

## What we know

- Nifty 50 TRI is the honest passive alternative; Nifty200 Momentum 30 TRI is the buyable
  momentum alternative.
- BL-010's minimum bar is Nifty200 Momentum 30 TRI + 5 points after tax, and its drawdown
  baskets compare with Midcap 150 and Smallcap 250
  ([`bl010_criteria.json`](../../../packages/momentum-backtesting/search_spaces/bl010_criteria.json)).
- Broad prices carry no dividends (about 1% a year against TRI benchmarks), a conservative bias
  (BL-010 F16).

## Not yet tested

- Nothing to test; the open work is showing more lines (BL-036).

## In plain words

Every chart shows two dash-dot lines: Nifty with dividends (what an index fund would have made) and
the Momentum 30 index (what a ready-made momentum fund would have made). Beating the first is the
minimum; beating the second by a clear margin is the point.

## Related

- [Universe](universe.md), [ETF rotation](../strategies/etf-rotation/README.md),
  [Broad](../strategies/broad/README.md).
