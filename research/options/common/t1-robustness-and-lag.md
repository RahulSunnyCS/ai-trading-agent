# Options: is T1's year broad, does it lag regime changes, does the opening range split quiet weeks?

**Status:** Tested (re-scored, not forward) · **Last updated:** 2026-10-24

## What it is

Follow-ups to [T1 on range-bound days](t1-range-bound-days.md), registered in
[BL-145][bl145] before any figure: (Q2) whether T1's lead over the other books is broad or a few days,
(Q3) whether T1 lags after the market changes regime, (Q4) whether the first 30 minutes' range splits
quiet-week days for a 09:47 Widesl. Window 2025-10-20 to 2026-10-19 (238 sessions), gross, no stop, no
charges (charges were left out at the owner's call). Picks are re-scored, not forward.

## Live value

None. Nothing in the picker reads a range or the opening range.

## Tested

90% circular 5-day block bootstrap, seed 20261021. R7 and D cut points as in the first page.

**Q2, breadth.**

| Book | Year total | Total without best 10 days | Months positive (of 11) | Mean ₹ per lot-day [90%] |
|---|---|---|---|---|
| 3 × Widesl 09:17 | +118,293 | **−76,337** | 7 | +166 [−166, +494] |
| Base | +142,895 | −6,592 | 6 | +200 [−59, +441] |
| Core | +333,255 | +205,055 (62%) | 10 | +439 [+258, +612] |
| T1 | +496,101 | +342,646 (69%) | 11 | +667 [+457, +869] |

T1 minus Core: +228 per lot-day [+81, +376]. **Verdict: T1's lead is broad** (without its best 10 days it
keeps 69% of its total, all 11 months are positive, and the interval over Core is above zero). The two
fixed Widesl books are the concentrated ones: without their ten best days they are flat or negative.

**Q3, lag after a change** (events: surprise-wide = quiet week then a wide day, 13 days; calm-down =
volatile week then a quiet day, 7 days).

| Mean ₹ per lot-day | Surprise-wide day | Next 1 to 5 sessions | All days |
|---|---|---|---|
| 3 × Widesl | −1,637 | +169 | +166 |
| Base | −595 | −61 | +200 |
| Core | −41 | +455 | +439 |
| T1 | **+1,225** | +817 | +667 |

T1 over sessions +1 to +5 minus its all-day mean: +151 [−151, +454]. **Verdict: no lag seen** after a
surprise-wide day (the rule needed a shortfall over ₹300 with the interval below zero). After a calm-down
day: **too few events** (7 is below the 8 the rule needs); T1 made +916 on the day and +919 over the next
five, no sign of a problem.

**Q4, opening range gate** (OR = 09:15 to 09:44 high-low, percent of the previous close; cut points from
the main window, 0.343% and 0.507%). On quiet-week days, `N_wide_0947` (Widesl OTM1 entering 09:47):

| Sample | Quiet-week days | Low OR | High OR | Low minus high [90%] | Quiet-week days that turned wide: low / high OR |
|---|---|---|---|---|---|
| Learning, 2025-10-20 to 2026-10-19 | 80 | +162 (46 days) | −1,284 (7 days) | **+1,446 [+426, +2,578]** | 6.5% / 57.1% |
| Confirmation, 2024-10-09 to 2025-10-17 (run once) | 46 | −288 (22 days) | −1,011 (5 days) | **+723 [−92, +1,879]** | 4.5% / 20.0% |

**Verdict: the gate works under the registered rule** (learning: at least +500 with the lower bound above
zero; confirmation: same sign and at least +250), **but thinly.** The high-OR group is 7 and 5 days, the
confirmation interval includes zero, and in the confirmation year the low-OR Widesl lost on average.

## What we know

Descriptive; leads, not findings.

- **T1 is not a handful of big days.** That is the opposite of the fixed Widesl books, whose year depends
  on a few expiry-day spikes (3 Feb 2026 alone made +₹49,676 of 3 × Widesl's total).
- **T1 did well exactly when the quiet-week assumption broke.** On the 13 surprise-wide days it made
  +₹1,225 per lot-day, while the all-wide strategies lost; the picker did not need to see the change coming.
- **A wide opening range in a quiet week is a warning sign, rarely seen.** Only 7 and 5 days in two years
  had a quiet week and a high opening range, and 57% / 20% of them turned wide. Too few to build a rule on.

## Caveats from the 2026-10-24 review

No number above was changed. The Q4 confirmation was run 13 seconds after the learning result was written and
both were committed together, so its "run once, after the learning verdict" order is not provable from git. The
books carry the Buy add-on picks and the R7 / D cut points are whole-window (see
[BL-144](t1-range-bound-days.md)); Q4 uses a fixed variant and fixed cuts in both runs. The result files are
git-ignored; regenerate with `research/bl145/run.py` (needs the TradingData volume).

## Open questions

- Does the same split hold with the opening range used to *skip* later wide entries rather than to rank
  them? Not tested; it needs the rule tester's locked confirmation period.
- The forward journal (from 2026-10-19) is the unseen set; one day so far.

[bl145]: ../../../backlog/BL-145-t1-robustness-lag-opening-range.md
