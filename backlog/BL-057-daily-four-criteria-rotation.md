# BL-057 — Daily four-criteria rotation over the 66 NIFTY + SENSEX start-time variants (POC)

| | |
|---|---|
| **Priority** | P2 — options research; follows BL-054 and BL-056 |
| **Status** | Planned (pre-registered; exploratory: owner override, no hold-out) |
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
- **Result:** (after the run)

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

## Log

- 2026-10-09 — created from the owner's idea and answers; override: same already-seen window.
