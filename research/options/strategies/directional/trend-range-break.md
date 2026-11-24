# Directional: trend-aligned range break (one leg)

**Status:** Tested (killed) · **Last updated:** 2026-11-15 · Item: [BL-221][bl221]

## What it is

The owner's idea of 2026-11-15: instead of Dir's two legs at a fixed 09:24, mark the NIFTY high and low of
09:17 to 10:00 (range), wait for a break, and sell **one** leg opposite to the break (PE after an up-break, CE
after a down-break) only when the hourly EMA 20 is above (below) EMA 50, from bars finished before the
session. ATM at the break minute, 21% leg stop, one re-entry at cost, out 15:28, no overall stop. Break bar =
first bar after the range whose high is above the range high (low below the range low); entry = the next
minute's engine fill. Built outside the engine (the engine's `range_breakout` picks the strike at 09:17), each
trade run by `simulate_day`.

## Live value

None.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| BL-221 registered | Primary cell: range to 10:00, hourly EMA 20/50, break valid to 12:00; 11 sensitivity cells (range 09:45 / 10:30, daily EMA, to 14:00) | NIFTY, 491 sessions 2024-10-09 → 2026-10-08, ₹23.6 an order + 0.5% slippage | **Killed**: 4 of 5 rules fail | [BL-221][bl221] |
| BL-221 extras (owner override) | Same breaks **bought** (ATM, ITM2), **ITM2 sold**, and **sold at the range-edge strike** (the PE at the range high's strike) | same, primary range | None passes; descriptive only | [BL-221][bl221] |

## What we know

Primary cell, ₹ per strategy-day over all 491 days (no-trade days count as 0), after charges and 0.5% slippage:

| Series | ₹ per day | ₹ per trade (days traded) | Max drawdown |
|---|---|---|---|
| Trend-aligned break, sell ATM (the registered rule) | +24 | +46 (263) | 39,672 |
| Base Dir, as traded (2 legs, 09:24, ₹3,000 stop) | +77 | | 63,987 |
| Same break, no trend gate (first break either way) | −90 | −99 (444) | 71,339 |
| Two-leg Dir started at 10:01 | −18 | | 52,239 |

- **The gate helps the break, the break does not beat Dir.** Gate minus no-gate +₹114 a day [−36, +262]; candidate
  minus base Dir −₹53 [−262, +148]. The candidate beat 69.8% of 2,000 random-trend draws (95% needed) and was
  above both zero and the base in 0 of 4 equal blocks of days (+218, +4, −12, −111 a day; the base's +455, +101, +88,
  −331). Only the drawdown test passed.
- **No sensitivity cell is a candidate.** All 12 cells sit at −₹58 to +₹49 a day, none above the base Dir; the
  better ones (range to 10:30, hourly: +₹49 a day on 201 days) are not distinguishable from zero.
- **Slippage:** the candidate is +₹67 a day with none and −₹58 at 1% (the base Dir +264 and −137).
- **Buying loses:** the same-direction ATM bought −₹232 a day, 23% of days won; ITM2 −₹252. The break is not
  followed by enough movement to pay a bought premium.
- **ITM2 sold is worse than ATM:** −₹31 a day, deeper drawdown (78,778), beat 51% of random trends.
- **Selling at the range-edge strike is ATM in all but a few cases** (the level's strike was the ATM in 574 of 660 breaks,
  one step off in the rest): +₹28 a day, the same as ATM.
- **Descriptive leads, in-sample, not tested:** sold CE on down-trend days earned +₹107 a day (155 days) and sold PE
  on up-trend days −₹42 (109 days), in a two-year window that leaned down (hourly up-trend on 44% of days); the widest
  third of ranges earned +₹162 a trade and the narrowest −₹91 (whole-window terciles).
- The 2022–24 confirmation and the sessions after 2026-10-08 were never opened.

## Not yet tested

- A wide-range-only break (a lead above); SENSEX; a 15-minute trend; a break buffer (`gap_percent`).

## Related

- [Breakout (five-minute hold)](../breakout/README.md): selling the opposite side was best there too; [Dir
  entry time](entry-time.md); [intraday state](../../common/intraday-state.md) (pivot-with-trend).

[bl221]: ../../../../backlog/BL-221-trend-aligned-range-break-dir.md
