# BL-134 — A two-strategy book: the top Widesl and the Dir only (drop the second Widesl)

| | |
|---|---|
| **Priority** | P2 — the owner trades both books with real money |
| **Status** | Done — informative, not adopted: dropping the second Widesl costs T1 clearly and Core's drawdown; the brokerage saved (~₹100 a day) does not pay for it |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-18 |
| **Depends on** | BL-129 (rank 1 vs rank 2, the doubled book), BL-133 (fourth lot on the Dir) |
| **TODO.md row** | — (research only) |

## Context

Owner (2026-10-18), after BL-133: "what if then we are doing only top 2 widesl and 2 dir in T1 and Core in non expiry,
so that brokerage can also be reduced, and 1 dir and 2 widesl (top 1) in expiry days". Read as: each book trades only
two strategies, the top-ranked Widesl and the Dir: on non-expiry days 2 lots of each (4 lots), on expiry days 2 lots
of the top Widesl and 1 of the Dir (3 lots). The second Widesl is dropped every day, saving its orders.

Known before this run: BL-129 found the top Widesl earned no more than the second (the second is usually the Widesl
the Widesl minimum swapped in) and that 2 × top Widesl + the third pick was not better than the book as picked;
BL-133 found the Dir the best home for a fourth lot. So this mixes one placement that looked weak with one that looked
good.

## Goal

Compare the owner's two-strategy book with the plan from BL-133 (3 picks, Dir doubled on non-expiry days) and with 3
lots as picked, in result, drawdown, worst day and brokerage. Nothing live changes.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Picks:** Adaptive list C replayed from the stored results over Core-298 and T1, as BL-133 (no expiry rule; Buy
  add-on left out). W1 = the higher-composite Widesl pick; W2 = the other Widesl pick(s); Dir = the Dir pick, or on a
  three-Widesl day the best unpicked Dir (`score.runners_up`), added as BL-133 did.
- **Expiry day:** NIFTY or SENSEX weekday days to expiry `0` (as BL-133).
- **Books (lots):**
  - **P (owner):** expiry 2 × W1 + 1 × Dir; other days 2 × W1 + 2 × Dir.
  - **R (BL-133's Dir plan):** expiry W1 + W2 + Dir; other days W1 + W2 + 2 × Dir (three-Widesl day: W1 + W2 + W3,
    plus the runner-up Dir on other days).
  - **B3:** 3 lots as picked every day.
- **Charges:** gross from the stored one-lot results × lots; brokerage per strategy placed = 2 orders × the stored
  `n_trades` × ₹20 × 1.18 (lots of one strategy share its orders); turnover charges scale with lots and are taken as
  equal across books with the same lots. Reported gross and after brokerage.
- **Windows:** 2025-01-10 → 2026-10-16 and the last year 2025-10-09 → 2026-10-16.
- **Measures:** per day gross and after brokerage, max drawdown, worst day, brokerage per day; P − R per day with a
  two-sided 90 % circular block bootstrap (5-day blocks, 2,000 resamples, seed 20261026), after brokerage; the same
  with the 5 and 10 best days for P removed (date order kept) and their share of the difference.
- **Reading:** P "beats" R if the after-brokerage interval lies above zero; "worse" if below; drawdown and worst day
  reported. Descriptive, in-sample (days read by BL-115, BL-129, BL-133; T1 overlaps its selection year).
- **Will not run:** other splits (e.g. the second Widesl instead of the first), 5+ lots, the expiry rule.

### Phase 1 — Run

- **Tasks:** `packages/option-backtesting/research/bl134/two_strategy.py`; JSON; Log.
- **Done when:** the Log has P, R and B3 for both books and windows.

## Log

- 2026-10-18 — Created; Phase 0 registered before any run (owner's book).
- 2026-10-18 — Owner, while the script was being written: "so only 2 strategies per day. if there is buy. it is
  extra". The Buy add-on is left out of every book (Phase 0), so it is the same extra in P and R and does not change
  the comparison.
- 2026-10-18 — **Run as registered** (`research/bl134/two_strategy.py`; `two_strategy_2026-10-18.json`; no day
  skipped). Net = gross − brokerage (₹20 × 1.18 per order, 2 orders per trade, once per strategy placed).

  | Book, window | Book | Gross / day | Net / day | Brokerage / day | Max drawdown (net) | Worst day (net) |
  |---|---|---|---|---|---|---|
  | Core, 2025-01-10 → 2026-10-16 (428 d) | B3 | +1,216 | +903 | 314 | −42,326 | −10,862 |
  | | R (3 picks, Dir ×2 normal days) | +1,494 | +1,167 | 326 | −41,978 | −13,382 |
  | | **P (top Widesl + Dir)** | +1,241 | +1,015 | 226 | **−70,216** | −14,838 |
  | Core, last year (244 d) | B3 | +1,393 | +1,079 | 314 | −35,929 | −10,249 |
  | | R | +1,744 | +1,421 | 323 | −37,676 | −12,316 |
  | | **P** | +1,775 | +1,549 | 226 | −39,086 | −14,838 |
  | T1, 2025-01-10 → 2026-10-16 | B3 | +1,885 | +1,529 | 356 | −25,887 | −14,092 |
  | | R | +2,200 | +1,833 | 367 | −36,145 | −17,929 |
  | | **P** | +1,842 | +1,580 | 262 | −43,879 | −17,706 |
  | T1, last year | B3 | +2,100 | +1,746 | 354 | −25,672 | −14,092 |
  | | R | +2,513 | +2,150 | 363 | −30,477 | −14,159 |
  | | **P** | +2,078 | +1,819 | 259 | −32,333 | −16,452 |

  P − R net per day (90 %): Core −152 [−392, +62] (two years), +128 [−87, +337] (last year; without its top 5 days
  −7, top 10 days −97); **T1 −254 [−486, −30] and −330 [−621, −55], below zero**. P − B3 net: Core +113 / +470,
  T1 +51 / +73.

  **Read under the rule.** P is **worse** than R in T1 (both windows) and inconclusive in Core, where over 21 months
  its drawdown is far deeper (−70k vs −42k) and its last-year lead rests on its best days. Dropping the second Widesl
  saves about ₹100 a day of brokerage but gives up that Widesl's result, which (BL-129) is at least as good as the top
  one's; doubling the top Widesl concentrates risk on one entry. The two-strategy book is barely better than 3 lots as
  picked despite carrying 4 lots on normal days. Weaknesses: in-sample, turnover charges taken as equal for equal
  lots, T1 overlaps its selection year.
