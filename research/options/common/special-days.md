# Options: how do the fixed strategies, Core and T1 behave on special days?

**Status:** Tested (re-scored, not forward) · **Last updated:** 2026-10-21

## What it is

Behaviour on Budget days and the week around them, election-result sessions, RBI policy decision days and
high-premium days (India VIX at the open at or above the 90th percentile of all stored sessions, 18.37),
registered in [BL-146][bl146] before any figure. 494 sessions from 2024-10-09 to 2026-10-19 for the fixed
books (3 × Widesl 09:17 and the Base); Core and T1 are re-scored from 2025-01-10. Gross ₹ per lot-day, no
stop, no charges. T1's setting-selection window ended 2025-10-08, so T1's figures on earlier events are
in-sample for its settings (marked in the event table).

## Live value

None. Nothing in the picker reads a calendar or the VIX; the VIX band is only one of the journal's recorded
attributes.

## Tested

| Group (sessions) | 3 × Widesl | Base | Core | T1 |
|---|---|---|---|---|
| Budget day (2 weekend sessions, fixed books only) | +4,654 mean (+11,850 Sat 1 Feb 2025, −2,542 Sun 1 Feb 2026) | n/a | n/a | n/a |
| Budget week (8 sessions around them) | +4,423, 88% win, worst −2,662 | +3,399 | +2,897 | **+2,996**, 62% win, worst −1,170 |
| Election results (4 sessions; 3 with picks) | +1,402, 75% win | +506 | −32 | **+482**, 3 of 3 win |
| RBI decision days (12; 10 with picks) | **+2,830**, 67% win | +2,130 | +671, 50% win | +997, 50% win, worst −2,369 |
| High premium, VIX ≥ P90 (50) | +501, 46% win, worst −3,792 | +597 | +604 | **+1,049**, 70% win, worst −3,306 |
| High premium, VIX ≥ P95 (25) | +607 | +558 | +261 | +759, 60% win |
| All sessions (for reference) | +333 | +344 | +381 | +602 |

Verdicts under the registered rules:

- **E1 (T1 holds up on special days): met.** Over the 60 special sessions with T1 picks, T1 makes +929 per
  lot-day against the Base's +537, 3 × Widesl's +515 and Core's +503.
- **E2 (tail): met.** T1's worst special-day result is −3,306; the others' worst are −3,511 to −3,792.
- **E3 (a premium-day adjustment worth testing): no change suggested.** T1's mean on premium days minus its
  mean on the other days is **+506 [+91, +951]**: better on premium days, not worse. Core +252 [−110, +606],
  the Base +282 and 3 × Widesl +188 (intervals include zero).

## What we know

Descriptive; leads, not findings (few events per group, one stress period, re-scored picks).

- **High-premium days were good for every book, best for T1.** 33 of the 50 premium sessions fall in two
  clusters (April 2025 and March to April 2026); T1's 70% win rate there is its best regime so far.
- **RBI decision days favour the fixed 09:17 Widesl.** Over the 10 days where T1 has picks, 3 × Widesl made
  +2,236 per lot-day against T1's +997 (+804 against +163 without the one huge 9 Apr 2025, +15,122 for
  Widesl, +8,506 for T1). 3 × Widesl was ahead on 6 of 10 days; T1 was ahead on the 4 days Widesl lost
  (−2,844, −2,873, −2,662, −2,792). T1 lost on 5 of 10 RBI days. Twelve events is too few for a rule.
- **Budget week is positive for all, but the Budget session itself is two samples, a rich +11,850 and a
  −2,542 on a 3.43% range.** Both are weekend special sessions, so the picker has no picks for them and the
  option data for a special session was not separately checked here.
- **Election-result days were mild**; the one that hurt the fixed books (4 May 2026, VIX 18.5, 3 × Widesl
  −2,675) was a gain for T1 (+512).
- **T1 picks barely change with the premium.** Its wide-stop share is 38% on premium days against 33% on
  the others (Core 68% against 71%), so its edge on those days is not from switching style.

## Open questions

- Whether a rule keyed on RBI days (favour the 09:17 Widesl) beats T1's own picks. Not registered, 12 events;
  the forward journal adds about six RBI days a year.
- Whether a stress episode like March to April 2026 repeats: the premium group is two clusters.

[bl146]: ../../../backlog/BL-146-special-days.md
