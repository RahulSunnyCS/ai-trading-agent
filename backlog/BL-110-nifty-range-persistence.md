# BL-110 — Does NIFTY's daily range persist? Expansion continues, range-bound continues

| | |
|---|---|
| **Priority** | P2 — owner's question; descriptive, nothing in the rotation changes |
| **Status** | In progress |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-15 |
| **Depends on** | none |
| **TODO.md row** | — |

## Context

The owner (2026-10-15): "analysis on range of NIFTY on each day … if range increased then it will
continue for some time, and if it is range-bound it will continue for some time; do you think so".
That is volatility clustering. Related, already tested: BL-081 (14 intraday state variables at
10:30 to 13:30 for pending picks: none passes) and BL-053 (VIX move at 10:00: killed); the Regime
card describes the range mix per period and "tests nothing". This item asks only whether a day's
range, and the opening range, say anything about the next sessions and the rest of the day.

## Goal

A measured answer, with intervals, to three questions about NIFTY's index range. No strategy, list
or weight is touched.

## Out of scope

- Any use of the answer to pick, re-time or size trades (that is a new registered test).
- SENSEX, option prices, P&L.

## Plan

### Phase 0 — Pre-register
Committed before `research/bl110/persistence.py` is run.

- **Hypothesis:** a session whose range is large relative to its recent norm is followed by larger
  than normal ranges for some sessions, and a session with a small range by smaller than normal
  ones; the opening range carries information about the rest of that day.
- **Universe / data:** NIFTY 50 index, 1-minute bars in the lake, every session 2022-01-03 to
  2026-10-15 with a bar at 09:15 and one at or after 15:25 (a short session such as Muhurat is
  excluded). India VIX daily close from the lake for the control. Nothing is point-in-time
  sensitive: the index has no membership or survivorship issue.
- **Definitions** (for session `t`, all in %, from the session's own bars):
  `R_t = (high − low) / open × 100`; `OR_t` = the same over 09:15 to 09:44 bars;
  `A_t` = (high − low) of bars from 09:45 to the close, ÷ the 09:45 bar's open × 100.
  `B_t` = the median of `R` over the 20 sessions before `t` (known before the open).
  `E_t = R_t / B_t`. State at the close of `t`: **expanded** if `E_t ≥ 1.25`, **range-bound** if
  `E_t ≤ 0.80`, else normal. Forward ratio `F_k = R_{t+k} / B_t` (baseline fixed at `t`, so
  later days do not move their own denominator).
- **Tests:**
  1. Spearman autocorrelation of `log R` at lags 1, 2, 3, 5, 10.
  2. Mean `F_1 … F_5` after an expanded session and after a range-bound one, and the probability
     that the next session is in the same state, against that state's overall frequency.
  3. Opening range: Spearman of `OR_t / median(OR over the prior 20)` with `A_t / median(A over
     the prior 20)`; mean `A` ratio by tercile of the opening ratio.
  4. VIX control: pooled OLS of `log R_{t+1}` on `log R_t` and `log VIX_close_t`; the coefficient
     on `log R_t` alone and with VIX, and the change in R².
- **Intervals:** circular block bootstrap of the session sequence (20-session blocks, 2,000
  resamples, seed 20261015, 90% percentile). Every result is also reported for 2022-01-03 to
  2024-10-08 and 2024-10-09 to 2026-10-15 separately.
- **Pass / kill rule:** "range persists" is **supported** only if (a) the lag-1 autocorrelation's
  interval is above zero in both sub-periods, and (b) mean `F_1` after an expanded session
  exceeds that after a range-bound one by at least 0.15 in both sub-periods. Otherwise it is
  reported as **not shown**. "Adds information beyond VIX" is supported only if the `log R_t`
  coefficient's interval stays above zero with VIX in the model, in both sub-periods. The opening
  range is "informative about the rest of the day" only if test 3's interval is above zero in
  both sub-periods.
- **Hold-out:** none; two fixed sub-periods are the stability check. Nothing is tuned: the
  thresholds above are fixed here.
- **Look-ahead check:** `B_t` and the state use only sessions up to the close of `t`; `F_k` uses
  later sessions only as the thing being described, never as an input; the opening-range test
  uses the 09:15 to 09:44 bars for `OR_t` and bars from 09:45 for `A_t`, with no overlap.
- **Will not run:** other thresholds, other lookbacks, other indices, or any trading rule on top.
  Running one needs `override: <reason>` in the Log.

## Risks

- Volatility clustering is a well-documented property of index returns, so a positive result is
  expected and is not evidence of a tradable edge.
- Event days (budget, results, policy) create expanded sessions that are not "regime": reported
  as-is, not filtered, so the answer is about all sessions.

## Log

- 2026-10-15 — created; Phase 0 registered before any run.
