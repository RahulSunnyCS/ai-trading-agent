# BL-145 — Is T1's year broad, does it lag regime changes, and can the opening range split quiet weeks?

| | |
|---|---|
| **Priority** | P1 — follows BL-144; the owner trades T1 with real money and wants to know whether the lead is real |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-21 |
| **Depends on** | BL-144 (the daily table `research/bl144/out/daily.csv`, the R7 regimes), BL-110 (opening range), BL-113 |
| **TODO.md row** | §3.38 |

## Context

BL-144 gave a year of daily results (238 sessions, 2025-10-20 to 2026-10-19) and found T1 leans only
partly to wide strategies in quiet weeks, while all-wide from 09:17 would have done worse because 13 of 80
quiet-week days turned wide. The owner asked for three follow-ups (charges, the fourth idea, was left out as
expensive): (2) whether T1's lead is broad or a few days, (3) whether T1 lags when the regime changes,
(4) whether the opening range can tell a quiet day from a wide one inside a quiet week.

## Goal

A verdict for each of the three, against the rules below.

## Out of scope

Charges and slippage (owner's call, 2026-10-21). Any change to a pick, list or strategy. A search over cut
points, windows or measures.

## Plan

### Phase 0 — Pre-register (committed before any figure of this item is computed)

Common: the BL-144 window and daily table; R7, D and their tercile cut points exactly as in BL-144
(R7 cuts 0.7477% / 1.0537%, D cuts 0.6818% / 1.0349%); per lot-day = a book's gross divided by its lots; 90%
circular 5-day block bootstrap, 2,000 resamples, seed 20261021. Gross, no stop, no charges.

- **Q2, breadth.** For each book (3 x Widesl, Base, Core, T1): the total without its best 5 and best 10 days,
  the number of calendar months (Nov 2025 to Sep 2026, the 11 full months) with a positive total, and the
  bootstrap interval of its mean per lot-day. **T1's lead is "broad"** if its total without its best 10 days
  is at least 50% of its full total, at least 8 of the 11 months are positive, and the bootstrap interval of
  T1 minus Core per lot-day is above zero. Anything less: "concentrated" (say which condition failed).
- **Q3, lag after a change.** A **surprise-wide day** = R7 at or below its low cut and the day's own range D
  at or above its high cut (13 days in BL-144). A **calm-down day** = R7 at or above its high cut and D at or
  below its low cut. For each book: the mean per lot-day on the event day, on the next 1 to 5 sessions
  (pooled), and the book's own all-day mean. **T1 lags** if its mean over sessions +1 to +5 after a
  surprise-wide day is below its all-day mean by more than ₹300 and the bootstrap interval of that difference
  (events resampled in blocks of 1) is entirely below zero. The same for calm-down days. Counts of events are
  reported; with fewer than 8 events a verdict is "too few".
- **Q4, opening range gate.** OR = (highest high minus lowest low over the 1-minute index bars from 09:15 to
  09:44) as a percent of the previous close. Terciles of OR over the main window's days (cut points fixed
  from it). Measure: on **quiet-week days** (R7 at or below its low cut), the mean per lot-day of the Core
  variant `N_wide_0947` (Widesl OTM1 entering 09:47, after the opening range is known) when OR is in the
  lowest third minus when it is in the highest third. The gate **works** if that difference is at least
  +₹500 and its bootstrap lower bound is above zero. Also reported: the share of quiet-week days with a wide
  range (D at or above its high cut) by OR third.
  **Confirmation, run once after the learning verdict is recorded:** the same rule, with the same cut points
  (R7 and OR cuts from the main window), over 2024-10-09 to 2025-10-17 (the year before). It is confirmed if
  the difference has the same sign and is at least +₹250; the interval is reported. `N_wide_0947` is a Core
  variant that T1's setting selection did not touch. No parameter is changed between the two runs.
- **Look-ahead:** R7 uses sessions before the day; OR uses bars up to 09:44 and gates only a 09:47 entry.
- **Will not run:** other OR windows, other cuts, other variants for Q4, a sweep of the thresholds.

### Phase 1 — Run and write up

- **Tasks:** `research/bl145/run.py`; findings page `research/options/common/t1-robustness-and-lag.md` and
  the index row; this Log.
- **Done when:** each of Q2, Q3, Q4 (learning and confirmation) has its verdict against the rule above.

## Risks

Few surprise-wide days; clustered quiet weeks; a re-scored T1 is not forward. The confirmation year is still
the same strategy universe, so it tests a different sample, not a different market.

## Open questions

None.

## Log

- 2026-10-21 — created and pre-registered before any run. The owner chose Q2 to Q4; Q1 (charges) not run.
