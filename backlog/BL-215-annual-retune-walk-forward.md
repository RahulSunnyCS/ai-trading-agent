# BL-215 — Annual re-tune of Adaptive Tuned (T1): does "sweep one year, take the best, trade the next" hold up out of sample?

| | |
|---|---|
| **Priority** | P2 — it decides how T1 is kept up to date while real money trades it; heavy compute, and the 60-session forward read-out (BL-135) comes first |
| **Status** | Idea |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-07 |
| **Depends on** | BL-113 / BL-115 / BL-106 (how T1's settings were chosen), BL-104 (the sweep grid), BL-214 (the NIFTY-only 2021 → 2024 store); absorbs BL-213 (its one fold is F4 below) |
| **TODO.md row** | — (filled in when started) |

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
- **Selection rule:** exactly the one BL-113 / BL-115 used. Where it lives: the sweep's first-year band winners
  (`research/bl104/results/stage1_y1/<family>_band_winners_tail.csv`) then BL-106's pool step (`research/bl106/pool.py`:
  per family x index x band, up to 4 sets that differ in at least two settings, applied at every rotation slot). It is
  written here, with its constants, in Phase 1 before any run; if F4 does not reproduce T1's recorded set, the item
  stops there and says so.
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
