# BL-057 — Daily four-criteria rotation over the 66 NIFTY + SENSEX start-time variants (POC)

| | |
|---|---|
| **Priority** | P2 — options research; follows BL-054 and BL-056 |
| **Status** | Done — inconclusive (exploratory: owner override, no hold-out) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-09 |
| **Depends on** | BL-054 (NIFTY variant results), BL-056 (SENSEX variant results, day features) |
| **TODO.md row** | — |

## Context

BL-054 ranked 33 NIFTY variants on two weeks' P&L and found no persistence. BL-056 split all 66
variants by weekday, days to expiry and VIX band. The owner's idea (2026-10-09 chat): pick every
day, like Momentum, with a score that mixes recent P&L with how the variant has done on *this
kind of day* (weekday, days to expiry, VIX band), recent history weighted more. The POC answers
whether that daily score beats luck, equal weight and the fixed live mix.

Owner's answers (2026-10-09): daily selection; Case B = no Widesl minimum; Buy trigger = a Buy
variant in the overall top 10; skew weights 40 / 30 / 30.

## Goal

A pass / kill / inconclusive answer to the rule below, with the numbers.

## Out of scope

Live or paper trading, a dashboard screen, changes to `strategies/legwise/`, tuning any weight.

## Plan

### Phase 0 — Pre-register

Committed before any run. Never edited after a run; a changed rule is a new dated block.

- **Hypothesis:** the 5 Widesl/Dir variants with the best four-criteria score for a day, plus up
  to 2 Buy lots when a Buy variant scores in the top 10, earn more over the selection period
  than the same lots picked at random under the same constraints, than all variants equally
  weighted, and than the fixed live NIFTY mix.
- **Universe:** the 66 variants as already backtested — 33 NIFTY (`research/bl054/results/`,
  Widesl OTM1 / Dir ATM / Buy × 11 start times 09:17–11:47) and 33 SENSEX
  (`research/bl056/results/`, Widesl OTM2 / Dir ATM / Buy × the same times). 1 lot each, today's
  lot size, before charges. Window 2025-09-01 → 2026-10-08 (one expiry regime per index);
  weekend sessions dropped. Day attributes as in BL-056: weekday; days to expiry from the
  contract expiry dates in the lake; VIX band (`<10.5 | 10.5–11.5 | 11.5–13 | 13–15 | 15–18 |
  18+`) from the INDIAVIX 09:15 open. Ranking is in rupees per lot, which favours NIFTY (lot 75)
  over SENSEX (lot 20); reported, not corrected.
- **Score for day t, per variant**, from days strictly before t (the VIX band is t's own
  09:15 open, known before the earliest entry at 09:17):
  1. **Recent P&L (33%):** ⅔ × P&L over the last 5 trading days + ⅓ × P&L over the 5 before.
  2. **Weekday fit (25%):** 0.4 × avg P&L on days with t's weekday in the last 5 trading days
     + 0.3 × the same over the last 21 + 0.3 × the same over the last 63. A window with no
     matching day is dropped and the remaining weights renormalised.
  3. **Days-to-expiry fit (25%):** as 2, matching t's days to expiry.
  4. **VIX-band fit (17%):** as 2, matching t's VIX band.
  Each criterion is turned into a percentile rank across the 66 (0–1); the composite is
  0.33 × r1 + 0.25 × r2 + 0.25 × r3 + 0.17 × r4. Ties broken by variant id.
- **Selection, every day:**
  - **Core (5 lots)** from the 44 Widesl and Dir variants, top 5 by composite.
    **Case A:** at least 2 Widesl (NIFTY or SENSEX): if fewer, the lowest-scoring Dir picks are
    swapped for the next-best Widesl until there are 2. **Case B:** no minimum.
  - **Buy add-on (0–2 lots):** each Buy variant (either index) in the overall top 10 of 66 by
    composite gets 1 lot, at most 2. Buy is never in the core.
  - **Warm-up:** criteria need 63 trading days of history; selection runs from the 64th trading
    day of the window (about 2025-12-01) to 2026-10-08.
- **Look-ahead check:** the script asserts that every input to day t's score is dated before t,
  except the VIX open of t itself.
- **Comparators** (same days, same daily lot count as the case being scored):
  - **R:** 5 random Widesl/Dir variants per day under that case's constraint, plus the same number
    of random Buy variants on the days the rule added Buy; 1,000 runs. The luck distribution.
  - **E:** the 44 Widesl/Dir variants equally weighted scaled to 5 lots, plus the 22 Buy variants
    equally weighted scaled to that day's Buy lots.
  - **B2:** the fixed live NIFTY mix, 3 × Widesl OTM1 09:17 + 2 × Dir ITM1 09:24
    (`research/bl054/results/nifty_*.csv`), 5 lots every day.
- **Pass / kill rule** (read from **Case A**; Case B reported alongside):
  - **Pass** if all three hold: (1) total P&L ≥ R's 90th percentile; (2) beats E on total with a
    max drawdown no worse; (3) beats B2 on total with a max drawdown no worse.
  - **Kill** if (1) fails. Otherwise **inconclusive**.
- **Reported alongside, not in the rule:** per-criterion signal (Spearman of each criterion's
  rank vs next-day P&L across the 66, averaged over days) and the composite's; pick mix (NIFTY vs
  SENSEX, Widesl count per day, how often the Case A override fired); Buy days and the add-on's
  own P&L vs the same lots on the days it stayed out; per-lot-day P&L for every line; a hindsight
  ceiling (best fixed 5 over the selection period, look-ahead, labelled).
- **Hold-out:** none. Owner override: the window was already analysed in BL-056.
- **Will not run:** other criterion weights or skew weights, other lookbacks, top-N other than 5,
  weekly selection, other Buy triggers or more than 2 Buy lots, lot-size normalisation, the
  2024-10-09 → 2025-08-31 period, charges. Each needs a new dated block.
- **Result:** **inconclusive** (condition 2 fails). 265 common weekdays; four days present in one
  index only dropped (NIFTY 23–24 Sep 2026, SENSEX 16–17 Sep 2026); selection 2025-12-03 → 2026-10-08,
  202 days; Buy add-on fired on 89 days (35 × 1 lot, 54 × 2); lots/day 5.71. **Case A** (verdict):
  ₹3,31,842, max DD −₹57,153, worst day −₹16,033, ₹288 per lot-day; R random P50 ₹2,26,445 / P90
  ₹2,93,922 (beats 98% of runs → (1) passes); E ₹2,44,304 / DD −₹56,095 (more total, drawdown ₹1,058
  worse → (2) fails); B2 ₹1,85,540 / DD −₹1,67,246 → (3) passes. **Case B:** ₹2,95,601 / DD −₹70,205,
  80th percentile of random, fails (1) and (2). Per-criterion signal (Spearman vs same-day P&L across
  the 66, mean over days): recent +0.045, weekday +0.024, dte +0.013, VIX +0.023, composite +0.039
  — small but positive, the recent-P&L term carries most of it. Picks: the ≥2-Widesl override fired
  on 128 of 202 days (the score prefers Dir); case A held exactly 2 Widesl on 155 days; NIFTY 56%
  of core picks; 3.25 of 5 core members changed per day. Buy add-on earned ₹19,688 on its 89 days
  (₹221/day) against ₹58/day for the top-2 Buy on the days it stayed out. Hindsight ceiling (look-ahead):
  best fixed 5 = all Dir (N 11:02, S 09:47, S 11:02, N 10:47, S 11:32) ₹5,22,577. Case A's edge over
  E is +₹87,538 before charges with 3.25 strategy changes a day. Script: `research/bl057/rotate.py`.

### Phase 1 — Script and run
- `research/bl057/rotate.py`: loads the 66 result files, builds day features (reuse
  `research/bl056/analyse.day_features`), scores, selects, scores the comparators, prints the
  verdict. No new backtests.
- Done when: the look-ahead assert passes; Case A and B tables, R/E/B2 and the reports above are
  printed; Result is filled in.

### Phase 2 — Decide (owner)
- Pass: a new dated block on unseen days (forward, since the earlier period is a different
  expiry regime) before any money. Kill: Dropped.

## Risks

- About 215 selection days; the two-week criterion alone already showed no persistence
  (BL-054). Weekday fit from "the last 5 trading days" is one day's P&L.
- Daily switching means a different set of 5–7 strategies almost every day; live, that is a lot
  of AlgoTest edits and more charges than a fixed mix.
- Rupee ranking will mostly pick NIFTY; SENSEX variants need ~4× the rank advantage to appear.

### 2026-10-09 (later) — Same rule with at least 3 Widesl in the core
Added after the first block's result was read. It changes only the core constraint.
- **Hypothesis:** forcing at least 3 of the 5 core lots to be Widesl (NIFTY or SENSEX) keeps the
  edge over luck and lowers drawdown.
- **Rule:** identical to the first block (criteria, weights, lookbacks, Buy add-on, window,
  selection days) except Case A's minimum: if fewer than 3 Widesl are in the top 5, the
  lowest-scoring Dir picks are swapped for the next-best Widesl until there are 3.
- **Comparators:** R drawn under the same at-least-3 constraint, 1,000 runs, same seed; E and B2
  unchanged.
- **Pass / kill rule:** the first block's, read from this case.
- **Hold-out:** none; chosen by the owner after seeing the at-least-2 result on the same window,
  so the result is exploratory and cannot replace the first block's verdict.
- **Will not run:** minimums of 4 or 5 (as in BL-054, the owner kept the sweep at 2 and 3).
- **Result:** **inconclusive**, and worse than the at-least-2 case on every line. Same 202 days and
  Buy add-on days. At least 3 Widesl: ₹2,81,250, max DD −₹86,287, worst day −₹16,061, ₹244 per
  lot-day; R (at-least-3) P50 ₹1,87,742 / P90 ₹2,53,976, beats 97% → (1) passes; E ₹2,44,304 /
  DD −₹56,095 → (2) fails (more total, drawdown ₹30,192 worse); B2 → (3) passes. Against the
  at-least-2 case: −₹50,592 total, drawdown ₹29,134 worse. The override fired on 155 of 202 days
  (core held exactly 3 Widesl on 175). The first block's verdict stands. `rotate.py --min-wide 3`;
  the default reproduces the first block's ₹3,31,842.

### 2026-10-09 (later still) — Same rule with at least 1 and at least 0 Widesl
Added after the first two blocks' results were read. Changes only the core constraint.
- **Hypothesis:** a lower Widesl minimum (1, or none) lets the score pick more Dir and earns more
  without a worse drawdown than at least 2.
- **Rule:** identical to the first block except Case A's minimum, set to 1 and to 0. "At least 0"
  is the first block's Case B, already run (₹2,95,601, max DD −₹70,205); it is re-run here with
  its own random baseline drawn under no constraint, so all four minimums (0, 1, 2, 3) can be
  read side by side.
- **Comparators:** R drawn under the same minimum, 1,000 runs, same seed; E and B2 unchanged.
- **Pass / kill rule:** the first block's, read from each case; none replaces the first block's
  verdict.
- **Hold-out:** none; same window, exploratory, chosen after seeing the earlier results.
- **Will not run:** other minimums (4, 5), any other change to the rule.
- **Result:** (after the run)

## Log

- 2026-10-09 — created from the owner's idea and answers; override: same already-seen window.
- 2026-10-09 — ran; inconclusive under the pass rule (Result above).
- 2026-10-09 — at-least-3 block ran; inconclusive, below the at-least-2 case on total and drawdown.
