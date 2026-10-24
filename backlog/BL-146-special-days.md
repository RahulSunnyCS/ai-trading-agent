# BL-146 — How the fixed strategies, Core and T1 behave on special days (Budget, election results, RBI policy, high-premium days)

| | |
|---|---|
| **Priority** | P1 — the owner trades T1 and Core with real money and asked how they behave on event days and what, if anything, to add |
| **Status** | Done: E1 met, E2 met, E3 no change suggested; RBI days favour the fixed Widesl (lead only) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-21 |
| **Depends on** | BL-144 (`research/bl144/run.py` and its helpers), BL-145, BL-113 |
| **TODO.md row** | §3.39 |

## Context

Owner request, 2026-10-21: how do these strategies behave in Budget week and on special market days
(election results and the like, high premium), and is there anything to track or add to T1? The repo has no
calendar of event days (only the `BLOCKED_DATES` list the frozen engine reads), so the named days below were
confirmed from public sources on 2026-10-21 and are fixed here.

## Goal

A verdict for E1 to E3 below and a table of every event day, one row each.

## Out of scope

Any change to a pick, strategy or list. Charges, slippage and a basket stop (not asked for). A search over
event definitions or thresholds.

## Plan

### Phase 0 — Pre-register (committed before any figure of this item is computed)

- **Window and books:** all stored sessions from 2024-10-09 to 2026-10-19 for the fixed books (3 x Widesl
  09:17 and the Base, as in BL-144); Core and T1 are re-scored from the first session with 63 days of history
  (2025-01-10) as in BL-144, from the journal where it has an entry. Weekend sessions (the two Budget
  sessions) are shown for the fixed books only (the picker does not rank weekend sessions). Gross per lot-day,
  no stop, no charges. T1's setting-selection window ended 2025-10-08: every T1 figure before 2025-10-09 is
  marked in-sample for its settings.
- **Named days (the session that trades the event):**
  - Budget: Sat 2025-02-01, Sun 2026-02-01. **Budget week** = the 5 trading sessions around each
    (the two before and the two after; the Budget session itself is on a weekend).
  - Election results (reaction session): Mon 2024-11-25 (Maharashtra and Jharkhand, counted Sat 23 Nov),
    Mon 2025-02-10 (Delhi, counted Sat 8 Feb), Fri 2025-11-14 (Bihar), Mon 2026-05-04 (Assam, Kerala,
    Tamil Nadu, West Bengal, Puducherry).
  - RBI policy decision days (the third day of each MPC meeting, from the RBI's published schedules):
    2024-10-09, 2024-12-06, 2025-02-07, 2025-04-09, 2025-06-06, 2025-10-01, 2025-12-05, 2026-02-06,
    2026-04-08, 2026-06-05, 2026-08-05, 2026-10-07. The August 2025 meeting is left out: the sources
    disagree on its announcement day.
- **High-premium days (from the data, known at the open):** India VIX at the open at or above the 90th
  percentile of all stored sessions (and, separately, the 95th). Percentiles are of `days.csv`'s `vix_open`
  over the whole window, fixed once.
- **Per event row:** the date, the group, VIX at the open, the day's range (percent of the previous close),
  and each book's gross per lot-day; for Core and T1 also the share of wide-stop picks and the mean start time
  of the picks (as in BL-144).
- **E1 (T1 holds up on special days):** over all special sessions that have T1 picks (the named days and the
  VIX-premium days, each session once), T1's mean per lot-day is at least 0 and at least the Base's minus
  ₹250. Reported by group with the counts; a group with fewer than 8 sessions is shown row by row only.
- **E2 (tail):** T1's worst special-day result per lot-day is no worse than the worst of Core, Base and
  3 x Widesl on those days by more than ₹1,000.
- **E3 (should T1 get a premium-day adjustment?):** T1's mean per lot-day on VIX-premium days (at or above
  the 90th percentile) minus its mean on all other days. A premium-day adjustment is "worth testing" if the
  difference is below -₹300 and the 90% circular 5-day block bootstrap interval (2,000 resamples, seed
  20261021) is entirely below zero; otherwise "no change suggested". The same figure is shown for Core,
  the Base and 3 x Widesl.
- **Look-ahead:** the premium flag uses only the open; event dates are calendar facts known beforehand;
  nothing here selects a strategy.
- **Will not run:** other VIX thresholds, other event windows, adding events after seeing results (a new
  event needs a dated line in the Log before any figure).

### Phase 1 — Run and write up

- **Deliverables:** `research/bl146/run.py`, the event table (CSV), a findings page
  `research/options/common/special-days.md` and its index row.
- **Done when:** E1 to E3 each have a verdict against the rules above.

## Risks

Few events per group (Budget 2, elections 4, RBI 12); one stress period (March to April 2026) dominates the
high-VIX days, so the premium group is clustered. A re-scored T1 is not forward, and the first year of T1's
results is in-sample for its settings.

## Open questions

None.

## Log

- 2026-10-21 — created and pre-registered before any run. Event dates confirmed against public sources
  (RBI MPC schedules, ECI counting dates, the Budget sessions are in the store).
- 2026-10-21 — ran (`research/bl146/run.py`, 494 sessions). E1 met: over 60 special sessions T1 +929 per
  lot-day vs Base +537. E2 met: T1's worst special day -3,306 vs -3,511 to -3,792. E3: T1 premium (VIX >=
  18.37, 50 days) minus rest +506 [+91, +951]: no adjustment suggested. Groups: Budget week T1 +2,996 (8);
  elections T1 +482 (3); RBI T1 +997 vs 3 x Widesl +2,236 on the same 10 days (6 of 10 days Widesl ahead);
  premium T1 +1,049, 70% win. Findings page `research/options/common/special-days.md`; event table
  `research/bl146/out/events.csv` (git-ignored). The weekend Budget sessions have no picks.
- 2026-10-24 — **review caveats** (Opus review of PR #306; no result is changed, nothing was rerun):
  - E1 as run leaves out Budget week. Phase 0 names it among the special days, but `research/bl146/run.py`
    (line 173) builds the special set from the two Budget sessions themselves (weekends, so no T1 picks),
    elections, RBI days and VIX >= P90 only. With the 8 Budget-week sessions included E1 covers 67 sessions:
    T1 +1,119 vs Base +757, **still met**; E2 is unchanged (the review's recomputation).
  - Phase 0 says Budget week is "the 5 trading sessions around each" and explains it as two before and two after,
    which is 4; the code takes 4.
  - Phase 0 says Core and T1 are re-scored "from 2025-01-10 as in BL-144", but BL-144's window starts
    2025-10-20; the 2025-01-10 start is the first session with 63 days of history and is what the code uses.
  - T1 is pooled across its in-sample days (before 2025-10-09, Phase 0 says to mark them) in E1 and E3; only
    `events.csv` marks them. Split from `all_days.csv` (the review's recomputation): E3 is +1,426 on the 11
    in-sample premium days and +185 on the 39 out-of-sample ones (pooled +506 [+91, +951]); E1 in-sample is T1
    +1,765 vs Base +2,597, out of sample T1 +651 vs Base -150. The E3 verdict ("no change suggested") holds
    either way, but "better on premium days" leans on the in-sample days.
  - "Known at the open" (high-premium line in Phase 0) is overstated: the P90 VIX cut (18.37) is computed over
    the whole window, so whether a day is in the premium group is not known that morning. A label, not a gate.
  - The August 2025 MPC is left out as registered ("sources disagree"); the review believes the decision was
    announced on 6 Aug 2025, so it could have been included. Left as registered.
  - Risks said "RBI 11"; the list has 12 dates, and the Risks line now says 12 (outside Phase 0).
