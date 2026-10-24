# Widesl: overall MTM stop

**Status:** Tested · **Last updated:** 2026-10-23

## What it is

A rupee cap on the strategy's combined mark-to-market for the day, per lot. When it is reached every open
leg is closed and the strategy is done for the day. Set by `overall.stop_loss_inr`. The engine closes at
the end of the 1-minute bar, so on fast days the realised loss overshoots the level ([BL-066][bl066]).

## Live value

₹2,500 per lot in all three live Widesl files and every rotation Widesl file.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-070 | ₹2,500 vs no overall stop (leg stops kept), all 150 Widesl variants | 2025-09-01 → 2026-10-08, 1 lot, before charges | **Keep only for SENSEX OTM2**; elsewhere the stop costs more than it saves | [BL-070][bl070] |
| BL-098 Phase 2 | none, ₹1,000, ₹1,500, ₹2,000, ₹2,500, ₹3,000, ₹3,500, ₹4,000 | holdout 2025-10-09 → 2026-10-09, **after charges** | Descriptive ranking; Phase 3 pending | [BL-098 report][bl098q] |
| BL-156 | Overall stop checked at each 1-minute candle close (the engine) vs on every tick (live; modelled from each minute's high / low, calibrated on the 23 Oct live stop) | T1's and Core's Adaptive picks, 2025-01-10 → 2026-10-22, 1 lot, after brokerage | **No meaningful difference**: close +₹56 / day on T1, 90% [−17, +144]; Core +₹38 [−35, +130] | [BL-156][bl156] |

Family means, 1 lot, with ₹2,500 → without ([BL-070][bl070], before charges):

| Family | Total | Max drawdown | Days the stop fired |
|---|---|---|---|
| NIFTY OTM1 | ₹41,881 → ₹55,512 | −₹27,702 → −₹24,016 | 35 |
| NIFTY closest premium | ₹34,815 → ₹43,418 | −₹25,199 → −₹24,541 | 41 |
| SENSEX OTM2 | ₹19,657 → ₹16,513 | −₹27,384 → −₹36,102 (**+32%**) | 33 |
| SENSEX closest premium | ₹23,260 → ₹29,900 | −₹30,371 → −₹32,624 | 40 |

MTM rows in the BL-098 post-charge top four: NIFTY 13:00–15:30 ₹100 with **no** MTM stop leads (₹22,798,
₹94 a day, worst day −₹5,021); ₹3,500 and ₹4,000 follow at ₹20.6k. NIFTY OTM1 midday with no MTM stop is
fourth (₹13,255) but with a worst day of −₹8,125 and CVaR −₹4,900, against about −₹4,000 / −₹3,200 for
the stopped rows. SENSEX ₹250 at ₹4,000 makes ₹11,718 (morning) and ₹18,034 (afternoon) against the
baseline ₹13,883 in the afternoon.

## What we know

- Before charges, the ₹2,500 stop lowers NIFTY Widesl's total and does not deepen its drawdown when
  removed. On the days it fired, the stopped strategy lost more than the unstopped one would have: the
  end-of-bar overshoot.
- SENSEX OTM2 is the exception: without the stop its drawdown is 32% deeper and its total lower.
- Without the stop the worst single day roughly doubles (about −₹3,800 → −₹7,500 per lot across all 248
  variants, BL-070). After charges, the no-stop NIFTY rows lead on net but carry that tail (BL-098).
- In the rotation the stops help the ranking: every DRB list earns less on the no-stop results although
  the variants earn more (BL-070). The stop is part of what the ranking learns to pick.

- **Paper checks this stop at each minute's close; Quantiply checks every tick** (BL-156). On a spike that
  comes back inside the minute, live stops out where paper does not: 23 Oct `N_p100_1217` made −₹2,554
  live against +₹1,053 on paper. Over 431 days of T1's picks, the candle close earned about ₹56 a day
  more, but the interval includes zero. Paper therefore overstates live by about ₹40–55 a day for the
  book. AlgoTest can be set to check on candle close; Quantiply cannot.

## Not yet tested

- Per-family levels as a pre-registered rule on unseen days (BL-070 ran no other level).
- Stop × leg-stop and stop × trail interactions (BL-098 Phase 3).
- Daily stops on a whole mix: see [portfolio stop](../../common/portfolio-stop.md).

## Related

- [Directional MTM stop](../directional/mtm-sl.md); [leg stop](leg-sl.md).
- Scripts: `research/bl070/` (`gen_variants.py`, `run_variant.py`, `analyse.py`); BL-098 rows in
  `research/bl097/results/widesl_sweep_postcharge.csv`. Both git-ignored; regenerate with those scripts.

[bl156]: ../../../../backlog/BL-156-mtm-stop-tick-vs-candle-close.md
[bl066]: ../../../../backlog/BL-066-drb-6w3l2-daily-stop.md
[bl070]: ../../../../backlog/BL-070-drb-without-per-strategy-stops.md
[bl098q]: ../../../../backlog/BL-098-widesl-qualified-list-post-charge.md
