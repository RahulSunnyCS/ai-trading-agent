# Options: does NIFTY's daily range persist?

**Status:** Tested · **Last updated:** 2026-10-15

## What it is

Volatility clustering on the index itself: a session whose high-to-low range is large relative to the
last 20 sessions' median (`E = R / median`) is followed by larger-than-normal sessions, and a session
with a small range by smaller ones; the first 30 minutes' range says something about the rest of the
day. Measured on NIFTY 50 1-minute index bars, 1,175 sessions, 2022-01-03 to 2026-10-15
([BL-110][bl110]). It describes the market; no list, weight or trade uses it.

## Live value

None. Nothing in the rotation reads a range. The Regime card shows the range mix per period.

## Tested

Pre-registered (rule, thresholds and intervals fixed before the run). 90% circular block bootstrap
(20-session blocks). First period 2022-01-03 → 2024-10-08 (661 sessions), second 2024-10-09 →
2026-10-15 (494).

| Question | First period | Second period |
|---|---|---|
| Autocorrelation of log range, lag 1 / 2 / 3 / 5 / 10 | 0.41 / 0.33 / 0.28 / 0.24 / 0.22 | 0.35 / 0.32 / 0.27 / 0.26 / 0.24 |
| Lag-1 interval | [0.32, 0.48] | [0.23, 0.43] |
| After an **expanded** session (E ≥ 1.25), next 1…5 sessions' range ÷ baseline | 1.31, 1.28, 1.28, 1.25, 1.18 | 1.22, 1.21, 1.22, 1.15, 1.29 |
| After a **range-bound** session (E ≤ 0.80), same | 0.97, 1.01, 1.02, 1.07, 1.09 | 0.97, 0.95, 0.97, 0.97, 0.97 |
| Next session in the same state (expanded / range-bound) vs its overall frequency | 0.39 vs 0.30 / 0.44 vs 0.32 | 0.36 vs 0.31 / 0.42 vs 0.32 |
| Next-day ratio, expanded minus range-bound | +0.34 [0.22, 0.48] | +0.26 [0.14, 0.36] |
| Opening range vs rest-of-day range, Spearman | 0.30 [0.24, 0.35] | 0.33 [0.25, 0.39] |
| Rest-of-day range by opening-range tercile (low / mid / high) | 0.95 / 1.12 / 1.31 | 0.94 / 1.14 / 1.28 |
| Coefficient of log range on next day's log range, alone → with log VIX close | 0.41 → 0.20 [0.14, 0.25] | 0.34 → 0.13 [0.05, 0.21] |
| R² of that regression, alone → with VIX | 0.17 → 0.28 | 0.12 → 0.23 |

Verdict under the registered rule: **range persistence supported in both periods; adds information
beyond VIX in both; the opening range is informative about the rest of the day in both.**

## What we know

- **Expansion persists, and for a while.** After a large-range session the next five sessions
  average about 1.2 to 1.3 times the baseline range, decaying slowly (lag-10 autocorrelation is
  still 0.22 to 0.24).
- **Range-bound does not persist the same way.** After a quiet session the next sessions' range is
  about normal (0.95 to 1.09), not smaller. A quiet session is somewhat more likely to be followed
  by another quiet one (0.42 to 0.44 against 0.32), but the average range does not shrink. The
  owner's second half ("range-bound continues") holds as a higher chance of another quiet day, not
  as a lower range.
- **VIX carries much of it.** Adding the previous close of India VIX roughly halves the coefficient
  on the previous range (0.39 → 0.18 overall) and raises R² from 0.15 to 0.26, but the range keeps
  a positive, significant coefficient: it is not just VIX.
- **The opening range matters for the same day.** The top third of opening ranges is followed by a
  rest-of-day range about 1.3 times the norm, the bottom third about 0.95 times.
- **Volatility clustering is a standard property of index returns**, so a positive result was
  expected; this is not evidence of a tradable edge.

## Confirmation on 2016 to 2021 (Amendment 1)

Momentum's daily NIFTY file (open and close only) was used on the sessions the main run never saw,
with `|ln close_t / close_{t-1}|` as the proxy and the same states and intervals.

| 2016-02 → 2021-12, 1,465 sessions | Result |
|---|---|
| Lag-1 autocorrelation of log |return| | 0.11 [0.05, 0.16] |
| Next-day ratio, expanded vs range-bound | 1.43 vs 1.24, difference +0.19 [+0.06, +0.32] |
| Same state next day (expanded / range-bound) vs overall | 0.41 vs 0.40 / 0.41 vs 0.42 |

Expansion carrying into the next sessions is **supported out of sample**; range-bound sessions
being followed by more range-bound ones is **not shown** on the proxy. The proxy is noisier
(autocorrelation 0.11 against 0.38 for the real range), so the numbers are not comparable to the
table above; only the direction is.

## Not yet tested

- Whether any of this can time a strategy: BL-053 and BL-081 tried VIX and 14 intraday state
  variables for the rotation and found nothing that holds ([Intraday state](intraday-state.md)); a
  range-based timing rule would be a new registered test.
- The day range itself before 2022 (needs daily high and low; Momentum's NIFTY file has only open
  and close, so the 2016 to 2021 check below uses |close-to-close| as a proxy). The opening-range
  test needs 1-minute bars.
- Event days (budget, policy, results) are in the sample as they came; not separated.

## Related

- [Intraday state](intraday-state.md), [Rotation ranking](rotation-ranking.md) (the VIX-band fit
  already carries the level information).
- Script: `packages/option-backtesting/research/bl110/persistence.py`; result:
  `persistence_2026-10-15.json` in the same folder.

[bl110]: ../../../backlog/BL-110-nifty-range-persistence.md
