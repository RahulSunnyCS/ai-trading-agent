# Options: how far paper overstates live

**Status:** Tested · **Last updated:** 2026-10-24

## What it is

The gap between the engine's paper result and what the same picks make live, from where each checks
the stops. The engine checks the overall MTM stop at each 1-minute candle close and leg stops on the
bar's high / low; Quantiply checks both on every tick. AlgoTest can be set to "Trade monitoring: on
Candle Close" for the overall stop; Quantiply cannot (`docs/algotest-execution.md`).

## Live value

Live trades check every stop on tick. Paper (every stored rotation result) checks the overall stop at
the candle close and leg stops on tick, so leg stops add no gap; the overall stop does.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-156 | Overall stop at the candle close (paper) vs on every tick (live; modelled from each minute's high / low with a 2% overshoot, calibrated on the 23 Oct live stop) | T1's and Core's Adaptive picks, 2025-01-10 → 2026-10-22, 1 lot, after brokerage | **No meaningful difference**: paper − live +₹56 / day on T1, 90% [−17, +144]; Core +₹38 [−35, +130] | [BL-156][bl156] |

## What we know

- Paper overstates live by about ₹40–55 a day for a 3-lot book, roughly 3–4% of paper's +₹1,526
  (T1) and +₹917 (Core) a day. The interval includes zero on both books.
- The gap grows with the overshoot: at 0% T1's is +₹34 [−40, +128], at 5% +₹90 [+13, +182]. The 2%
  is one day's figure (23 Oct: −₹2,554 at a ₹2,500 stop).
- On a spike that comes back inside the minute, live stops out where paper does not (23 Oct
  `N_p100_1217`: −₹2,554 live, +₹1,053 on paper). Tick caps the worst day better but has the deeper
  drawdown.
- The model covers the stop check only. Slippage, fill delays and order rejections are not in it;
  BL-141's `obt rotation live-compare` measures the whole gap on captured live days.

## Not yet tested

- The real overshoot distribution, from the live captures once enough stopped days are in.

## Related

- [Widesl MTM stop](../strategies/widesl/mtm-sl.md), [Dir MTM stop](../strategies/directional/mtm-sl.md),
  [Buy MTM stop](../strategies/buy-breakout/mtm-sl.md); leg stops: [Widesl](../strategies/widesl/leg-sl.md),
  [Dir](../strategies/directional/leg-sl.md), [Buy](../strategies/buy-breakout/leg-sl.md).
- [Charges](charges.md).
- Results: `packages/option-backtesting/research/bl156/out/result.json` (git-ignored; regenerate with
  `replay.py --until 2026-10-22`).

[bl156]: ../../../backlog/BL-156-mtm-stop-tick-vs-candle-close.md
