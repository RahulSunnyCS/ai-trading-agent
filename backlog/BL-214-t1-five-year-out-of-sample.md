# BL-214 — Adaptive Tuned and Core Adaptive over five years: results for the days before 9 Oct 2024, scored out of sample

| | |
|---|---|
| **Priority** | P1 — it prices the rule T1's real money runs on: T1's forward record is 12 days and its paper drawdown is at the deepest of the stored two years |
| **Status** | Done — informative: before T1's settings were chosen, over 2021-11 → 2024-10-08 (NIFTY only), neither Adaptive book beat the fixed base (T1 −₹114 [−222, −10] per lot-day after 0.5 % slippage) and T1 did not beat Core (+₹1 [−73, +73]); see Log |
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
- 2026-11-06 — **Phases 1-4 run** (`research/bl214/backfill.py`, `anchor.py`, `score.py`; results `score_old_2026-11-06.json`,
  `score_insample_2026-11-06.json`; the store itself is in `TRADING_DATA_ROOT/_bl214/`, symlinks to the lake and the quality
  snapshot plus its own `rotation/`, not committed).
  **Data.** 785 sessions run (2021-08-02 → 2024-10-08): 45 weekdays had no NIFTY option file (holidays), 2 were excluded by
  `data_quality` (Diwali Muhurat sessions, 2021-11-04 and 2022-10-24); 322 NIFTY variants (Core-298's 149 and 173 T1 extras) ×
  785 days, every file complete, 0 errors; the share of variant-days with no trade was 0.6-0.9 % in every year (the thin chain
  cost no strike coverage that shows). The ranking needs 63 earlier rows, so 722 sessions are scored (2021-11-02 →
  2024-10-08), none left out. **Anchor** (Phase 0, run before any older day was read): the live store's rows for 2024-10-09 →
  2025-01-31 (79 sessions) reproduced to the rupee, 50,876 variant-days including the 0.5 % slippage copies, 0 differences.
  **Deviations, none touching a registered rule:** (1) `lot_sizes.csv` starts in 2024-10, and the engine looks up every
  contract's lot size even under `lot_sizing: current`, so 778 days failed at first; the backfill wraps the reference data so
  a contract expiring before the table falls back to the sizing date's lot (the lot actually used under `current`, unchanged;
  no strategy in these folders is `historical`), applied also to the slippage copies and the base's Dir leg; (2) the first
  slippage copies were skipped for the same reason and were filled by re-running; (3) **added before reading any result:** the
  same NIFTY-only books scored over 2024-10-09 → 2026-11-06 (507 sessions) as a like-for-like in-sample comparator, because the
  Books table's +₹254 includes SENSEX picks. Net per day below is the three core picks at one lot each (per lot-day = ÷ 3);
  "beats random" is the share of 1,000 random same-shape baskets (gross, the day's NIFTY pool) the book's window total was above.

  **Registered reading (T1 − base, per lot-day, after 0.5 % slippage, all 722 days):** −₹114 [−222, −10], T1 ahead on 45 % of days,
  −₹149 without the best 5. Pass needs the range above zero and a mean of at least ₹127; kill needs a range that includes zero
  and a mean under ₹64. The range here lies wholly **below** zero, a case the rule did not name, so by its letter the answer is
  "no evidence either way"; read plainly, the in-sample lead over the base is **not reproduced** before T1's tuning. Without
  slippage the same gap is −₹68 [−176, +36], which by the letter is a kill. The rule is not edited after the run.

  | 2021-11 → 2024-10-08, 0.5 % slippage | Net/day | Win | Max DD | Worst day | Beats random |
  |---|---:|---:|---:|---:|---:|
  | Core (N-only) | +515 | 57 % | −26.8k | −9.7k | 100 % |
  | T1 (N-only) | +518 | 56 % | −66.1k | −13.9k | 100 % |
  | Fixed base | +860 | 61 % | −44.9k | −10.0k | 100 % |

  Gaps per lot-day (0.5 % slippage): Core − base −₹115 [−215, −18]; T1 − Core +₹1 [−73, +73]. By segment: 2021-11 → 2022-03 (never
  read before, 102 days) T1 − base −₹60 [−436, +350]; 2022-04 → 2024-10-08 (the named P3, 620 days) −₹123 [−226, −22]. By year:
  2021 +₹73 [−532, +739]; 2022 −₹121 [−301, +43]; 2023 +₹68 [−64, +195]; 2024 to 8 Oct −₹382 [−606, −163] (T1 +₹70 a day, Core +₹533,
  base +₹1,217). **Like-for-like in-sample (2024-10-09 → 2026-11-06, same NIFTY-only books):** T1 − base +₹10 [−139, +156],
  Core − base −₹99 [−243, +37], **T1 − Core +₹109 [+34, +187]**: T1's edge over Core appears only in the period it was tuned on.

  **Drawdown placement (T1, net, 0.5 % slippage, one lot a strategy).** Deepest −₹66,068 on 2024-09-20, an episode that began 2024-06-19 and was
  still open on 2024-10-08 (77 sessions, 66 to the trough). Depth reached on 25 / 10 / 5 / 1 % of days: ₹14.3k / 20.9k / 30.9k /
  55.6k; **5.1 % of days were at least as deep as today's −₹29.5k** (4.8 % as deep as the 2026 low of −₹32.4k); under water on 83 % of days.
  16 episodes of ₹15k or more, 15 recovered in 7-56 sessions from their start (e.g. 2021-12-07, ₹33.3k, 41 sessions; 2023-11-17,
  ₹25.2k, 56). Core's deepest −₹26.8k, the base's −₹44.9k. In the like-for-like in-sample window T1's deepest is −₹37.6k (2026-03-06,
  84 sessions) and the current episode from 2026-10-27 is ₹26.1k, open.
  **The three deepest T1 episodes** each followed a strong run: in the ten sessions before the high T1 made +₹39k / +62k / +45k and
  beat 80 / 100 / 100 % of random baskets; from the high to the trough it lost ₹35.1k / ₹25.6k / ₹18.4k and beat 3 / 1 / 2 %, while
  Core made −₹0 / −6.5k / −9.6k (35 / 38 / 28 %) and the base +5.6k / −7.8k / −6.4k (46 / 32 / 47 %). That is the shape of the present
  stage (T1 −₹22.0k, 0 % of random, the base +₹40.6k, from 27 Oct), at the size of its two smaller predecessors.

  **NIFTY-expiry days (153 sessions, label 0), two books of 6 lots, 0.5 % slippage:** 2×T1 +₹2,873 a day, 2×Core +₹2,640, Core + T1 +₹2,757;
  win 63 / 63 / 68 %; return over the 153 days on ₹17L 25.9 / 23.8 / 24.8 %; max DD −₹73.6k / −48.5k / −50.4k; without slippage +₹3,795 /
  +3,329 / +3,562. About half of the 2025-26 figure (which includes SENSEX picks). **All 722 days:** +₹1,036 / +1,031 / +1,033 a day, max DD
  −₹132.1k / −53.5k / −84.7k, worst day −₹27.8k / −19.3k / −22.4k (without slippage +₹2,033 / +1,906 / +1,970).

  **What this does and does not say.** The T1 results are for the NIFTY half of T1 only; the live book's SENSEX picks are untested (no
  usable SENSEX days before 2025). The variant set is today's, chosen with later knowledge, and 2022-04 → 2024-10 was read before as a
  confirmation period for single-variable studies; 2021-11 → 2022-03 is the part never read, and it is too short (102 days) to settle
  anything alone. The fixed base beat both Adaptive books over these three years: the ranking's lead over a fixed 2 × Widesl 09:17 + Dir
  09:24 was not there before 2024-10. Descriptive and in-sample; nothing live changes. Phase 4's findings page: `research/options/common/rotation-ranking.md`.
