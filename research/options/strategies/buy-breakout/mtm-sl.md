# Buy: overall MTM stop

**Status:** Descriptive · **Last updated:** 2026-10-24

## What it is

A rupee stop on the strategy's combined P&L (both legs, realised plus open, per lot). When it is
reached at a bar's close, every open leg is closed and the strategy is done for the day. Set by
`overall.stop_loss_inr`.

## Live value

₹2,000 per lot, live and rotation, NIFTY and SENSEX (SENSEX keeps the NIFTY rupee value,
[BL-056][bl056]).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-070 | ₹2,000 vs none, all 48 Buy variants | 2024-10 → 2026-10 (268 days), before charges | Mean per variant with → without: NIFTY ₹2,569 → ₹2,503, SENSEX ₹6,632 → ₹6,632; the stop fired about 1 day (NIFTY) and 0 days (SENSEX) | [BL-070][bl070] |
| BL-097 | ₹1,000, ₹1,500, ₹2,500, ₹3,000, ₹4,000 (base ₹2,000) | 48 files, fit 2024-10 → 2025-10, holdout 2025-10 → 2026-10, after charges | Screen only; ₹1,000 is third in NIFTY 11:00–13:00 | [BL-097][bl097], [report][bl097q] |
| BL-156 | Overall stop checked at each 1-minute candle close (the engine) vs on every tick (live; modelled from each minute's high / low, calibrated on the 23 Oct live stop) | T1's and Core's Adaptive picks (every family together), 2025-01-10 → 2026-10-22, 1 lot, after brokerage | **No meaningful difference** on the whole book: close +₹56 / day on T1, 90% [−17, +144]; Core +₹38 [−35, +130]; not split by family | [BL-156][bl156] |

Change against the baseline on the same file, ₹, mean over files ([how to read](README.md#how-to-read-the-bl-097-tables-on-these-pages)):

| Variant | Files | Fit Δ net | Holdout Δ net | Holdout Δ drawdown | Files ≥ base | Files net > 0 |
|---|---|---|---|---|---|---|
| ₹1,000 | 48 | −444 | +1,213 | +975 (shallower) | 83% | 4 |
| ₹1,500 | 48 | +115 | +251 | +253 | 90% | 4 |
| ₹2,500 | 48 | −56 | −19 | −19 | 90% | 3 |
| ₹3,000 | 48 | −56 | −23 | −23 | 88% | 3 |
| ₹4,000 | 48 | −110 | −23 | −23 | 88% | 3 |

"Files ≥ base" is high here because most files do not change at all.

## What we know

- The ₹2,000 stop is almost inert for Buy: the 25% leg stops close a losing day before the combined loss
  reaches it. In the BL-097 baseline it fired on 20 of 11,616 holdout file-days (computed from the
  CSV). Wider stops change nothing measurable.
- Only ₹1,000 bites: it helped in the holdout year and hurt slightly in the fit year, so its sign is not
  stable.
- The same rupee stop on SENSEX (lot 20) and NIFTY (lot 65, [BL-063][bl063]) is a different size
  relative to the premium; it was never normalised.

## Not yet tested

- BL-097 Phase 3's leg stop × overall stop interaction.
- A stop scaled to the premium paid (for example a share of both legs' entry cost) instead of rupees.

## Related

- [Widesl overall stop](../widesl/mtm-sl.md), [Directional overall stop](../directional/mtm-sl.md),
  [leg stop](leg-sl.md), [portfolio stop](../../common/portfolio-stop.md).

[bl056]: ../../../../backlog/BL-056-weekday-dte-vix-breakdown.md
[bl063]: ../../../../backlog/BL-063-rotation-after-charges.md
[bl070]: ../../../../backlog/BL-070-drb-without-per-strategy-stops.md
[bl097]: ../../../../backlog/BL-097-buy-parameter-sweep.md
[bl097q]: ../../../../backlog/BL-097-buy-qualified-list-post-charge.md
[bl156]: ../../../../backlog/BL-156-mtm-stop-tick-vs-candle-close.md
