# BL-213 — Walk-forward check of Adaptive Tuned: how much of its history gap survives out of sample

| | |
|---|---|
| **Priority** | P2 — research; decides how much of Tuned's two-year gap to the fixed base to plan on |
| **Status** | Dropped — absorbed into BL-215 (2026-11-07) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-05 |
| **Depends on** | the Books table's head-to-head (PR for this card), the T1 track (BL-113), BL-115's tuned settings |
| **TODO.md row** | — (filled in when started) |

## Context

The Rotation page's head-to-head shows Adaptive Tuned ahead of the fixed base by about +₹254 per
lot-day over two years (90% range +₹74 to +₹435) and +₹372 over one year, with Classic's range
including zero. Almost all of those days are the 09:16 rule replayed on stored results, and
Tuned's settings were chosen on that same history, so the gap is in-sample. Only 11 live sessions
exist. Owner, 2026-11-05, on the recommendation: "looks good, complete it". The recommendation
said to price the tuning with a walk-forward before the 60-session read-out.

## Goal

A number for how much of Tuned's gap to the base survives when the tuning never sees the test
days, so the plan for real money uses that, not the in-sample figure.

## Out of scope

Changing T1's live settings. Any new strategy variant. A different base.

## Plan

### Phase 0 — Pre-register (`research` items only)
Filled in and committed **before any run**.
- **Hypothesis:** tuning on 2025 only, Tuned still beats the fixed base on 2026 to date by a
  gap whose 90% range stays above zero.
- **Universe:** Core-298 plus the T1 track's variants, with each day's picks from the 09:16 rule
  re-derived from the rows before that day (`rotation/daylog.py` reconstruction).
- **Look-ahead check:** the tuned settings are chosen from rows dated 2025-12-31 or earlier; the
  test period's results are not read until the settings are written down; re-derived picks use
  only earlier rows, as `pick.score_history` does.
- **Pass / kill rule:** pass if the test-period gap to the base per lot-day, after 0.5% slippage,
  has a 90% block-bootstrap range above zero and keeps at least half of the in-sample gap;
  kill if the range includes zero and the mean is under a quarter of it.
- **Hold-out:** 2026-01-01 to the last scored day; unseen until the settings are fixed.
- **Will not run:** a second tuning round on the test period; any per-window cherry-picking.
- **Open question for the owner:** exactly which settings count as "tuned" (the T1 track's
  variant set and its picker weights, BL-113 / BL-115) and whether the tuning is repeated or only
  the already-chosen settings are re-scored on the hold-out.

### Phase 1 — Run and report
- **Tasks:** re-derive the settings on 2025 only, score 2026 to date, write the finding.
- **Deliverables:** `research/options/strategies/…` page updated, the item's Log.
- **Done when:** the pass / kill rule is applied and the share of the gap that survives is stated.

## Log

- 2026-11-05: created from the Books table recommendation. Not started; Phase 0 awaits the owner.
- 2026-11-07: dropped. Its single tune-on-2025, test-2026 split is one fold of [BL-215](BL-215-annual-retune-walk-forward.md), which tests the tuning procedure across several folds; owner agreed to run that instead.
