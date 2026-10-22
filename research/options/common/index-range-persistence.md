# Options: does NIFTY's daily range persist?

**Status:** Tested · **Last updated:** 2026-10-22

## What it is

Volatility clustering on the index itself: a session whose high-to-low range is large relative to the
last 20 sessions' median (`E = R / median`) is followed by larger-than-normal sessions, and a session
with a small range by smaller ones; the first 30 minutes' range says something about the rest of the
day. Measured on NIFTY 50 1-minute index bars, 1,178 sessions, 2022-01-03 to 2026-10-15
([BL-110][bl110]). It describes the market; no list, weight or trade uses it.

## Live value

None. Nothing in the rotation reads a range. The Regime card shows the range mix per period.

## Tested

Pre-registered (rule, thresholds and intervals fixed before the run). 90% circular block bootstrap
(20-session blocks). First period 2022-01-03 → 2024-10-08 (661 sessions with a 20-day baseline),
second 2024-10-09 → 2026-10-15 (497).

| Question | First period | Second period |
|---|---|---|
| Autocorrelation of log range, lag 1 / 2 / 3 / 5 / 10 | 0.41 / 0.33 / 0.28 / 0.24 / 0.22 | 0.35 / 0.32 / 0.27 / 0.26 / 0.24 |
| Lag-1 interval | [0.32, 0.48] | [0.23, 0.43] |
| After an **expanded** session (E ≥ 1.25), next 1…5 sessions' range ÷ baseline | 1.31, 1.28, 1.28, 1.25, 1.18 | 1.23, 1.24, 1.23, 1.17, 1.30 |
| After a **range-bound** session (E ≤ 0.80), same | 0.97, 1.01, 1.02, 1.07, 1.09 | 0.97, 0.95, 0.98, 0.97, 0.97 |
| Next session in the same state (expanded / range-bound) vs its overall frequency | 0.39 vs 0.30 / 0.44 vs 0.32 | 0.36 vs 0.30 / 0.42 vs 0.31 |
| Next-day ratio, expanded minus range-bound | +0.34 [0.22, 0.48] | +0.26 [0.15, 0.37] |
| Opening range vs rest-of-day range, Spearman | 0.30 [0.24, 0.35] | 0.33 [0.26, 0.39] |
| Rest-of-day range by opening-range tercile (low / mid / high) | 0.95 / 1.12 / 1.31 | 0.94 / 1.14 / 1.28 |
| Coefficient of log range on next day's log range, alone → with log VIX close | 0.41 → 0.20 [0.14, 0.25] | 0.34 → 0.14 [0.05, 0.21] |
| R² of that regression, alone → with VIX | 0.17 → 0.28 | 0.12 → 0.23 |

Verdict under the registered rule: **range persistence supported in both periods; the range keeps a
positive coefficient with VIX in the model in both; the opening range is informative about the rest
of the day in both.**

**Post-hoc check (added after review, not part of the registered rule).** The ratios above are means
of `R_{t+1} / B_t`, which sit above 1 for any skewed series: over all sessions they average 1.09 to
1.12, so 1.0 is the wrong reference. Against the all-session average:

| Next day, minus the all-session mean | After expanded | After range-bound |
|---|---|---|
| First period | +0.14 | −0.15 |
| Second period | +0.14 [+0.07, +0.19] | −0.12 [−0.18, −0.06] |
| Average of the next 5 days, second period | +0.13 [+0.08, +0.18] | −0.13 [−0.19, −0.07] |

(`research/bl110/posthoc_baseline_2026-10-15.json`.)

## What we know

Descriptive readings of the table; leads, not findings, until a rule built on them passes a test.

- **Both states persist, about equally.** After a large-range session the next sessions' range is
  about 0.13 to 0.14 of the baseline above a typical session, and after a quiet one about 0.09 to
  0.15 below it, for several days (lag-10 autocorrelation is still 0.22 to 0.24).
- **The raw ratios overstate the expansion.** "1.2 to 1.3 times the norm" is partly the skew of the
  ratio; relative to a typical session the lift is about 0.14. Read levels against the all-session
  average, not against 1.0.
- **VIX carries part of it, not all.** Adding the previous India VIX close roughly halves the
  coefficient on the previous range (0.39 → 0.18 overall) while R² rises from 0.15 to 0.26: the range
  still adds information beyond VIX, with less weight.
- **The opening range matters for the same day.** The top third of opening ranges is followed by a
  rest-of-day range about 1.3 times the norm, the bottom third about 0.95 times (the opening-range
  effect also holds after controlling for the previous day's range and VIX, per the review).
- **Volatility clustering is a standard property of index returns**, so a positive result was
  expected; this is not evidence of a tradable edge.

## Confirmation on 2016 to 2021 (Amendment 1)

Momentum's daily NIFTY file (open and close only) was used on the sessions the main run never saw,
with `|ln close_t / close_{t-1}|` as the proxy and the same states and intervals.

| 2016-02 → 2021-12, 1,465 sessions | Result |
|---|---|
| Lag-1 autocorrelation of log \|return\| | 0.11 [0.05, 0.16] |
| Next-day ratio, expanded vs range-bound | 1.43 vs 1.24, difference +0.19 [+0.06, +0.32] |
| Same state next day (expanded / range-bound) vs overall | 0.41 vs 0.40 / 0.41 vs 0.42 |

Expansion carrying into the next sessions is supported on the registered window. Caveats: the proxy
is noisier (autocorrelation 0.11 against 0.38 for the real range), so only the direction compares;
the same-state probabilities barely differ from the base rates; and the result rests on 2020 to
2021: split post hoc, 2016 to 2019 alone shows nothing (lag-1 0.04 [−0.03, 0.09], gap +0.12
[−0.02, +0.25]). Compare the two states with each other, not with 1.0.

## Opening range against other forecasts (BL-022)

[BL-022][bl022] used the opening range as one of its baselines for the rest-of-day range, with a
different definition: the range from 09:15 up to the check time T (10:30, 11:00 or 12:00), scaled by
the same window over the previous 20 sessions. Spearman ρ with the realised range from T to the
close:

| Window | Opening range | VIX-implied | Analog days (BL-022) |
|---|---|---|---|
| NIFTY 2025-01-01 → 2026-10-21 (441 days) | 0.49 / 0.49 / 0.52 | 0.45 / 0.44 / 0.43 | 0.38–0.44 |
| NIFTY 2022–24 (738 days, reported only) | 0.49–0.53 | 0.47 | 0.44–0.46 |
| SENSEX 2025-09-16 → 2026-10-21 (264 days, reported only) | 0.53–0.54 | 0.58–0.60 | 0.39–0.53 |

On NIFTY the scaled opening range was the best of the forecasts tried at every check time; on
SENSEX the VIX-implied move was. A range forecast, not P&L: BL-081 found the morning range does not
help pending picks.

## Not yet tested

- Whether any of this can time a strategy: BL-053 and BL-081 tried VIX and 14 intraday state
  variables for the rotation and found nothing that holds ([Intraday state](intraday-state.md));
  [BL-111](../../../backlog/BL-111-range-regime-strategy-mix.md) registers a range-regime lot split.
- The day range itself before 2022 (needs daily high and low; Momentum's NIFTY file has only open
  and close). The opening-range test needs 1-minute bars.
- Event days (budget, policy, results) are in the sample as they came; not separated.

## Related

- [Intraday state](intraday-state.md), [Rotation ranking](rotation-ranking.md) (the VIX-band fit
  already carries the level information).
- Scripts: `packages/option-backtesting/research/bl110/` (`persistence.py`, `proxy_2016.py`,
  `posthoc_baseline.py`) and their JSON.

[bl110]: ../../../backlog/BL-110-nifty-range-persistence.md
[bl022]: ../../../backlog/BL-022-analog-day-search.md
