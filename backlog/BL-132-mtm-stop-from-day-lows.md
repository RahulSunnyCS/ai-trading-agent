# BL-132 — A book MTM stop sized so it is not hit on 85 / 90 / 93 / 95 % of days

| | |
|---|---|
| **Priority** | P2 — the owner trades both books with real money (3 lots each) |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-18 |
| **Depends on** | BL-131 (its replayed minute paths and books), BL-095 (portfolio stop rule) |
| **TODO.md row** | — (research only) |

## Context

Owner (2026-10-18), after BL-131: "now we will go to what is best MTM stop loss → I think it should be something
which will not hit SL in 85% days, 90% days, 93%, 95% days. Figure out". So the level is set from how deep each
book's day usually goes, not from which level earned most: a stop that a normal day never touches and only the rare
bad day reaches.

## Goal

For each 3-lot book (Core-298, T1), the stop levels that leave 85 / 90 / 93 / 95 % of days untouched, chosen on one
period and checked on a later one: does the hit rate hold, and what does the stop do to the result, drawdown and
worst day. Nothing live changes.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Books and paths:** BL-131's books (Adaptive list C core picks, one lot each, Core-298 and T1, no expiry rule) and
  its replayed one-lot minute paths (each checked against the stored gross).
- **Day low:** for each book-day, the lowest minute close of the book's combined MTM with no book stop (each pick's
  own stops in place), as a loss in rupees (0 if the book never went below zero).
- **Calibration (choose):** 2025-01-10 → 2025-10-08. For p = 85, 90, 93, 95 %, the level L_p = the p-th percentile of
  the day lows, rounded up to the next ₹500, so a stop at −L_p is not reached on at least p % of calibration days.
- **Test (check, read once):** 2025-10-09 → 2026-10-16. Each L_p applied as BL-095's stop (close everything at the
  first minute at or below −L_p): the share of test days it is hit (vs the target 100 − p %), per-day change against
  no stop with a two-sided 90 % circular block bootstrap (5-day blocks, 2,000 resamples, seed 20261024), the book's
  max drawdown and worst day with and without.
- **Also reported (descriptive):** the same percentiles over the whole period 2025-01-10 → 2026-10-16, and over the
  test year alone, so the owner sees how far the levels move.
- **Reading:** the level "holds" if its test-year hit rate is within 2 points of the target; the effect is "positive"
  if its interval lies above zero, "protective" if drawdown and worst day are both shallower. Descriptive; it
  changes no list.
- **Caveats, registered now:** gross, fills at the stop minute's close (no slippage); T1's calibration period lies
  inside its own selection year; ₹ levels assume today's lot sizes (`SIZING_DATE`).
- **Will not run:** other percentiles, trailing or profit locks, a combined 6-lot stop, choosing a percentile by its
  test-year result.

### Phase 1 — Run

- **Tasks:** `packages/option-backtesting/research/bl132/day_lows.py` (reads BL-131's path cache); JSON; Log.
- **Done when:** the Log has, per book and percentile, the calibrated level, the test-year hit rate and the effect.

## Log

- 2026-10-18 — Created; Phase 0 registered before any run (owner chose the percentiles).
