# Options: does T1 move to wider stops on range-bound days?

**Status:** Tested (re-scored, not forward) · **Last updated:** 2026-10-21

## What it is

Adaptive Tuned (T1) ranks Core-298 plus 223 tuned-settings variants each morning. The question
([BL-144][bl144]): when the previous week was range-bound, does its picker lean toward wide-stop
Widesl, and does it do worse than the fixed strategies on quiet days? Window: 238 NIFTY sessions,
2025-10-20 to 2026-10-19, after T1's setting-selection window (2024-10-09 to 2025-10-08). Picks are
re-scored from the rotation's own history (the journal's entry from 2026-10-12 for Core and 2026-10-19
for T1); the weights were chosen on the first research period, so this is not forward evidence.

## Live value

None. Nothing in the picker reads a range. T1's list is traded as it is.

## Tested

Pre-registered before any figure (BL-144 Phase 0; narrowed on 2026-10-21 by the owner to no basket stop).
Regime = tercile of R7, the mean daily range (percent of the previous close) of the 7 sessions before the
day, known at the open. Range-bound: R7 ≤ 0.75%, volatile: R7 ≥ 1.05%; 80 / 78 / 80 days. "Wide stop" =
every leg's stop loss in the strategy file is at least 100%. 90% circular 5-day block bootstrap.

| Statistic | Range-bound weeks | Middle | Volatile weeks | Low minus high |
|---|---|---|---|---|
| T1: share of picks that are wide-stop | 33.7% | 27.6% | 23.7% | **+10.0 pp [+1.0, +19.0]** |
| T1: mean leg stop % of its picks | 67 | 62 | 59 | |
| Core: share of picks that are wide-stop | 71.8% | 68.5% | 64.2% | +7.6 pp [+2.1, +13.3] |

| ₹ per lot-day, by the day's own range (an outcome label, not used to pick) | Quiet days | Middle | Wide days |
|---|---|---|---|
| 3 × Widesl OTM1 09:17 | +1,347 | +359 | −1,204 |
| Base (2 × Widesl 09:17 + 1 × Dir ATM 09:24) | +857 | +144 | −402 |
| Core (Adaptive Classic) | +1,046 | +62 | +200 |
| T1 (Adaptive Tuned) | +935 | +251 | +803 |

Verdicts under the registered rules:

- **H1 (T1 leans to wide stops in range-bound weeks): not met.** The direction is right and the interval
  is above zero, but the point estimate (+10.0 pp) is below the +15 pp the rule required. Core moves
  about as much (+7.6 pp), so T1 is not more adaptive than Core on this measure.
- **H2 (T1 not worse than the base on quiet days): met.** T1 minus Base on the lowest day-range third is
  +78 per lot-day [−172, +338], above the −250 floor; the interval includes zero, so this is descriptive.

## What we know

Descriptive readings; leads, not findings.

- **T1 moves little toward Widesl in quiet weeks.** By family the Widesl share (OTM1 plus closest-premium)
  is 73% in range-bound weeks, 67% in the middle and 65% in volatile weeks; Dir ITM1 falls from 27% to 19%.
  Core shows the same pattern (71 / 68 / 64%). The 69 to 72% of T1's picks that come from its extra
  variants barely change with the regime. (Exploratory split, not part of the registered rule.)
- **T1 does not lose on quiet days: it loses less on wide days.** It makes +935 per lot-day on quiet days
  against +1,347 for 3 × Widesl, but +803 on wide days against −1,204. Its edge here is on the volatile
  side.
- **The fixed Widesl strategies carry the day-range risk.** 3 × Widesl lost on 12 of 80 quiet days and has
  a worst day of −₹11,242; T1 lost on 14 of 80 quiet days.
- **One day dominates 3 × Widesl.** 3 Feb 2026 (range 2.79%, an expiry Tuesday) made +₹49,676; without it
  the year total is +₹68,617 instead of +₹118,293.
- **Year totals (gross, before charges, no basket stop), at the lots each book holds:** 3 × Widesl
  +₹118,293 (3 lots; worst peak-to-trough −₹135,484), Base +₹142,895 (3 lots; −₹91,096), Core +₹333,255
  (about 3 lots; −₹32,438), T1 +₹496,101 (about 3 lots; −₹23,300). A 3-lot strategy is three times the
  one-lot path, so its own ₹2,500 stop scales to ₹7,500 here.

## Open questions

- Whether a longer run of range-bound weeks (this year had 80 such days, in clusters) changes T1's picks.
  The forward journal (from 2026-10-19) is the unseen set; one day so far.
- Whether a rule that forces wide stops when R7 is low would help. Not tested and not registered.

[bl144]: ../../../backlog/BL-144-t1-range-bound-days.md
