# BL-132 — A book MTM stop sized so it is not hit on 85 / 90 / 93 / 95 % of days

| | |
|---|---|
| **Priority** | P2 — the owner trades both books with real money (3 lots each) |
| **Status** | Done — informative: levels set on the first period were hit far less often in the calmer test year; ₹8–8.5k is the "about 95 % of days" level for both books |
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
- 2026-10-18 — **Run as registered** (`research/bl132/day_lows.py`; `day_lows_2026-10-18.json`; BL-131's replayed
  paths). Day low = the book's lowest minute close of combined MTM (gross, one lot per pick, each pick's own stops in
  place). Calibrate 2025-01-10 → 2025-10-08 (184 days), test 2025-10-09 → 2026-10-16 (244 days).

  Day-low percentiles (₹ loss the book reached during the day):

  | Book | Span | P85 | P90 | P93 | P95 |
  |---|---|---|---|---|---|
  | Core-298 | calibrate | 6,818 | 7,742 | 8,084 | 8,461 |
  | Core-298 | test | 5,027 | 5,923 | 6,460 | 6,969 |
  | Core-298 | whole | 5,627 | 6,771 | 7,556 | 8,018 |
  | T1 | calibrate | 6,130 | 7,942 | 8,434 | 9,179 |
  | T1 | test | 5,491 | 6,534 | 7,003 | 7,527 |
  | T1 | whole | 5,795 | 6,613 | 7,805 | 8,358 |

  Levels chosen on the calibration period, checked on the test year (no stop in the test year: Core +1,393/day,
  drawdown −31,486, worst day −9,919; T1 +2,100, −23,300, −13,809):

  | Book | Pct | Stop | Hit: calibrate / test (target) | Change per day (90 %) | Drawdown | Worst day |
  |---|---|---|---|---|---|---|
  | Core | 85 | ₹7,000 | 14.1 % / 4.9 % (15 %) | **+37 [+10, +66]** | −29,956 | −8,721 |
  | Core | 90 | ₹8,000 | 8.2 % / 2.9 % (10 %) | +13 [−3, +30] | −30,858 | −8,843 |
  | Core | 93, 95 | ₹8,500 | 4.9 % / 2.5 % (7 %, 5 %) | +4 [−9, +16] | −31,324 | −8,993 |
  | T1 | 85 | ₹6,500 | 12.5 % / 10.7 % (15 %) | −122 [−287, +17] | −28,275 | −8,752 |
  | T1 | 90 | ₹8,000 | 10.3 % / 4.5 % (10 %) | +18 [−47, +80] | −21,049 | −8,990 |
  | T1 | 93 | ₹8,500 | 7.1 % / 2.9 % (7 %) | +36 [−8, +84] | −21,741 | −9,487 |
  | T1 | 95 | ₹9,500 | 3.3 % / 1.6 % (5 %) | +12 [+0, +30] | −23,300 | −13,809 |

  **Read under the rule.** No level "holds": the test year was calmer (its day lows ₹1–2k shallower at every
  percentile), so every calibrated stop was hit less often than targeted, by 2–10 points. Rounding up to ₹500 also put
  Core's P93 and P95 on the same ₹8,500. Effects: Core P85 (₹7,000) is "positive" and protective (one of eight cells,
  the same cell BL-131 flagged as chance-level); Core P90–95 and T1 P90–93 are protective (shallower drawdown and worst
  day) with intervals including zero; T1 P85 (₹6,500) tends to cost; T1 P95 (₹9,500) barely fires. **What it says:** a
  fixed rupee stop is not a fixed percentage of days; how often it is hit moves with the market's mood (the calmer
  year halved the hit rates). Over the whole 21 months, "not hit on about 95 % of days" is about ₹8,000 for Core and
  ₹8,400 for T1, and "about 90 %" about ₹6,800 / ₹6,600. Weaknesses: in-sample overall; gross; fills at the stop
  minute's close; T1's calibration lies in its selection year.
