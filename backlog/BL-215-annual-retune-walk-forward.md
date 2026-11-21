# BL-215 — Annual re-tune of Adaptive Tuned (T1): does "sweep one year, take the best, trade the next" hold up out of sample?

| | |
|---|---|
| **Priority** | P2 — it decides how T1 is kept up to date while real money trades it; heavy compute, and the 60-session forward read-out (BL-135) comes first |
| **Status** | Done — no evidence either way: re-tuning every period did not reliably beat fixed Core Adaptive out of sample (12-month folds +₹4 [−41, +49] per lot-day after 0.5 % slippage, 2 of 4 folds won; 6-month folds +₹32 [−23, +90], 6 of 9), and neither book reliably beat the fixed base; T1 is not to be re-tuned on a schedule; see Log |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-07 |
| **Depends on** | BL-113 / BL-115 / BL-106 (how T1's settings were chosen), BL-104 (the sweep grid), BL-214 (the NIFTY-only 2021 → 2024 store); absorbs BL-213 (its one fold is F4 below) |
| **TODO.md row** | 3.10.66 |

## Context

Owner, 2026-11-07, after the BL-214 results: T1's settings came from an overnight sweep of all the
strategies over 2024-10-09 → 2025-10-08, taking the best; "maybe for each year we need to run this and
update something like that."

What is already known:
- BL-113: T1's time-generic settings were chosen on 2024-10-09 → 2025-10-08 only, and beat Adaptive on
  Core-298 over the unseen year 2025-10-09 → 2026-10-09 by +₹204 net per lot-day (90 % [+82, +361] gross),
  the same size as its in-sample year (+₹216). That is **one** out-of-sample fold.
- BL-214 (NIFTY only, before the tuning): T1 − Core was +₹1 [−73, +73] over 2021-11 → 2024-10-08, and in the
  first nine months of 2024 T1 earned ₹23 per lot-day against Core's ₹178 (drawdown −₹66k). After the
  tuning start, T1 − Core is +₹109 [+34, +187], and +₹80 [−21, +185] in the year after the tuning ended.
- So the open question is not whether T1 worked once, but whether *the procedure* (best of a sweep on year N,
  trade year N+1) keeps working, and so whether a yearly re-run is worth doing or only moves the settings
  around on noise.

## Goal

A number for how the procedure performs across several folds, and a policy for T1's upkeep:
1. per fold, the out-of-sample gap of "tuned on the year before" Adaptive to fixed Core Adaptive and to the
   fixed base, per lot-day after 0.5 % slippage;
2. the pooled gap, and whether re-tuning every year beats **freezing** the first tuned set and beats Core;
3. a written rule for when a new sweep may replace T1 (or not), based on 1 and 2.

## Out of scope

Changing T1's live settings; promoting any new candidate to live; SENSEX before 2025 (no data); a different
objective than the one T1 used (unless the owner decides it in Phase 0); Buy add-on, Dir ×2, book stops.

## Plan

### Phase 0 — Pre-register (filled in and committed before any run)
- **Hypothesis:** choosing the best variants from a 12-month sweep and trading them over the next 12
  months earns more per lot-day than fixed Core Adaptive, out of sample.
- **Universe:** the sweep grid as it stood for T1 (BL-104 / BL-113 axes), run point-in-time on each fold's
  tuning year. NOT the 223 surviving T1 files for earlier years: they were picked with 2024-10 → 2025-10
  in view, so they cannot tune an earlier year.
- **Folds, NIFTY only** (owner, 2026-11-07: the old years can only be compared on NIFTY), run at **two lengths**,
  each fold tuned on the window just before its test window, test windows never overlapping:
  *12-month folds* F1 tune 2021-11 → 2022-10, test 2022-11 → 2023-10; F2 tune 2022-11 → 2023-10, test 2023-11 →
  2024-10-08; F3 tune 2023-11 → 2024-10-08, test 2024-10-09 → 2025-10-08; F4 tune 2024-10-09 → 2025-10-08 (T1 as
  built), test 2025-10-09 → latest. *6-month folds* the same idea in half-years: tune one half-year, test the next,
  from 2021-11 to the latest day (about nine folds; the exact dates are listed here in Phase 1, before any run).
  The two lengths are reported apart and never mixed into one number. F4 is BL-113's own check (and BL-213's), re-run
  on NIFTY; a both-index re-run of F4 is reported beside it, not pooled.
- **Selection rule (amended 2026-11-07, before any fold was selected: the first draft named the wrong procedure):**
  exactly the one that built T1 — BL-104 `daytype_lists.py`, Amendments 1-11, rule R1 (`research/bl215/select_fold.py`
  and `select_all.py` call it unchanged on a window). Per NIFTY family (N_wide, NIFTY Widesl premium, N_dir, N_ditm1,
  NIFTY Buy premium) and day type (expiry / other), over the 12 sampled entry times: rank the grid's settings on the
  window's first half and keep the best (a second one where it correlates below 0.7 with the first; premium families
  with their premium ladder) only if it also beats the family's current files in the second half; each kept setting is
  then run at all 25 entry times, and Adaptive (list C) chooses among Core NIFTY plus those. This is not the band-winner
  / `pool.py` rule of BL-106 (a different, earlier experiment). **Anchor, passed 2026-11-07:** run on 2024-10-09 ->
  2025-10-08 it returns exactly T1's recorded settings (`N_wide-t1s4` and `s8`, `N_p150-t1s11`, `N_dir-t1s29`,
  `N_ditm1-t1s36`, `N_buy-t1s47` and `s48`; the SENSEX `S_p285` and `S_ditm1` have no NIFTY-only counterpart), and a
  re-run of the original `--window first` selection matches 132 of its 133 stored rows, the 133rd being the same cell
  (same gains). Deviations, all because the folds are NIFTY-only and older: SENSEX families are not selected; the
  premium ladder for a tuning window before 2024-10 is the coarse ladder plus the levels BL-104's refine step added for
  F4 (the refine step picks its levels from the first year's scores, so a per-fold refine would need a second run);
  NIFTY expiry days before 2024-10-09 are the days the `_bl214` store labels `dte_n` 0 (the observed-expiry list begins
  2024-10); a row the rule marks "owner to choose" takes its rank-1 setting.
- **Folds, exact (Phase 1, registered before selection):** 12-month: F1 tune 2021-11-01 -> 2022-10-31 (ranked on the
  first six months), test 2022-11-01 -> 2023-10-31; F2 tune 2022-11 -> 2023-10, test 2023-11-01 -> 2024-10-08; F3 tune
  2023-11 -> 2024-10-08, test 2024-10-09 -> 2025-10-08; F4 tune 2024-10-09 -> 2025-10-08, test 2025-10-09 -> 2026-11-06.
  6-month (tune window = the half-year before the test half-year; boundaries 2022-04-09, 2022-10-09, 2023-04-09,
  2023-10-09, 2024-04-09, 2024-10-09, 2025-04-09, 2025-10-09, 2026-04-09; the first tune window runs from 2021-11-01):
  H1 ... H9, tests 2022-04-09 -> 2022-10-08, ..., 2026-04-09 -> 2026-11-06. The code is `research/bl215/folds.py`.
- **Prior evidence on the same method (found 2026-11-07, on the unmerged branch `research/bl106-pool-poc`):** BL-115
  Experiments 3, 8 and 10 re-ran this selection on quarterly folds of 2025-10 -> 2026-10 (NIFTY and SENSEX, gross, Adaptive
  list C): re-selected settings won 2 of 4 quarters, pooled +70 [-81, +215] per lot-day (growing window +66; whole-window
  ranking +85; plateau +112), none passing, and only 2-3 of 7-14 settings survived from one fold to the next. A planned
  4-year NIFTY walk-forward of the same method (that branch's "BL-116", status Planned, never run; main's BL-116 is a
  different item) is what this item now is. So the result here is read against those quarters, not as a first look.
- **Look-ahead check:** a fold's tuning reads results dated before its test start only; the test results are not
  opened until the selected set is written to the Log; each day's pick uses earlier rows only (`pick.score_history`);
  an anchor: re-running F4's selection must return T1's recorded set.
- **Policies compared:** (a) re-tune every year (each fold uses its own prior year); (b) freeze the set
  tuned on F1's tuning year; (c) fixed Core Adaptive; (d) the fixed base.
- **Pass / kill rule** (policy (a) − Core, per lot-day after 0.5 % slippage, 90 % circular block bootstrap, 5-day
  blocks, 2,000 resamples, pooled over the test periods, each fold length on its own): **pass** if the pooled range is
  above zero and the gap is positive in at least three quarters of the folds; **kill** if the pooled mean is zero or
  below. Anything else: "no evidence
  either way". A separate line says whether (a) beats (b) pooled over F2-F4.
- **Hold-out:** everything after 2026-11-06 is forward only and not tested here.
- **Will not run:** a second selection rule, a different window length, tuning on a test period, dropping a fold.
  Any of them needs `override: <reason>` in the Log.

### Phase 1 — Reconstruct the selection and cost the sweep
- **Tasks:** write down the BL-113 / BL-115 selection rule and its grid from the code and items; confirm F4
  reproduces T1's recorded set; count the grid's cells and time one fold's run; check the lake covers the
  grid's strikes on thin 2021-23 chains.
- **Deliverables:** the rule in Phase 0; a cost and runtime estimate; a coverage list.
- **Done when:** the selection rule is registered and F4 reproduces T1's set (or the item is stopped with the reason).

### Phase 2 — Run the sweeps
- **Tasks:** run the grid over each fold's tuning year into a separate root (as BL-214's `_bl214`), resumable.
- **Deliverables:** per-fold selected set, written to the Log before the test results are read.
- **Done when:** every fold has a selected set recorded and no test period was read.

### Phase 3 — Score and decide
- **Tasks:** score the four policies on each test period; apply the pass / kill rule; stages (drawdown, share of
  random baskets beaten); write the findings page and the upkeep rule (e.g. a candidate runs in paper beside the
  incumbent for a quarter before any swap).
- **Deliverables:** `packages/option-backtesting/research/bl215/`, the findings page
  (`research/options/common/rotation-ranking.md`), the item's Log.
- **Done when:** the rule is applied and the upkeep policy is written.

## Risks

- **Best-of-many bias.** The winner of a sweep is partly luck; each re-tune repeats that. The folds measure how much
  survives, but four folds is a small number.
- **Grid cost.** The full BL-104 grid over four tuning years may take days; the estimate in Phase 1 decides whether
  the item is worth running.
- **The older chains are thin** (140-170 contracts a day in 2021-23), so some grid cells may not have strikes.
- **Overlap with BL-213 / BL-214.** F4 repeats BL-113's check; the NIFTY-only F1-F3 test periods were read by BL-214
  for Core and T1, so "unseen" holds only for the *selection*, not for the test days.
- **A changed T1 loses its forward record.** The upkeep rule must keep the incumbent running unchanged.

## Open questions

Answered by the owner on 2026-11-07 (see the Log): NIFTY-only folds; both 12- and 6-month folds; BL-213 absorbed.

Still open: whether the sweep's first-year band winners for 2021-23 can be rebuilt from the lake as they were built
for 2024-25 (checked in Phase 1); the pass fraction for the 6-month folds if a few of them are very thin.

## Log

- 2026-11-07 — Created from the owner's idea after BL-214 ("sweep a year, take the best, and do it every year").
  Priority P2 (judged: heavy compute, the forward read-out comes first). Phase 0 drafted, nothing run; the open
  questions go to the owner at start.
- 2026-11-07 — Owner answered: yes, NIFTY-only folds (the older years can only be compared on NIFTY); test both 12- and
  6-month folds; the BL-213 question left to me. Decided: BL-213 is absorbed here (its tune-on-2025, test-2026 split is
  one of this item's folds) and dropped as a separate item. Where T1's selection code lives found (BL-104 stage 1, BL-106
  `pool.py`), not yet checked to reproduce T1's set. Phase 0 amended; still nothing run.
- 2026-11-07 — **Started (owner: "run this overnight").** Phase 0 stands as committed (d73ed621). Compute started ahead of
  Phase 1's written rule because the NIFTY Stage 1 grid does not depend on it: `research/bl104/run_grid.py --family all
  --index N --from 2021-11-01 --to 2024-10-08 --tag bl215_stage1 --workers 6` (grid SHA `6a1078bb4fe68786`, 31,713 cells,
  723 NIFTY days, the 7 Stage 1 slots; one pass whose per-day series are sliced per fold, so every tuning window and every
  6-month window comes from this one run). Run from the `ata-bl215` worktree (the main checkout stays on `main` for the
  launchd jobs); results git-ignored under `research/bl104/results/bl215_stage1/`; nothing is read from it before the
  selection rule is registered in Phase 1. A 140-cell smoke run on Jan-Feb 2022 completed with 0 skipped cells, so the
  early lot-size lookups work (`EarliestRowReference`). The F4 window (2024-10-09 → 2025-10-08) and the 6-month windows
  after it come from BL-104's existing Stage 1 (488 days), NIFTY slice.
- 2026-11-07 — **Stage 1 finished** (21 of 21 cohorts, no failures, ~1 h 20 min). **Phase 0 amended before any selection**
  (see the Selection rule above): the first draft named BL-106's band-winner/pool step; T1 was in fact built by the
  day-type method (BL-104 `daytype_lists`, rule R1). The anchor passed (F4 returns T1's recorded settings). That method
  also reads the 12-slot grid, the premium ladders and the Buy/Dir cells that Stage 1 (7 slots, strike grid) does not hold,
  so a second NIFTY run was started the same night for every cell it asks for and finds missing
  (`research/bl215/needed_cells.py` -> 57,975 cells, `--tag bl215_extra`). Nothing from any test window has been read.
  Owner (asleep) asked me to carry on without waiting.
- 2026-11-07 — **Phase 2 done.** The `bl215_extra` run finished at 04:54 (36 of 36 cohorts, 57,975 cells, no failures). The
  overnight driver then stopped on a setup slip of mine (the `results/bl215x/extra` link to the run had not been made, so
  every cell read as missing); made it, `needed_cells.py` reported 0 missing, driver re-run at 11:20. Every fold's set was
  selected from its tuning window only and **committed before any test window was read** (4a084acc,
  `research/bl215/selected.json`: 12-month F1 6 settings, F2 8, F3 3, F4 7; 6-month H1-H9 6-11 each). F4 and H9 had been
  selected and smoke-scored the night before (the anchor check); the other folds' selection is mechanical (no choice left to
  make), so that early look could not steer them. Each selected setting re-simulated at all 25 entry times over
  2021-11-01 → 2026-11-06 in `TRADING_DATA_ROOT=/Volumes/TradingData/_bl215` (`build_and_sim.py`; F4's settings match T1's
  stored results on 173 of 173 variants). A partial score I ran mid-simulation (12:40) used 6-month folds whose later
  settings were not yet simulated; its 6-month figures are wrong and superseded by the table below (the 12-month F1 and F2
  figures were already complete and are unchanged).
- 2026-11-07 — **Phase 3: scored and decided** (`research/bl215/score.py` -> `research/bl215/results/score.json`, git-ignored;
  regenerate with the command in its docstring). NIFTY only, Adaptive list C, one lot a strategy, Buy add-on out, net per
  lot-day after costs and 0.5 % slippage, 90 % circular 5-day block bootstrap (2,000 resamples). (a) re-tune each fold,
  (b) freeze the first fold's set, (c) Core NIFTY Adaptive, (d) the fixed base.

  12-month folds:

  | Fold | Test | Days | (a) re-tune | (b) frozen | (c) Core | (d) base | a − c |
  |---|---|---|---|---|---|---|---|
  | F1 | 2022-11-01 → 2023-10-31 | 248 | 186 | 186 | 220 | 135 | −35 |
  | F2 | 2023-11-01 → 2024-10-08 | 229 | 49 | −15 | 126 | 356 | −77 |
  | F3 | 2024-10-09 → 2025-10-08 | 247 | 147 | 152 | 106 | 404 | +41 |
  | F4 | 2025-10-09 → 2026-11-06 | 260 | 224 | 173 | 145 | 56 | +78 |
  | Pooled | | 984 | 154 | 127 | 150 | 233 | **+4 [−41, +49]**, 2 of 4 won |

  6-month folds (a − c per fold, H1 → H9, tests 2022-04-09 → 2026-11-06): −153, +49, +21, −33, −191, +230, +182, +44, +128;
  (a) 60, 260, 228, 75, −48, 212, 410, 218, 250; (c) 213, 211, 207, 108, 142, −17, 228, 174, 121; (d) 445, 180, 97, 266, 402,
  429, 379, 63, 51. Pooled over 1,121 days: (a) 186, (b) 157, (c) 154, (d) 254; **a − c +32 [−23, +90]**, 6 of 9 won.

  Other lines: a − b after the first fold +36 [−6, +81] (12-month) and +32 [−46, +108] (6-month); a − d −79 [−173, +16] and
  −68 [−167, +27]; c − d −83 [−177, +12] and −101 [−189, −18] (Core NIFTY Adaptive below the base over the 6-month test
  span, 2022-04 → 2026-11). Deepest drawdown: re-tune −₹62.0k (12-month, F2) and −₹81.0k (6-month, H5) against Core's
  −₹50.2k. Settings kept from one fold to the next: 0-29 % (F4 67 %), so each re-tune mostly replaces the set.

  **Registered reading: no evidence either way at both lengths** (pooled mean above zero, so not killed; the range
  includes zero and fewer than three quarters of the folds won, so not passed). The gap has a sign by era: before 2024-10 re-tuning lost
  5 of 7 test periods to Core (F1, F2; H1, H4, H5; it won H2 and H3), and from 2024-10 on it won all 6 (F3, F4; H6-H9), the
  same split BL-214 found for T1 itself. It agrees with BL-115's quarterly folds of 2025-10 → 2026-10
  (+₹70 [−81, +215], 2 of 4). Not done from Phase 3's list: the share of random baskets beaten (BL-214 has it for Core
  and T1 over 2021-24).

  **Upkeep rule (Phase 3 deliverable).** T1 is not re-tuned on a schedule: a yearly (or half-yearly) re-run of the sweep
  did not reliably earn more than leaving Core alone, swaps most of the settings each time, and had deeper drawdowns. The
  live T1 set stays as it is, keeping its forward record. A new sweep may replace it only as a candidate run in paper as
  its own track beside the incumbent (as the T1 track ran beside Core, BL-113), with a pass rule registered before it
  starts (candidate − incumbent, 60 sessions at least, 90 % range above zero after 0.5 % slippage), and never on
  backtest numbers alone.
