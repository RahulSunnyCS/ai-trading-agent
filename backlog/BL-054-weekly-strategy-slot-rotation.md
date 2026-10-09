# BL-054 — Weekly rotation of NIFTY strategy start times (POC)

| | |
|---|---|
| **Priority** | P2 — options research; does not block this month's Momentum work |
| **Status** | Planned |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-09 |
| **Depends on** | none (follows BL-053, where starting at 10:00 helped Dir and Widesl last year) |
| **TODO.md row** | — |

## Context

Owner's idea (2026-10-09 chat): run three NIFTY strategies at many start times, every 15 minutes
from 09:17, and treat each (strategy, start time) pair like a Momentum instrument. Every week,
rank them on the last two weeks' P&L (the latest week counting more), and trade the top 6 the
following week. The POC answers one question: is this worth building, or is the weekly ranking
just picking noise?

Owner's answers (2026-10-09): slots until 12:00; rank on gain only; weights 2:1; test the last
two years only (override, see Log).

Owner's refinement (2026-10-09, later): the default book is **5 lots**, drawn only from Widesl
OTM1 and Dir ATM, with **at least 2 Widesl OTM1** (up to all 5) because Widesl has the smaller
drawdown. Buy breakout is not in the default; when Buy is "in favour" it adds **2 extra lots on
top** (7 that week). The owner also wants to see whether a minimum of 3 Widesl changes the
result, so that one setting is reported as sensitivity, fixed here before the run.

## Goal

A pass / kill / inconclusive answer to the pre-registered rule below, with the numbers.

## Out of scope

Live or paper trading, a dashboard screen, any change to `strategies/legwise/`, other
underlyings, tuning the rule.

## Plan

### Phase 0 — Pre-register

Committed before any run. Never edited after a run; a changed rule is a new dated block.

- **Hypothesis:** the 5 Widesl/Dir variants with the best weighted P&L over the last two weeks
  (at least 2 of them Widesl), plus 2 Buy lots in the weeks Buy's own score is positive, earn
  more next week than the same number of lots picked at random from the same set, and more
  than today's fixed setup.
- **Universe:** 33 variants = 3 families × 11 start times (09:17, 09:32, 09:47, 10:02, 10:17,
  10:32, 10:47, 11:02, 11:17, 11:32, 11:47):
  - **Widesl OTM1:** `strategies/legwise/nifty_widesl_917_otm1.yaml` with only `entry_time`
    changed.
  - **Dir ATM:** `nifty_dir_924_itm1_sl21_recost.yaml` with `strike_type: ITM1 → ATM` on both
    legs and `entry_time` changed. Everything else unchanged (21% SL, re-cost once, ₹3,000
    overall SL).
  - **Buy breakout:** `nifty_buy_range_breakout.yaml` with `entry_time` changed and the range
    window `until` = entry + 10 minutes (as today: 09:35 → 09:45).
  - Exits unchanged per family (15:28 / 15:28 / 15:14). Weekly expiry, 1 lot, today's lot size
    on every day (`lot_sizing: current`), 1-minute bars, usable days per `data_quality`.
    Source: the trading-data lake (vendor + Fyers NIFTY options), 2024-10-09 → 2026-10-08.
- **Rule:** weeks are Monday–Friday calendar weeks; a holiday week just has fewer days.
  - After each Friday close, score = ⅔ × this week's P&L + ⅓ × last week's P&L, per variant.
  - **Core (5 lots):** from the 22 Widesl OTM1 and Dir ATM variants, take the top 5 by score
    (ties broken by id) subject to **at least 2 Widesl OTM1**: if fewer than 2 Widesl are in
    the top 5, the lowest-scoring Dir picks are replaced by the next-best Widesl until there
    are 2. All 5 may be Widesl. 1 lot each, held every day of the following week.
  - **Buy add-on (0 or 2 lots):** if the best-scoring Buy variant's score is **> 0**, add the
    top 2 Buy variants by score, 1 lot each, for that week (7 lots). Otherwise no Buy (5 lots).
  - **Sensitivity (reported, not part of the verdict):** the same rule with at least 3 Widesl
    in the core.
  - The first trading week is week 3 of the window.
- **Look-ahead check:** a week's picks use only P&L from days before that week's Monday; the
  script asserts this.
- **Comparators:** each uses the same weekly lot count as the rule (5, or 7 in the weeks the
  Buy add-on fires), so they measure the ranking, not the exposure.
  - **R:** each week, 5 variants drawn at random from the 22 Widesl/Dir variants with at least
    2 Widesl, plus 2 random Buy variants in exactly the weeks the rule added Buy. 1,000 runs.
    Gives the "luck" distribution for the same constraints.
  - **E:** the 22 Widesl/Dir variants equally weighted and scaled to 5 lots, plus the 11 Buy
    variants equally weighted and scaled to 2 lots in the Buy weeks.
  - **T:** today's setup at today's times, 5 lots fixed: Widesl OTM1 09:17 × 2, Dir ITM1 09:24
    × 2, Buy 09:35 × 1.
- **Pass / kill rule:**
  - **Pass** if all three hold:
    1. The rotation's total P&L is at or above R's 90th percentile.
    2. It beats E on total P&L, with a max drawdown no worse than E's.
    3. It beats T on total P&L, with a max drawdown no worse than T's.
  - **Kill** if (1) fails: the ranking does no better than luck.
  - **Inconclusive** otherwise.
- **Reported alongside, not part of the rule:**
  - Week-to-week rank persistence: the rank correlation between one week's score and the next
    week's P&L, within the 22 Widesl/Dir variants and within the 11 Buy variants.
  - The family mix the core picked each week (how often it was 5 Widesl, how often the
    at-least-2 rule had to override the ranking), and how many weeks Buy fired.
  - The Buy add-on on its own: P&L of the 2 Buy lots in the weeks they were added, against the
    P&L the same 2 lots would have made in the weeks they were not.
  - The sensitivity run (at least 3 Widesl) with the same statistics.
  - A hindsight ceiling (the best fixed 5 over the whole window). That uses look-ahead, so it
    is labelled as such.
- **Charges:** everything is before charges. The rule and all comparators trade the same lots
  each week, so charges move them roughly together.
- **Hold-out:** none. Owner override, below.
- **Will not run:** other lookbacks (1 or 4 weeks), other weights, a core other than 5 lots, a
  Buy add-on other than 2 lots or another Buy trigger, a minimum-Widesl setting other than 2
  (verdict) and 3 (sensitivity), Buy inside the core, a gain-minus-drawdown score, slots after 11:47, the
  ₹65-premium Widesl, the Mar 2022 – Oct 2024 hold-out. Each needs a new dated block. The
  verdict is read from the at-least-2 run only; a sensitivity run that looks better does not
  replace it.
- **Result:** (after the run)

### Phase 1 — Variant backtests
- **Tasks:**
  - A script generates the 33 YAMLs into `research/bl054/variants/`, outside
    `strategies/legwise/` so the evening `obt daily` never picks them up.
  - Run each with `run_legwise` over the window, 8 in parallel (about 45–60 minutes).
  - Save per-day net P&L, trade count and worst MTM per variant.
- **Deliverables:** one per-day table (variant × day).
- **Done when:**
  - All 33 variants cover the same days.
  - The 09:17 Widesl OTM1 variant reproduces `nifty_widesl_917_otm1`'s per-day P&L exactly (a
    check that the generation changed nothing else).

### Phase 2 — Weekly rotation and verdict
- **Tasks:** weekly P&L matrix → scores → top 6 picks → next-week P&L; comparators R, E and T;
  total, average per week, winning weeks %, max drawdown, worst week; the extra reports listed
  above.
- **Deliverables:** the verdict against the pass / kill rule, written into Result.
- **Done when:** Result is filled in and the owner has seen it.

### Phase 3 — Decide (owner)
- **Pass:** a new dated block for the unseen Mar 2022 – Oct 2024 test, then a paper-forward
  journal (as BL-024 does for Momentum) before any money.
- **Kill:** Dropped.
- **Inconclusive:** owner's call.

## Risks

- **Noise:** two weeks is about 10 intraday P&Ls per variant, and adjacent start times of one
  family are highly correlated. The core may often be one family at five nearby times, which
  is one bet, not five.
- **The Buy trigger is weak evidence:** "best of 11 Buy start times was positive over two
  weeks" will be true in many weeks by chance alone. The Buy-on-its-own report shows whether
  it added anything.
- **Two minimum-Widesl settings on one window** is a small sweep; the verdict is tied to the
  at-least-2 run so the sweep cannot pick the winner.
- **Data-snooping:** 33 variants on a window already looked at in the 2026-10-09 chat. The
  random-6 comparator guards the ranking itself, not the choice of families.
- **Dir ATM is a new family:** it has never been compared with AlgoTest.
- **Before charges:** a positive gap smaller than about ₹200 a day probably disappears after
  charges.

## Open questions

- Commit the variant generator and evaluation script under `research/bl054/` (the default), or
  keep them as throwaway scratch files?

## Log

- 2026-10-09 — created from the owner's idea; owner chose slots until 12:00, gain-only ranking,
  2:1 weights.
- 2026-10-09 — override: owner chose the last two years only, which the 2026-10-09 chat had
  already looked at. Any result is exploratory and cannot by itself justify moving money.
- 2026-10-09 — rule refined before any run: core of 5 lots from Widesl OTM1 + Dir ATM with at
  least 2 Widesl; Buy adds 2 lots on top when its best variant's score is positive (owner chose
  this trigger and "on top" over "replace"); minimum-Widesl 3 reported as sensitivity.
  Supersedes the earlier "top 6 of all 33" wording, which was never run.
- 2026-10-09 — owner dropped the minimum-Widesl 4 and 5 sensitivity runs before any run; only
  2 (verdict) and 3 (sensitivity) remain.
