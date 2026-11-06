# BL-214 — Adaptive Tuned and Core Adaptive over five years: results for the days before 9 Oct 2024, scored out of sample

| | |
|---|---|
| **Priority** | P1 — it prices the rule T1's real money runs on: T1's forward record is 12 days and its paper drawdown is at the deepest of the stored two years |
| **Status** | Ready (owner answered the open questions 2026-11-06; pre-registration below; not run) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-06 |
| **Depends on** | BL-058 (lists, journal, store), BL-113 / BL-115 (T1 track and its settings), BL-034 (vendor history in the lake), BL-122 and BL-192 (expiry rule and SL150% cap, applied as if live); overlaps BL-213 (walk-forward on 2025–26) and BL-100 (the P3 window) |
| **TODO.md row** | — (filled in when started) |

## Context

Owner, 2026-11-06, after seeing T1's drawdown: "Can we test the T1 back to last 5 years", then "If we
don't have the data lake, can we add it".

**The lake is already there; the missing piece is T1's results.** `tdata status` on 2026-11-06:
NIFTY option 1-minute bars from 2013-12-12 (about 245 sessions a year), SENSEX options only from
2023-07-26 but only **sparsely before 2025** (81 days in 2023, 75 in all of 2024, 76 of the 99 before
2024-10-09 judged usable; full years from 2025), index and India VIX bars and the 5-minute
chain, straddle and contract tables from 2015. The rotation store starts at 2024-10-09 (`days.csv`, 507
rows), because the 298 Core variants and T1's extras have only ever been run from there (the
ranking needs 63 earlier days, so the first ranked day is January 2025). Five years back is November
2021; for that whole stretch, to 2024-10-08, the data is in effect NIFTY only: SENSEX has about 99 scattered
days there, too few and too patchy to rank a SENSEX universe. The NIFTY chain is also thin then (median 140–170
contracts a day in 2021–23, 295 in 2024, against 830–940 in 2025–26) and `data_quality` excludes only 5 of
about 730 NIFTY days in the window.

**What has and has not been read before.** `rotation/matrix.py` already names P3 = 2022-04-05 →
2024-10-08, NIFTY only, "not in the rotation store". P3 was read as a confirmation period for
single-variable studies (BL-081's states, the strike-premium and VIX pages under
`research/options/strategies/`); BL-100 planned a restricted-list test on it and has not run. Nothing
reads 2021-08 → 2022-03. T1's settings were chosen on the 2024-10 → 2025 window and the BL-113 /
BL-115 selection (to be confirmed at start: whether any T1 setting used P3).

**Where T1 stands today** (paper, one lot a strategy, 0.5% slippage): −₹29.5k from its high of 26 Oct,
3.5% of one ₹8.5L account, the second-deepest of the 442 stored days (deepest −₹32.4k on 5 Oct); over
the current stage it finished below 100% of random baskets on 4 Nov and 99% on 6 Nov while the fixed
base was up ₹40.6k. Forward record: 12 of 60 days (BL-135), −₹227 per lot-day.

## Goal

Per lot-day net after costs and 0.5% slippage, drawdown, worst day, win rate and the share of random
baskets beaten, for **T1, Core Adaptive, the fixed base** over 2021-11 → 2024-10-08, so that:
1. how much of T1's lead over the base and over Core exists before it was tuned is a number;
2. how deep and how often T1's drawdowns ran, and how long they took to recover, is a table, so
   today's −₹29.5k can be placed in it;
3. the NIFTY-expiry-day table, the three-way comparison (2×T1, 2×Core, Core + T1) and the drawdown
   stages already done for 2025–26 exist for the earlier years too.

## Out of scope

Any change to T1's or Core's live settings; re-tuning or a new strategy variant; SENSEX before
2023-07-26 (no data); the 2025-01 → 2026-11 window (already stored, BL-213's); anything after
2024-10-08; Buy add-on (core picks only, as BL-207); Dir ×2, book stops and slippage-aware sizing (a
second reading may add them, the primary does not).

## Plan

### Phase 0 — Pre-register (committed before any run)
- **Hypothesis:** T1's 09:16 rule, with each day's picks re-derived from earlier rows only, beats the
  fixed base per lot-day after 0.5% slippage on the days before its tuning, and a drawdown as deep as
  today's has happened before.
- **Universe:** the 298 Core variants plus the T1 track's variant files as they are today, run on every
  lake day 2021-08-02 → 2024-10-08 that `data_quality` judges usable (exclusions counted and listed,
  with the reason). Results from 2021-08-02 so the first scored day is the first session after 63
  earlier days (about 2021-11-01). Over the whole window only the NIFTY variants are run (SENSEX has
  about 99 scattered days there): the result is "NIFTY-only T1 and Core" (the Widesl-minimum rule applying to
  NIFTY's Widesl), never pooled with the two-index 2025–26 results without saying so, and the live T1's
  SENSEX picks are not tested at all. Owner, 2026-11-06: run it as its own segment. **Point-in-time caveat:** the
  variant set is today's, chosen with later knowledge; it cannot be made point-in-time, only flagged.
- **Book and picks:** list C as in BL-207 / BL-204: expiring-index rule (`expiry.filter_picks`) and SL150%
  cap (`sl150_cap.cap_picks`) applied throughout as if live, core picks only, Buy left out; the
  weekday-to-expiry labels from the lake's real expiry list (`tdata reference derive-expiries`), not from
  the outcome. Core = Core-298 alone, T1 = Core-298 plus the track, the fixed base = 2 × `N_wide_0917` +
  `N_dir_atm_0924`, random baskets = `rotation/beats.daily` (2,000 same-shape draws).
- **Look-ahead check:** day d's ranking and weights use rows before d only (`pick.score_history`); VIX
  open from the 09:15 bar; lot sizing the engine default (`current`); an **anchor**: the backfill code run
  on 2024-10-09 → 2024-10-15 in the separate root must reproduce the stored results to the rupee before any
  older day is trusted; the run writes to a separate rotation root, never the live store or journal.
- **Primary reading:** gross − stored costs, then the 0.5% slippage copy, one lot a strategy, no book
  stop (AlgoTest has none). Second reading: the book stop per `portfolio.apply_book`.
- **Pass / kill rule (T1 − base per lot-day, after 0.5% slippage, 90% circular block bootstrap, 5-day
  blocks, 2,000 resamples, seed 20261106):** **pass** if the range over all scored days is above zero and
  the mean is at least half of the 2025-01 → 2026-11 gap (+₹254 per lot-day over two years, BL-213);
  **kill** (for the claim that the lead is not just the tuning) if the range includes zero and the mean is
  under a quarter of it; anything else is "no evidence either way". Reported by segment (2021-11 →
  2022-03, never read before; 2022-04 → 2024-10-08, the named P3 window) and by year;
  with 5 and 10 best days removed.
- **Descriptive, not a gate:** the drawdown ladder (depth 25 / 10 / 5 % of days reached, as `standing.py`),
  every episode at least ₹15k per lot deep with its length and recovery, the share of days as bad as −₹29.5k,
  win rate, profit factor, the share of random baskets beaten (all days and each drawdown stage), and the
  table of the three combinations (2×T1, 2×Core, Core + T1) on all days and on NIFTY-expiry days.
- **Hold-out:** none held back. Unseen until now: 2021-08 → 2022-03. Read before as a confirmation period
  for other studies: 2022-04-05 → 2024-10-08, so the two are reported apart and the claim "out of sample"
  is made only for what a segment's history supports (to be settled at start with the owner's answer to
  question 3).
- **Strike coverage:** a variant that cannot find its strike on a thin-chain day (closest-premium and far-OTM
  settings first) is counted per variant and per year; a day is scored only with the variants that have a
  result, and the Log states how many of the 298 each year had.
- **Will not run:** re-fitting any weight, lookback or variant on the older days; a second pass with
  different windows; SENSEX variants before 2025; an intermediate peek at the results before the
  anchor passes.

### Phase 1 — Data readiness
- **Tasks:** list lake days per year and `data_quality` verdicts for 2021-08 → 2024-10-08; check chain,
  straddle, VIX and expiry-list coverage; build the day rows (`vix_open`, band, `dte_n`, `dte_s`, weekday)
  for those days in the separate root; decide the separate root's location and disk use.
- **Deliverables:** a coverage table (usable, excluded and why, per year and index); the day file.
- **Done when:** every day in the window is classed usable or excluded with a reason, and the expiry labels
  were checked against the contracts listed that day.

### Phase 2 — Anchor and timing
- **Tasks:** point the backfill at the separate root; run 2024-10-09 → 2024-10-15 and compare with the
  stored rows; time one week of 2023.
- **Deliverables:** the match report; seconds per day, so the full run's length is known.
- **Done when:** the anchor week reproduces to the rupee (any difference explained or the run stops) and the
  full run's duration is written here.

### Phase 3 — Backfill
- **Tasks:** run the 298 + T1 variants, the base's Dir leg and the 0.5% slippage copies over the window,
  resumable, in the separate root; NIFTY variants only before 2023-07-26.
- **Deliverables:** results and slippage copies per variant; a list of days missing a result and why.
- **Done when:** every usable day has every result or is listed as missing; nothing in the live store changed
  (checked by file hashes).

### Phase 4 — Score and report
- **Tasks:** reconstruct list C picks day by day for Core and T1; score against the base and random baskets;
  produce the Phase 0 tables; update the findings pages (`research/options/strategies/…` and
  `research/README.md` rules) in the same commit as the Log entry; re-base BL-213's note on what it needs.
- **Deliverables:** `packages/option-backtesting/research/bl214/` scripts, the JSON beside them, the Log.
- **Done when:** the pass / kill rule is applied, the drawdown placement of today's −₹29.5k is stated, and
  the three-way and NIFTY-expiry tables are in the Log.

## Risks

- The vendor files: 19% of contract files were empty (BL-034's conversion report); a day short of the strikes
  a strategy needs is excluded and counted, which can thin the sample unevenly by year.
- The variants and the picker were built with 2024-10 → 2026 in view, so the older days are cleaner but not
  pristine; P3 specifically was read by single-variable studies.
- Weekly expiry regime: NIFTY expired on Thursday until September 2025; liquidity and spreads in 2021–22 differ
  from today, and 0.5% slippage may under- or over-state them. A NIFTY-only stretch is a different book (no
  SENSEX Widesl or Dir), so the segments do not add up to one number.
- Run length is unknown until Phase 2 (about 300 variants over about 800 days).
- Lot size is `current` throughout (the engine default), so rupee figures are at today's lot, as everywhere else.

## Open questions

Answered by the owner on 2026-11-06 (recorded in the Log):
1. Start 2021-11, the full five years. 2. The NIFTY-only stretch is its own segment. 3. (Checked, not asked:
BL-113 says T1's time-generic settings were chosen on 2024-10-09 → 2025-10-08 only, so every day in this window
is before any T1 choice; the 298-variant universe and single-variable studies did read 2022-04 → 2024-10, as
stated in Context.) 4. Run on the Mac overnight into a separate root, one timed week first. 5. Run beside
BL-213, which stays as planned.

Still open: how much disk the separate root may use (decided at the Phase 1 timing); whether the 76 usable
SENSEX days before 2024-10-09 are worth a small separate look (default: no).

## Log

- 2026-11-06 — Created from the owner's question and the follow-up on the data lake. Priority P1 (judged: T1's real
  money runs on a rule with 12 forward days and a drawdown at its two-year deepest). Phase 0 filled in; nothing run.
- 2026-11-06 — Owner answered the open questions: start 2021-11; NIFTY-only stretch as its own segment; run on the Mac
  overnight in a separate root after one timed week; run beside BL-213. Corrected Context and Phase 0 after checking
  `data_quality`: SENSEX before 2025 is sparse (about 99 days before 2024-10-09), so the whole window is NIFTY-only, not
  only the part before 2023-07; the NIFTY chain is thin before 2025 (140–170 contracts a day median), with only 5 of
  about 730 days excluded; strike coverage per variant added to Phase 0. Status Ready.
