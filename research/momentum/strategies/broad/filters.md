# Broad Momentum: stock filters (volume, relative strength, overextension, residual, trend quality)

**Status:** Tested · **Last updated:** 2026-10-17

## What it is

Seven stock-level features, each applied to the frozen Broad ensemble either as a tilt
(`rank = 0.75 x momentum rank + 0.25 x feature rank`, and a 50 / 50 version) or as a gate (no new
buy if it fails). From the owner's "five filters" idea, Broad only.
Code: `filters.py`, `run_broad_backtest(feature_tilt=..., extra_no_buy=...)`,
`scripts/bl050_filters.py`.

| ID | Family | Feature (weekly, point in time) | Shape | Registered direction |
|---|---|---|---|---|
| V1 | Volume | Median daily turnover (Rs) over the last 4 weeks / median over 26 weeks | Tilt | Higher is better |
| V2 | Volume | Up-week turnover / down-week turnover over 13 weeks (accumulation) | Tilt | Higher is better |
| V3 | Volume | Quiet-or-building entry (owner): last week's turnover at or below its 26-week median, or turnover rose in each of the last 3 weeks | Gate | Names that fail are worse |
| R1 | Relative strength | 26-week return must beat Nifty 500 TRI's 26-week return | Gate | Names that fail are worse |
| M1 | Momentum | Overextension: close / 10-week average in the top 5% of that week's universe | Gate | Overextended names are worse |
| M2 | Momentum | Residual momentum: 26-week sum of residuals from a trailing 52-week regression on Nifty 500 TRI, skipping the last 4 weeks | Tilt | Higher is better |
| T1 | Trend quality | Annualised slope of log weekly close over 26 weeks x R² of that fit | Tilt | Higher is better |

## Live value

None. The tilt hook is off by default and the frozen ensemble's curves hash identically with it
off.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| [BL-050](../../../../backlog/BL-050-momentum-filter-poc.md) Phase 2 screen | 13-week forward spread inside each frozen config's top momentum quintile, net of 0.3%, Newey-West t; pass = mean t >= 2 and 3 of 4 right sign | 2012-01-01 to 2023-12-31 | V1, T1, V2, R1 pass; M2, V3, M1 killed | Mean t: V1 4.76, T1 3.31, V2 3.07, R1 2.11 (all 4 of 4 right sign); M2 1.24; V3 -1.20 and M1 -2.41 (0 of 4: the wrong way, blocked names did better). [`bl050_screen_result.json`](../../../../packages/momentum-backtesting/search_spaces/bl050_screen_result.json) |
| BL-050 Phase 3 engine test | 4 tilts x 2 weights + 3 gates = 11 trials on the frozen ensemble | 2012-01-01 to 2023-12-29, pre-tax Rs 2 lakh; baseline 29.7%, worst fall -31.4%, 10.2 holdings | **No survivor**: PBO 0.72 (limit 0.5) | V1 @ 0.25 / 0.5: 30.0% / 29.8%, median 3-year change +0.3 / +0.1, win share 97% / 58%. V2: 29.7% / 29.9%. T1: 29.5%. M2: 29.7%. R1 gate: 29.6%, -0.1, 8%. V3 gate: 28.8%, worst fall -24.5%, 6.2 holdings (4% cash). M1 gate: 29.3%, -0.4. [`bl050_dev_result.json`](../../../../packages/momentum-backtesting/search_spaces/bl050_dev_result.json), [`bl050_criteria.json`](../../../../packages/momentum-backtesting/search_spaces/bl050_criteria.json) |
| [BL-115](../../../../backlog/BL-115-own-history-stock-features-winners-losers.md) | Seven own-history features at the decision week (owner's average-weekly score, steadiness, smoothness, distance below the 52-week high, turnover expansion, circuit days, spike dependence) against each trade's return over Nifty 500 TRI; pass = Spearman right sign at abs(t) >= 3 (block bootstrap over decision weeks) AND worst fifth >= 10 pts more losers, in BOTH strategies | Trio Fortnightly (384 trades) and Four Sectors Monthly, No Tilt (508), 2017-2022, pre-tax | **Killed: no feature passes in both** | Average-weekly score: Four Sectors rho +0.15, t 3.9, worst fifth 60% losers vs 49% (passes there); Trio rho +0.08, t 1.7, 61% vs 57% (fails). Turnover expansion: Four Sectors t 2.9, Trio -0.2. Every other feature abs(t) < 2.7 in both. The worst 20% of trades are spread evenly across the score's quintiles. [`bl115_result.json`](../../../../packages/momentum-backtesting/search_spaces/bl115_result.json), [`bl115_criteria.json`](../../../../packages/momentum-backtesting/search_spaces/bl115_criteria.json) |

The sealed 2024-01-01 to 2026-09-25 window was not read (no survivor). Phase 4 (forward shadow
arms) has nothing to track.

## What we know

- BL-115 (trade level, 2017-2022): a stock's own-history numbers at the decision week barely sort the picks of Trio and Four Sectors Monthly. The owner's average-weekly score (each lookback's return / weeks, added up) is the best of them and roughly as informative as the engine's own entry rank (rho about +0.15 vs -0.11 in Four Sectors, where a lower rank number is better), and it holds within the same week there (+0.18), so it is not only market timing; in Trio it does not separate (+0.08). Registered verdict: killed. Medians are close (Four Sectors 9.0 vs 8.1 for winners and losers) and the big losers are spread evenly, so a floor would not avoid them.

- The screen's signal is real among top-momentum names (V1 at t 4.8), but the tilt acts only
  inside the categories already chosen, where few names compete, so it changed few decisions
  (within +/-0.3 points).
- V3 (the owner's gate) cut the worst fall from -31.4% to -24.5% for 0.9 points of CAGR, but by
  holding about 6 stocks instead of 10. Its screen was the wrong way round and it fails the engine
  rule, so it is not evidence.
- R1 is the only own-history (time-series) relative-strength test on Broad so far: screen passed,
  engine failed. A cross-sectional "relative strength vs a benchmark" was withdrawn before the
  run: dividing every return by the same Nifty return leaves the order unchanged.
- A cash-series bug (the weekly table's liquid-fund price starts in 2016) was found and fixed
  before the verdict; the unpatched curves are kept in `data/search/round7_A/bl050/dev_unpatched/`.
- An earlier exploratory volume study (2026-10-03, `data/backtests/volume/`, 2- and 4-week ratios
  on the pool) found information coefficients near 0.

## Not yet tested

- A tilt on the wider pool or on the category choice (a different question; needs its own
  pre-registration).
- Fundamentals and delivery % (out of scope; no point-in-time data).

## In plain words

We tried seven common "extra filters" on top of momentum: rising trading volume, steady buying,
beating the Nifty 500, not being too stretched above its average, smooth trend. Several of them
did pick slightly better stocks on paper, but inside Broad they changed almost no actual buys,
and none improved the strategy.

## Related

- [Gates](../../common/gates.md) (market-wide gates), [score](../../common/score.md) (residual
  momentum as a score, BL-085 L6), [patterns](patterns.md),
  [sector relative strength](../etf-rotation/sector-rs.md).
