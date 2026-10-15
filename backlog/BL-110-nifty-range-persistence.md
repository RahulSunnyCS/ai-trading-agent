# BL-110 — Does NIFTY's daily range persist? Expansion continues, range-bound continues

| | |
|---|---|
| **Priority** | P2 — owner's question; descriptive, nothing in the rotation changes |
| **Status** | Done |
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
- 2026-10-15 — **Run** (`research/bl110/persistence.py`; `persistence_2026-10-15.json`). 1,175
  sessions, 2022-01-03 to 2026-10-15; median day range 0.86%, opening range 0.40%. Registered rule:
  **range persists: supported** (lag-1 autocorrelation 0.41 [0.32, 0.48] and 0.35 [0.23, 0.43];
  next-day ratio expanded minus range-bound +0.34 and +0.26, both ≥ 0.15); **beyond VIX: supported**
  (coefficient 0.20 [0.14, 0.25] and 0.13 [0.05, 0.21] with VIX in the model); **opening range
  informative: supported** (Spearman 0.30 and 0.33). Read the result as: expansion persists (next
  five sessions about 1.2 to 1.3 times the norm); range-bound does **not** shrink the next ranges
  (0.95 to 1.09 times) and only raises the chance of another quiet day (0.42 to 0.44 vs 0.32).
  Not a trading rule; findings page `research/options/common/index-range-persistence.md`.
  The owner asked whether daily candles would do: for the day-range tests they give the same
  numbers; the opening-range test needs minutes. A 2016 to 2021 daily-candle confirmation is a
  possible follow-up (needs the Fyers token); not run.
- 2026-10-15 — **Amendment 1 (registered before it is run; the main result above is unchanged).**
  The owner pointed to Momentum's daily NIFTY file. It holds `date, open, close` only, 2016-01-01
  to 2026-10-09 (no high or low), so it cannot give the day range `R`. A confirmation on the 2016
  to 2021 sessions, which the main run never saw, uses the standard proxy
  `M_t = |ln(close_t / close_{t-1})| × 100`. Rule, fixed now: same `B_t` (median of `M` over the
  prior 20 sessions), same states (`E ≥ 1.25` expanded, `E ≤ 0.80` range-bound), same
  20-session-block bootstrap (seed 20261015). **Supported** if, over 2016-02-01 to 2021-12-31,
  the lag-1 autocorrelation's 90% interval is above zero AND the mean next-day ratio after an
  expanded session exceeds that after a range-bound one with its interval above zero. Also
  reported over 2022-01-03 to 2026-10-09 (to see how the proxy compares with the range result).
  No opening-range or VIX test (not available in this file). Script `research/bl110/proxy_2016.py`.
- 2026-10-15 — **Amendment 1 run** (`research/bl110/proxy_2016.py`; `proxy_2016_2026-10-15.json`),
  2,668 sessions from Momentum's file, on `|ln close/close|`. **2016-02 to 2021-12 (1,465
  sessions, unseen by the main run): supported.** Lag-1 autocorrelation of log |return| 0.11
  [0.05, 0.16]; next-day ratio after an expanded session 1.43 vs 1.24 after a range-bound one,
  difference +0.19 [+0.06, +0.32]. On 2022 to 2026 the same proxy gives 0.12 [0.06, 0.18] and
  +0.37 [+0.21, +0.52], so the proxy and the true range agree on direction. The proxy is much
  noisier (autocorrelation 0.11 against 0.38 for the true range): a day's absolute return can be
  small while its range is large. Compare the two states with each other, not with 1.0: a mean
  of ratios to a median baseline sits above 1 for any skewed series. The same-state probabilities
  barely differ from the base rates (0.41 vs 0.40, 0.41 vs 0.42), so on this proxy
  "range-bound continues" is not shown, consistent with the main result.

