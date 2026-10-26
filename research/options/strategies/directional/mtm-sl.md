# Directional: overall MTM stop

**Status:** Tested · **Last updated:** 2026-10-26

## What it is

A rupee cap on the strategy's combined mark-to-market for the day, per lot; reaching it closes every open
leg and ends re-entries for the day. Set by `overall.stop_loss_inr`. The engine closes at the end of the
1-minute bar, so fast days overshoot ([BL-066][bl066]).

## Live value

₹3,000 per lot in the live file, the fixed base and all rotation Dir files. SENSEX Dir uses the same
rupees with a much smaller lot, so it binds less often there ([BL-056][bl056]).

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-070 | ₹3,000 vs no overall stop, all 50 Dir ATM variants (leg stops and re-entry kept) | 2025-09-01 → 2026-10-08, 1 lot, before charges | **Costs more than it saves** on both indices | [BL-070][bl070] |
| BL-096 | ₹2,000, ₹2,500, ₹3,000, ₹3,500, ₹4,000 × leg stop × exit, ATM and ITM1 | holdout 2025-10-09 → 2026-10-09, before and **after charges** | Descriptive: net rises with the stop up to ₹4,000, the grid edge | [BL-096][bl096] |
| BL-156 | Overall stop checked at each 1-minute candle close (the engine) vs on every tick (live; modelled from each minute's high / low, calibrated on the 23 Oct live stop) | T1's and Core's Adaptive picks (every family together), 2025-01-10 → 2026-10-22, 1 lot, after brokerage | **No meaningful difference** on the whole book: close +₹56 / day on T1, 90% [−17, +144]; Core +₹38 [−35, +130]; not split by family | [BL-156][bl156] |
| BL-166 | ₹3,000, 4,000, 5,000, 6,000, 8,000, 10,000 on ITM2 and ITM3 (ITM1 and ATM at ₹3,000), 25 start times, NIFTY and SENSEX | 2024-10-09 → 2026-10-23, fit year then hold-out, net after charges, 1 lot | **Stop rate falls fast with the level** (ITM3 NIFTY 16.6% at ₹3,000, 11.7% at ₹4,000, 5.1% at ₹6,000); net per slot-day keeps rising to ₹10,000 in-sample, with deeper drawdowns; a ₹4,000 stop matched ITM1's stop rate and passed on SENSEX | [BL-166][bl166] |

Family means, 1 lot, with ₹3,000 → without ([BL-070][bl070], before charges):

| Family | Total | Max drawdown | Days the stop fired |
|---|---|---|---|
| NIFTY Dir ATM | ₹76,003 → ₹81,920 | −₹20,681 → −₹18,479 | 24 |
| SENSEX Dir ATM | ₹84,405 → ₹92,029 | −₹19,343 → −₹16,997 | 21 |

On the days it fired, the unstopped strategy lost less (NIFTY −₹77,634 → −₹71,716; SENSEX −₹67,032 →
−₹59,408): the end-of-bar overshoot.

## What we know

- Before charges, removing the ₹3,000 stop raised Dir's total and made its drawdown shallower on both
  indices (BL-070). ITM1 was not in that run.
- In the 15k charged grid net rises monotonically with the stop up to ₹4,000, the largest value tried;
  25% / ₹4,000 beats the live 21% / ₹3,000 by ₹33 a day after charges (BL-096).
- The band leaders after charges still use ₹2,000–₹4,000 (SENSEX afternoon ₹2,000, NIFTY midday ₹2,500)
  because the balanced score also weighs stop rate and tail ([BL-096 post-charge][bl096pc]).
- In the rotation the per-strategy stops help the ranking: DRB lists earn less on no-stop results even
  though the variants earn more (BL-070). One year; the stops stay.

- **Deeper strikes and the stop (BL-166):** the overall stop fires on 14% of ITM1 strategy-days on NIFTY and 11% on SENSEX, 15% to 18% and 12% to 15% for ITM2 and ITM3 at ₹3,000. Widening it to ₹4,000 brings them to ITM1's rate. See [strike depth](strike-depth.md).

## Not yet tested

- Stops above ₹4,000: BL-096 says this needs a committed pre-registration first.
- "No stop" inside the BL-096 grid (the grid has no such row).
- Daily stops on the whole mix: see [portfolio stop](../../common/portfolio-stop.md).

## Related

- [Widesl MTM stop](../widesl/mtm-sl.md); [leg stop](leg-sl.md).
- Scripts: `research/bl070/`, `research/bl096/run_enriched.py`; outputs git-ignored, regenerate with them.

[bl056]: ../../../../backlog/BL-056-weekday-dte-vix-breakdown.md
[bl066]: ../../../../backlog/BL-066-drb-6w3l2-daily-stop.md
[bl070]: ../../../../backlog/BL-070-drb-without-per-strategy-stops.md
[bl096]: ../../../../backlog/BL-096-directional-parameter-sweep.md
[bl096pc]: ../../../../backlog/BL-096-directional-qualified-list-post-charge.md
[bl156]: ../../../../backlog/BL-156-mtm-stop-tick-vs-candle-close.md
[bl166]: ../../../../backlog/BL-166-directional-itm2-itm3-with-matched-stop.md
