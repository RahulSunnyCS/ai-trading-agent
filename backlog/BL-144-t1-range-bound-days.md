# BL-144 — Daily results of the fixed strategies, Core and T1 over the last year, and does T1 move to wider stops on range-bound days?

| | |
|---|---|
| **Priority** | P1 — the owner trades T1 and Core with real money; the recent directional days favour T1, and a stretch of range-bound days is the case T1 has not been seen in |
| **Status** | Done: H1 not met (+10.0 pp, rule +15 pp), H2 met; findings page written |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-21 |
| **Depends on** | BL-113 (T1 track), BL-110 (index range persistence), BL-095 (portfolio stop), BL-058 (journal and results) |
| **TODO.md row** | §3.42 |

## Context

Owner request, 2026-10-21. Two fixed strategies, run every day: (1) 3 lots of NIFTY Widesl OTM1 at
09:17, (2) the registered base, 2 lots of Widesl OTM1 at 09:17 plus 1 lot of Dir ATM at 09:24; each with a
₹10,000 basket stop. The owner wants every day of the last year in one table with the day's result, the
weekday, the day's NIFTY range and the range of the previous 7 days, with Core (Adaptive Classic) and T1
(Adaptive Tuned) beside them. Then a question: on range-bound days, is T1 adaptive enough to move to
wider stops? Recent days were directional and T1 caught them.

## Goal

1. The table: one row per trading day of the window, four books, each with and without the basket stop,
   plus the day's range and the previous-7-day ranges. Delivered as CSV and in the findings.
2. The study below, with its verdict written against the rule fixed here.

## Out of scope

Any change to a pick, list, weight, strategy file or stop. No new variants. No threshold search.

## Plan

### Phase 0 — Pre-register (committed before any figure is computed)

- **Hypothesis:** H1 (selection): T1's picks contain a larger share of wide-stop strategies on range-bound
  days than on volatile days. H2 (outcome): T1 is not worse than the fixed base on range-bound days.
- **Universe and window:** NIFTY trading days from 2025-10-20 to the last day with stored results (the
  results end 2026-10-19 at registration). The window starts after T1's setting-selection window
  (2024-10-09 to 2025-10-08), so the T1 settings were not chosen on these days. The picker's weights were
  chosen on the first research period, so T1 and Core picks are re-scored, not forward, except from
  2026-10-19 (the journal's days). The expiring-index rule (BL-122) is not applied to re-scored days.
- **Books (all 1 lot per strategy, gross, before charges):**
  - W3 = `N_wide_0917` x 3 lots.
  - BASE = `N_wide_0917` x 2 + `N_dir_atm_0924` x 1 (the registered base).
  - CORE = Adaptive's three core picks per day (list C), re-scored by `daylog.reconstruction` over
    Core-298, the journal's entry from 2026-10-12.
  - T1 = Adaptive over Core-298 plus the 223 T1 variants, re-scored the same way, the T1 journal's entry
    from 2026-10-19.
  - Each shown without a stop and with the ₹10,000 basket stop (`portfolio.book_day`, each strategy
    keeping its own per-lot stop). A 3-lot strategy is three times the one-lot path, so its own MTM
    stop scales with the lots (AlgoTest's quantity multiplier would keep ₹2,500 in total; noted).
- **Range measures (NIFTY index 1-minute bars, `regime.day_ranges`):** D = the day's (high - low) as a
  percent of the previous close. R7 = the mean of D over the 7 sessions before the day (known at the
  open, so no look-ahead). H7 = the highest high minus the lowest low over those 7 sessions, as a percent
  of the previous close. Points are shown beside the percents.
- **Regimes:** R7 terciles over the window's days (lowest third = **range-bound**, highest third =
  **volatile**). The cut points are the 33rd and 67th percentiles of R7 in the window, nothing tuned.
  D terciles (the day's own range) are used only to read outcomes, never to explain a pick.
- **Wide stop:** a pick is **wide-stop** if the leg stop loss in its strategy file is at least 100%
  (Widesl family and its T1 relatives); every other pick (Dir, ITM1, Buy, tighter-stop Widesl) is not.
  The share is wide-stop picks over all core picks in the regime's days. The mean leg stop percent is
  reported beside it.
- **H1 pass rule:** share(range-bound) minus share(volatile) for T1 is at least +15 percentage points and
  the 90% 5-day circular block bootstrap interval (2,000 resamples, seed 20261021) is above zero. Below
  that, T1 is reported as not adaptive toward wide stops. The same statistic for CORE is the comparator.
- **H2 rule:** on D-range-bound days (lowest D tercile), T1's mean per-lot-day net of the stop is at least
  BASE's, minus ₹250. Reported with the same bootstrap interval for T1 minus BASE; the verdict is
  descriptive when the interval includes zero.
- **Look-ahead:** R7 uses sessions strictly before the day; picks use the rotation's own history (rows
  before the day). Survivorship: every trading day with stored results is a row; a day missing a result
  for any of a book's picks is listed and left out of that book, never zero.
- **Hold-out:** forward days from 2026-10-19 are the unseen set; with one day, nothing is read from them.
- **Will not run:** other tercile cuts, other thresholds, other range measures as the verdict, a search
  over stop levels. Any of these needs `override: <reason>` in the Log.

### Phase 1 — The table and the study

- **Tasks:** `research/bl144/` script reading only the stored results, the lake's index bars and the
  journals; write CSV and a summary under its own folder (git-ignored output).
- **Deliverables:** the CSV, the regime tables, the verdicts, a findings page
  (`research/options/common/t1-range-bound-days.md`, cited in `research/options/README.md` if it has an
  index).
- **Done when:** every figure in the findings page comes from the CSV, each rule above has its verdict,
  and the findings page and this item's Log agree.

## Risks

- A year has few distinct regimes; terciles of a persistent series mean the days are clustered, so the
  block bootstrap interval is wide. The findings say so.
- Re-scored picks are not forward evidence. The weights were chosen on the first research period.
- A wide stop is a settings label, not a measure of how much risk the pick carries.

## Open questions

None: the owner answered the entry time (09:17), the 7-day range (both measures), the T1 stop (₹10,000)
and that Core is a column.

## Log

- 2026-10-21 — created and pre-registered before any run. Owner choices: 3 x Widesl at 09:17, both 7-day
  range measures, T1 at 1 lot with the ₹10,000 stop (also shown without), Core as a fourth column.
- 2026-10-21 — **owner dropped the basket stop** before any run ("stop loss study is not required ... just
  give the without stop loss"). Every book is shown gross and without a stop; no `portfolio.book_day`
  replay is run. This narrows Phase 0 only: H2 is judged on the no-stop per-lot-day figure (the same
  threshold, BASE minus ₹250), the other rules are unchanged. Logged here before the first figure.
- 2026-10-21 — ran (`research/bl144/run.py`, 238 days 2025-10-20 to 2026-10-19, nothing left out). H1: T1's
  wide-stop share is 33.7% in range-bound weeks and 23.7% in volatile weeks, +10.0 pp [+1.0, +19.0], below the
  registered +15 pp: not met; Core +7.6 pp [+2.1, +13.3]. H2: T1 minus Base on quiet days +78 per lot-day
  [-172, +338], met (descriptive). Findings page `research/options/common/t1-range-bound-days.md`. The
  owner's CSV is `bl144_daily_results.csv`. Exploratory only: family mix by regime; one day (3 Feb 2026)
  makes 42% of the 3 x Widesl year.
- 2026-10-21 — **addendum, registered before it was computed** (owner: "on the quiet days, is T1 able to
  start all the wider SL from the morning so that it captures more move?"). Descriptive only, on the same
  238 days and R7 regimes, no pass/kill rule. Measured per regime (R7 terciles, T1 and Core): the mean start
  time of the day's picks, the share of picks starting by 09:47 ("morning"), the share of wide-stop picks
  (every leg SL at least 100%) that start by 09:47, the share of days on which every pick is wide-stop, and
  the share of days with at least one morning wide-stop pick. Counterfactual: T1 against the fixed 3 x Widesl
  09:17 ("all wide, from the open") per lot-day by R7 regime and where R7 and the day's own range are both
  lowest, to see what going all-wide from the morning would have earned when the week was known to be quiet.
- 2026-10-21 — addendum ran (`research/bl144/morning.py`, `out/morning.json`). In quiet weeks T1's wide-stop
  picks start at 10:00 on average (68% by 09:47) against 12:09 in volatile weeks; every pick is wide-stop on
  13.8% of quiet-week days and at least one morning wide-stop pick on 41% (Core 28.8% / 63.8%). All-wide from
  09:17 (3 x Widesl) in quiet weeks: +119 per lot-day against T1's +554 over 80 days; it wins on the 40 days
  that stayed quiet (+1,037 vs +809) and loses on the 13 that did not (-1,637 vs +1,225). Written into the
  findings page.
- 2026-10-24 — **review caveats** (Opus review of PR #306; no result is changed, nothing was rerun):
  - The CORE and T1 books in `research/bl144/run.py` (lines 85-89) add the Buy add-on pick (`C.buy`) to
    Adaptive's picks, but Phase 0 defines them as "Adaptive's three core picks". 34 T1 days and 36 Core days
    have four picks, so the add-on enters the gross and the H1 denominator. Without it H1 is +10.4 pp for T1 and
    +8.3 pp for Core (the review's recomputation): still below the registered +15 pp, so **H1 stays not met**.
    The same `picks_for` helper is used in BL-145 to BL-147. The findings page now says the books are core
    picks plus the Buy add-on.
  - "Known at the open" (Phase 0 and the findings page) is overstated. R7 itself is known at the open, but the
    R7 and D tercile cut points are computed over the whole window, so which tercile a day falls in is not
    known that morning. Harmless for descriptive labels; do not read them as a tradable gate.
  - Registration timing git cannot show: the narrowing logged above (no basket stop; H2 judged on the no-stop
    figure) was committed together with the results, so "logged here before the first figure" rests on the
    owner's word and the file timestamps, not on commit order. Next time commit the amendment first.
  - The wide-stop helper differs between scripts (`run.py` keeps legs with `stop_loss.percent`, `morning.py`
    keeps any leg with a `stop_loss`); they agree on today's strategy files. `bl144_daily_results.csv`, named
    above, is not written by any committed script (`run.py` writes `daily.csv`).
- 2026-10-24 — TODO row renumbered 3.37–3.40 -> 3.42–3.45 on 2026-10-24 after #304 took 3.37.
