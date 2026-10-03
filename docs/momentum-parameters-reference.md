# Momentum lab: parameter reference

Purpose: a durable record of every parameter the momentum lab uses, its shipped default and where
that default lives, what it does mechanically, why it is set that way, and the evidence.
Companion: `docs/momentum-parameters-plain-english.md`.

Evidence grades: **M** = measured in a logged real-data backtest (cited to its `TODO.md` row);
**R** = reasoned from the code, not isolated by a backtest. No row is graded **D** (dry run
pending) any more: the 2026-10-01 dry run (TODO 3.9.23, `scripts/param_dry_run.py`,
`scripts/alpha_experiments.py`, `scripts/reversal_experiment.py`) measured every one. Where a
default lives: `Config` = `engine.py`; `API` = `BacktestRequest` in `api.py`; `Broad` =
`categories/broad.py`; `Live` = `live_config.toml`.

**How the 2026-10-01 numbers read.** Two baselines, one parameter changed at a time:

- **ETF** = the live strategy (`live_config.toml`: top 5 / exit 10, equal-weight 1/4/13/26/52,
  buffer + wait, 35% cap, 0.10% cost, ETF prices, Friday close): 25.8% CAGR / Sharpe 0.99 /
  max drawdown -30.5% (2017-01 to 2026-09), 33.0% / 1.20 / -15.2% last 5 years, 39.9% / 1.37 /
  -15.2% last 3 years.
- **Broad** = Broad Momentum with the dashboard defaults, every week simulated (see
  `min_ranked`): 31.7% / 1.06 / -20.4% full, 31.5% / 1.06 / -19.1% last 5 years, 30.2% / 0.99 /
  -19.1% last 3 years.

Cells give full-window CAGR / Sharpe / MaxDD, then "rolling X / Y / Z%": the share of 28 rolling
3-year windows (fresh start each, 2017-01 to 2026-09) in which the variant beat its baseline on
CAGR / Sharpe / MaxDD, then the median CAGR change across windows. A lever "wins most" only when
it beats the baseline on both CAGR and Sharpe in more than half the windows. Windows overlap, so
a share is a robustness score, not 28 independent tests, and about 90 variants were tried in
total, so expect one or two chance "wins". **Broad numbers logged before 2026-10-01 (3.9.13,
3.9.18, 3.9.20) came from an engine that skipped thin weeks and overstated CAGR by about 6
points and Sharpe by about 0.6; they are kept below only where marked "gapped engine".**

## 1. Universe and data

| Parameter | Default (source) | Mechanism | Rationale and benefit | Grade |
|---|---|---|---|---|
| `start` | 2017-01-01 (Config, API, Live) | First week of the backtest. History is fetched from 2016-01-01 so 52-week returns exist from Jan 2017 | Gives a full 52-week look-back before the first trade | R |
| `end` | None = latest (Config) | Last week of the backtest | Used to define evaluation windows | R |
| `universe` / `include_optional` | every `core` row, optional off (Config) | Which instruments are ranked. Core is 21 rows in `universe.csv` (4 broad, 13 sector/thematic, gold, silver, Nasdaq 100, Hang Seng) | Optional rows have ETF turnover below about 2 crore a day or overlap heavily with a core row | R |
| `benchmark` | `Nifty 50` (Config, API) | Column used as the chart's comparison line, priced like the strategy: the price index in index mode, NIFTYBEES (dividends kept) in ETF mode | ETF mode is therefore NOT inflated by dividends (NIFTYBEES 12.48% vs Nifty 50 TRI 12.58% a year, 2017-2026). Index mode compares price with price, so its edge is honest relative to the index but about 1.3 points above the edge over Nifty 50 TRI | M, 3.9.23 |
| Comparison lines (`reference_benchmarks.py`) | always on | Every payload carries `comparisons`: Nifty 50 TRI and Nifty200 Momentum 30 TRI (back-calculated by NSE before 2020-08-11), with CAGR edge | The honest passive alternative and the buyable momentum alternative. ETF live strategy: +13.2 points a year over Nifty 50 TRI, +8.7 over Momentum 30 TRI (full); Broad: +19.1 and +14.6 | M, 3.9.23 |
| Weekly close | last trading day of each Mon-Fri week, labelled Friday | Turns daily data into the signal frequency | One decision per week | R |

## 2. Ranking

| Parameter | Default (source) | Mechanism | Rationale and benefit | Grade |
|---|---|---|---|---|
| `lookbacks` | (1, 4, 13, 26, 52) weeks (Config, API, Live) | Return over each window, ranked across eligible instruments | Approximates 1w, 1m, 3m, 6m, 12m. Eligibility requires history for the longest window | R |
| `weights` | None = equal (Config) | Score = sum of weight x rank; lowest wins. Negative weight rewards worst-ranked on that window. All-zero rejected | Dropping the 1-week window (0,1,1,1,1): ETF 23.9% / 0.92 / -31.2%, rolling 21 / 29 / 25%, median -1.6 (the 1-week window helps on ETFs). Broad 33.9% / 1.11 / -26.7%, rolling 64 / 54 / 39%, median +2.8, but deeper drawdowns and the cold-start fork caveat. Keep equal weights | M, 3.9.23 |
| Skip-month ranksum (`levers.skip_month_ranks`) | not default | Rank on 3-1, 6-1 and 12-1 month returns (the last 4 weeks left out) through `external_ranks` | ETF 19.7% / 0.73 / -38.0%, rolling 11 / 11 / 21%, median -5.7. Rejected | M, 3.9.23 |
| Tie-break | middle lookback's return, then name (engine) | Makes runs reproducible | Deterministic ranks independent of column order | R |
| `score` | `ranksum` (Config, API) | `voladj`: 6m and 12m return divided by 26-week vol, z-scored and summed. `blend`: average of both ranks | ETF `voladj` 26.4% / 1.09 / -26.1%, rolling 64 / 68 / 68%, median +1.5, only 7 buys a year (45-week average hold), but it trails in the last 5y (30.4% vs 33.0%) and 3y (31.1% vs 39.9%): a tax-efficient candidate, not a clear win. ETF `blend` loses (median -1.4). Broad `blend` 34.1% / 1.11 / -26.7%, rolling 68 / 61 / 61%, median +4.3, fork caveat | M, 3.9.23 |
| `voladj_skip_recent_month` | True | voladj returns measured 4 weeks ago | Standard 12-1 convention: avoids short-term reversal | R |
| Volume surge as a ranking aid (VR2 / VR4 / RISE2: median daily shares over the last 2 or 4 weeks vs the prior 26 weeks, or weekly volume up 2 weeks running; `scripts/volume_turnover_tests.py`) | not built | Research feature, per price segment, medians not sums. Tested as a predictor (V2), not simulated | Broad pool, controlled for momentum rank and the 2-week return: rank IC about +0.01, interval includes zero at 4 and 13 weeks; no 26-52 week reversal. Also does not separate blow-off spikes: high-volume 2-week spikes kept rising more (V1, 0 of 80 cells pass). Rejected | M, 3.9.27 |
| Accumulation as a ranking aid (ACC13: shares on up days / down days, last 65 sessions) | not built | Research feature, as above | IC −0.010 at 1 week, flat at 4 and 13 weeks. Rejected | M, 3.9.27 |
| Pullback-in-uptrend lookback variants (drop the 4-week lookback, weights (1,0,1,1,1)/(0,0,1,1,1), skip-month on Broad; `levers.pullback_ranks`/`pullback_flags`) | not built | Buy a long-term-strong (13/26/52w) stock that consolidated over 4 weeks and turned up; the direct predictive test for this is `levers.long_term_strong_mask`/`pullback_flags` | Direct predictive test (does the pullback state predict forward returns, LT-controlled, 4-week bootstrap) fails: coefficient indistinguishable from zero at 4 and 13 weeks, both halves, with/without 2020 (Nifty 50 point-in-time cross-check agrees in sign for the plain pullback flag, disagrees for the turned one, but does not change the verdict). An exploratory downside-protection re-test (forward drawdown/volatility, PB only) also fails, and at 13 weeks runs the other way (significant negative coefficient: more drawdown and volatility ahead, not less). Dropping the 4-week lookback passes the full rolling-window rule on Broad mode off only (43.8% / 1.25 / -52.8% - a deeper full-sample worst drawdown than the plain ranking's -40.4%, despite winning most rolling windows; rolling 68/79/71%, +3.8pt median, both halves +1.0/+15.2), not on mode on, and both weights (0,0,1,1,1) and skip-month fail on both modes once MaxDD and both halves are checked. Stacked on the every-2-weeks cadence idea from 3.9.23 (not an adopted default), the surviving variant nominally still wins most rolling windows on CAGR/Sharpe (median +5.0pt) but its MaxDD win share is an exact wash at 50%, not a win. Rejected | M, 3.9.31 |

## 3. Selection and exit (hysteresis)

| Parameter | Default (source) | Mechanism | Rationale and benefit | Grade |
|---|---|---|---|---|
| `top_n` | 5 (Config, API, Live). Custom Index 8 (3.9.8) | Names eligible for fresh money | ETF top 3: 28.5% / 1.07 / -31.1%, rolling 96 / 79 / 61%, median +2.7 (wins most, at the cost of three ~33% positions). ETF top 8: rolling 39 / 43 / 54%, median -0.6. Custom Index 5 to 8 cut max drawdown -34.42% to -30.80% while CAGR rose 19.77% to 24.60% | M, 3.9.23, 3.9.8 |
| `exit_rank` | 10 (Config, API, Live). Custom Index 16 | Sell only when rank is worse than this | ETF exit 6: median -5.3 (21 / 29 / 25%), churn up to 69 buys a year. Exit 16: median -1.4, deeper drawdowns (-32.7%). 10 is the sweet spot of those tried. Must be >= `top_n` (validated) | M, 3.9.23 |
| Zero-cost check | n/a | Re-ran with `cost_pct=0` | Drawdown improved only 0.5 to 2 points, so whipsaw is not the main driver and an exit debounce was not built | M, 3.9.8 |
| Hold through a small pullback (`levers.cap_rank_during_pullback`: cap a held name's rank at `exit_rank` while it is long-term-strong, trend-intact, and 5-20% below its 13-week high, instead of selling it) | not built | Static rank-table transform — never needs simulation-time holdings, since `exit_rank` is always strictly above `top_n` so a non-held name's capped rank can never create a false fresh-buy | Broad mode off: 44.0% / 1.24 / -37.2%, rolling 82/89/75%, +2.0pt median, both halves +0.9/+3.4 — passes the full rolling-window rule on its own. Requiring the turn too (hold through PBR, the stricter flag) does not (win shares at or below 50%). Stacked on the every-2-weeks cadence idea from 3.9.23 (not an adopted default), the median CAGR gain shrinks to near zero (+0.2pt), the MaxDD win share is a net loss at 39%, and the direction flips sign between the two halves — no clear incremental edge over the cadence idea alone. Rejected | M, 3.9.31 |

## 4. Portfolio rule and position sizing

| Parameter | Default (source) | Mechanism | Rationale and benefit | Grade |
|---|---|---|---|---|
| `portfolio` | `buffer` (Config) | Hold until rank fails; proceeds split equally over current top N, topping up holdings. `slots` = N equal pots, no top-ups | Buffer compounds winners. Slots tested as a lever and not adopted (gapped engine for Broad) | M, 3.9.18 |
| `entry` | `wait` (Config). `make_room` available | `make_room` trims all holdings equally to buy a new top-N name at once | **Do not flip the default.** The 3.9.18 "clean win" was a full-sample result on the gapped engine. Rolling windows: ETF 25.2% / 1.02 / -29.1%, rolling 46 / 57 / 82%, median -1.4 (smoother, less return); Broad 31.3% / 1.05 / -20.4%, rolling 61 / 64 / 21%, median +0.1 (a marginal win with worse drawdowns) | M, 3.9.23 |
| `max_position` | 0.35 (Config, API, Live). Broad UI 0.15 | No holding bought or topped up past it | A risk/return dial, confirmed. ETF 0.25: rolling 32 / 71 / 64%; 0.50: 75 / 68 / 32% (median +0.6); no cap: 82 / 68 / 32% (+1.0, one ETF once reached 84%). Broad 0.10: 7 / 79 / 100% (median -2.8, MaxDD -16.1%); 0.25: 43 / 29 / 14% | M, 3.9.23 |
| `cap_band` | 0.05 | Trim back to cap only once over cap + band | Avoids a trade and tax event on small drifts | R |
| `max_group` (UI "max category") | None in Config; Broad UI 0.30 | Cap on all stocks held through one category | Removing it: Broad 32.0% / 1.07 / -20.2%, rolling 71 / 75 / 68%, median +0.4: the cap costs a little and buys nothing measurable | M, 3.9.23 |
| `max_stock_price` | Broad UI 20,000 rupees; 0 = off | Entry-only block via `no_buy` | An affordability rule, not alpha: removing it gives 32.3% / 1.08 / -20.3%, rolling 54 / 57 / 50%, median +0.3 | M, 3.9.23 |
| `exclude_high_vol` (API, ETF only) | 0 = off | Never freshly buy the most volatile fraction of the ranked instruments (26-week weekly vol, `levers.high_vol_mask`); holdings untouched | **The one robust ETF win.** 20%: 27.9% / 1.12 / -29.1%, rolling 89 / 93 / 100%, median +2.1, deflated Sharpe 0.998. All 12 settings of a 4 x 3 plateau (exclude 10-40%, vol over 13/26/52 weeks) beat baseline on Sharpe in 71-96% of windows. It mostly keeps out Realty (80% of weeks) and PSU Bank (76%). On stocks it is a disaster (Broad 16.4%, median -16.1): momentum winners are the volatile stocks | M, 3.9.23 |
| `MIN_TRADE` | 0.5% of portfolio (engine constant) | Parked cash not moved for less | Avoids dust trades | R |
| `commodity_copies`, `debt_copies` | 1 (API) | Duplicate ranked slots for gold/silver or cash/gilt in Custom Index | Default 1 = ordinary single-instrument behaviour | R |

## 5. Risk overlays and gates (all opt-in, off by default)

| Parameter | Default | Mechanism | Verdict | Grade |
|---|---|---|---|---|
| `defensive` | `off` (modes `ranked`, `filter`) | `ranked`: cash and gilt compete in the ranking. `filter`: hold only names whose `filter_lookback` (13w) return beats cash | ETF `filter` 23.7% / 0.93 / -25.8%, rolling 29 / 39 / 57%, median -1.6. Rejected again | M, 3.9.23, 3.9.18 |
| `momentum_sizing` (+ `_window` 10, `_floor` 0.0) | False | Scale fresh buys by weighted recent win rate of closed trades | ETF median -2.5 (4 / 7 / 89%), Broad median -9.3 (7 / 11 / 61%). Rejected | M, 3.9.23 |
| `mass_exit_throttle` (+ `_fraction` 0.5; threshold 0.5) | False | Withhold a fraction of fresh capital when more than 50% of held categories exit in one week | No repeatable edge (gapped engine). Rejected | M, 3.9.20 |
| `mass_exit_response` | `off` (`throttle`, `halve_top_n`) | Broad Momentum response variants | Same verdict | M, 3.9.20 |
| Vol targeting (`levers.vol_target`, post-hoc) | not built into the engine | Hold min(1, target / trailing 26-week strategy vol) of the strategy, rest in the liquid fund | A risk dial: ETF 15% target 20.7% / 0.91 / -28.9% (MaxDD better in 86% of windows, CAGR in 4%); Broad 20% target 28.1% / 1.04 / -16.6% (MaxDD better 86%, median -3.8). Ignores tax on the extra trades | M, 3.9.23 |
| 52-week-high gate (`levers.below_high52_mask`) | not default | No fresh buy more than 15% below the 52-week high | ETF rolling 64 / 61 / 7%, median +0.3; Broad 50 / 54 / 86%, median +0.1. Marginal both ways; not adopted. The blended-rank version loses (ETF median -4.1) | M, 3.9.23 |
| Smoothness gate (`levers.choppy_mask`) | not default | No fresh buy if fewer than half of the last 26 weekly returns were up | ETF flat (median 0.0), Broad median -5.9. Rejected | M, 3.9.23 |
| Trend / breadth gates (`levers.trend_gate_mask`, `breadth_gate_mask`) | not default | No fresh buys while Nifty 50 is below its 40-week average, or while fewer than 40% of names are above theirs | ETF -1.3 / -1.7, Broad -5.9 / -14.1 median. Rejected, consistent with the defensive filter | M, 3.9.23 |
| Dispersion timing (`levers.dispersion_timing`, post-hoc) | not default | Half exposure when the spread of 13-week returns is in its bottom 20% | ETF -0.6, Broad -2.8 median. Rejected | M, 3.9.23 |
| 50-day average gate (ABOVE10: weekly close above its 10-week average) | not built | Proposed: no fresh buy below the 10-week average | Below-average buys are rare (7.1% of shipped Broad's fresh buys, 2.1% with category mode off). Among equally ranked pool stocks, being above the average predicted slightly *worse* 13-52 week returns (−0.9% at 13 weeks), not significant at 4. Rejected; the negative sign is a candidate hypothesis only (TODO 3.9.30) | M, 3.9.27 |
| Weinstein stage filters (Stage 1-4 from the 30-week average, 1% slope band, 2-week hold) | not built | Proposed: no fresh buy in Stage 3 (topping); prefer early Stage 2 | Stage 3 is 9.4% of shipped Broad's fresh buys. Stage 3 did worse only at 26-52 weeks, not at 4 or 13; early Stage 2 did slightly *worse* than late Stage 2. Rejected. A 2% band showed a Stage 3 penalty at every horizon, but it was a robustness check: candidate hypothesis only (TODO 3.9.30) | M, 3.9.27 |
| Liquidity floor (LIQ13: median 65-session rupee turnover; via `run_broad_backtest(extra_no_buy=...)`) | not a setting yet (TODO 3.9.29) | No fresh buy below the floor; never forces a sale | Not an alpha lever: it measures how much CAGR is tradeable. Names under ₹5 Cr/day gave 23-30% of Broad's profit; a ₹1 Cr floor costs about 3 CAGR points (shipped Broad 37.5% → 34.2%, gapped engine), ₹5 Cr 11-12. At ₹10 lakh capital the ₹1 Cr row is the relevant one; a floor should be inflation-adjusted | M, 3.9.27 |

## 6. Costs and tax

| Parameter | Default | Mechanism | Rationale | Grade |
|---|---|---|---|---|
| `cost_pct` | 0.10 percent per side (Config, API, Live) | Flat cost on each buy and each sell | Simple stand-in for all frictions | R |
| `cost_model` | `flat`. `itemised` available | STT 0.1% each side, stamp duty 0.015% buy, exchange fees about 0.004% each side, slippage `slippage_bps` 5, DP charge 16 rupees per sell scaled by `capital` (1,000,000) and capped at 5% | Costs 0.7 CAGR points on ETF (25.1% vs 25.8%) and 2.3 on Broad (29.4% vs 31.7%, which buys 115 names a year); the edge survives both | M, 3.9.23 |
| `tax` / `TaxRules` | off; slab 0.30, cess 0.04, equity STCG 0.20, LTCG 0.125, long-term after 365 days | Per-lot tax on each sale, loss set-off, carry-forward | ETF after tax: 20.9% / 0.77 / -30.5% (about 4.9 points of CAGR to tax), still +8.3 over Nifty 50 TRI. Rates are settings, not facts. Not modelled: 1.25 lakh LTCG exemption, surcharge, 8-year limit | M, 3.9.23 |
| `tax_hold_band` / `tax_hold_weeks` | 0 / 0 = off (Config, buffer rule with tax) | Keep a gaining holding whose oldest lot turns long-term within `tax_hold_weeks` while its rank is within `exit_rank + tax_hold_band` | Band 3, 8 weeks vs tax-on baseline: 21.0% / 0.78 / -30.0%, rolling 57 / 39 / 25%, median +0.1. Neutral: average holds are about 9 weeks, so few lots ever get near 365 days | M, 3.9.23 |

## 7. Execution and cadence

| Parameter | Default | Mechanism | Rationale | Grade |
|---|---|---|---|---|
| `signal_delay` | 0 weeks (API range 0 to 4) | Trade N weeks after the signal | ETF delay 1: median -1.5 (14 / 11 / 7%), so trading on the signal week is right for ETFs. **Broad delay 1: 35.5% / 1.21 / -20.2%, rolling 89 / 96 / 79%, median +4.1**, consistent with one-week reversal in individual stocks | M, 3.9.23 |
| `execution` | `fri_close` (`mon_open`, `mon_10am`) | Fill time | ETF `mon_open`: CAGR better in 79% of windows but Sharpe 36%, MaxDD 7% (-31.2%). Friday close stays. `mon_10am` falls back to the open where no 10:00 prices exist | M, 3.9.23, 3.9.18 |
| `track` | `index` in Config/API; `etf` in `Live` | P&L on the index or the traded ETF | ETF gap measured at +0.72 CAGR points a year (index track 25.0% vs ETF 25.8%), so the live job tracks the ETF | M, README, 3.9.23 |
| `rebalance` | `weekly` (`monthly`) | Monthly trades only on the last week of each month | ETF monthly: median -2.3 (21 / 32 / 25%). Broad monthly: 39.1% / 1.32 / -25.1%, rolling 75 / 82 / 36%, median +4.1, but deeper drawdowns | M, 3.9.23 |
| `rebalance_every` / `rebalance_offset` | 1 / 0 (Config, API) | Trade every K weeks on the Fridays whose calendar week number since 2016-01-01 is the offset mod K | ETF every 2 weeks (2-tranche blend): 24.1% / 0.94 / -31.1%, rolling 18 / 14 / 25%, median -2.8: weekly is right for ETFs. **Broad every 2 weeks (2-tranche blend): 36.3% / 1.25 / -19.8%, rolling 100 / 100 / 68%, median +5.0**; every 4 weeks 37.2% / 1.29 / -20.0%, 96 / 96 / 64%, +5.2. Phase luck is large: every-2 phase 0 +1.4 vs phase 1 +8.5 median, so judge by the blend | M, 3.9.23 |
| Overlapping tranches (`tranches.py`) | research tool | K pots, each trading on its own phase, averaged | Measures start-date luck: ETF live config at K=4 spreads 4.6 to 7.9 CAGR points between phases | M, 3.9.23 |
| `premium_warn_pct` | 1.0 (2.0 international) | Live job flags a buy whose ETF trades above NAV | Premium drag is a steady cost for momentum buying | R |

## 8. Broad Momentum funnel (`category_mode="on"`)

| Parameter | Default | Mechanism | Rationale and evidence | Grade |
|---|---|---|---|---|
| `min_ranked` (API `broad_every_week`) | 0 = engine rule (top_n); study uses 1 | A week is simulated only if this many names are ranked | **With the default, weeks with fewer than categories x picks ranked stocks are skipped** (194 of 508 since 2017; no sale, no buy, the curve jumps). Skipping: 37.5% / 1.67 / -19.0%; simulating every week: 31.7% / 1.06 / -20.4%. The skipped curve is the wrong one. Recommended to make every-week the default | M, 3.9.23 |
| `pool_top_n` / `pool_exit_rank` | 200 / 250 | Stocks qualifying from about 755 (Nifty Total Market, point-in-time membership), refreshed quarterly | 100/150: 25.5% / 0.98 / -21.3%, rolling 21 / 32 / 61%, median -5.9. 300/350: 33.8% / 1.10 / -21.7%, rolling 68 / 61 / 57%, median +1.9. Fork caveat on both | M, 3.9.23 |
| `coverage_floor` | 0.40 | Minimum share of a category's members in the pool | 0.25 (the 3.9.18 candidate): 29.0% / 0.97 / -24.1%, rolling 46 / 46 / 43%, median -1.0, so not adopted. 0.60 starves the strategy (20.4%). Fork caveat | M, 3.9.23 |
| `category_top_n` / `category_exit_rank` | 4 / 8 | Category-level hysteresis | 3/6: median -1.8 (29 / 43 / 82%); 6/12: median -4.3, MaxDD -29.8%. Keep 4/8. Fork caveat | M, 3.9.23 |
| `picks_per_category` | 2 | Top stocks per held category, by pool rank | 1: 25.9% / 0.99 / -18.0%, median -5.4. **3: 34.1% / 1.16 / -20.6%, rolling 93 / 96 / 46%, median +3.0** (wins most; more names, same categories) | M, 3.9.23 |
| `off_top_n` / `off_exit_rank` (category mode off) | 10 / 20 | Direct stock ranking from the pool | Independent of the category numbers; not swept | R |

Cold-start caveat (3.9.18): levers that change category selection (pool, coverage, category
width, score, weights) fork the portfolio before `start`. Rolling windows restart the trading,
but not that selection history, so treat their numbers as indicative.

## 9. Custom Index tab

| Parameter | Default | Mechanism | Grade |
|---|---|---|---|
| `inner_top_n` / `inner_exit_rank` | 2 / 8 (`compose.py`) | Stock rotation inside each held category | R |
| Outer `top_n` / `exit_rank` | 8 / 16 | Category-vs-category rotation across 62 to 68 categories | M, 3.9.8 |

## 10. Reversal / turnaround sleeve (`reversal.py`, not in any strategy)

| Setting | Default | Mechanism | Verdict | Grade |
|---|---|---|---|---|
| Gate | bottom-quintile 52w return, or >40% below the 52w high, or below the 40-week average for 26 of 52 weeks; sticky 52 weeks | "Was beaten down" | Design, see module docstring | R |
| Turned / exit | 13w return > 0 and not at a new 52-week low (a new low = sold) | "Has turned" | Design | R |
| Entry confirm (`no_buy`) | 26w still negative, above 10-week average, up-week volume > down-week volume (stocks) | Only blocks entry, so a recovering holding is not sold for recovering | Design | R |
| `rank_on` | `acceleration` (also `momentum`) | Rank survivors on 13w return minus the prior 13w, or on plain 13w return | Acceleration rejected: stock sleeve 1.9% CAGR, -44.9% MaxDD. 13w momentum on stocks: sleeve 11.4% / 0.43, correlation 0.22 with Broad; 80% Broad + 20% sleeve 29.3% / 1.05 / -18.2% vs Broad 31.7% / 1.06 / -20.4% vs 80% Broad + 20% liquid fund 29.1% / 1.04 / -18.7%. Beats the cash blend in 82 / 71 / 64% of windows (median +0.6), MaxDD better than Broad alone in every window, but costs about 4 points of CAGR. A slightly better cash substitute, not alpha. ETF version loses to plain cash | M, 3.9.23 |

## 11. Dry-run appendix (2026-10-01)

Reproduce from `packages/momentum-backtesting`:
`uv run python scripts/param_dry_run.py` (one parameter at a time; writes
`data/backtests/param_dry_run_{etf,broad}.csv` and `_rolling.csv`),
`uv run python scripts/alpha_experiments.py [--plateau]` (new levers),
`uv run python scripts/reversal_experiment.py --rank-on momentum` (reversal sleeve).

What the study supports, in order of strength:

1. Broad Momentum: simulate every week (`broad_every_week`). A correctness fix, not a lever.
2. Broad Momentum: trade every 2 weeks (or 4), or with a one-week signal delay: +4 to +5 CAGR
   points and better Sharpe in 89-100% of windows. All three cut the same thing, a 3.6-week
   average hold and 115 buys a year. Prefer the 2-tranche blend or every 4 weeks: one
   every-2-weeks phase alone ranges from +1.4 to +8.5 points by luck of the Fridays.
3. ETF: `exclude_high_vol=0.2`: +2.1 points, Sharpe 0.99 to 1.12, plateau-robust, sector-concentrated.
4. ETF `top_n=3` and Broad `picks_per_category=3` win most but concentrate or widen the bet.
5. Everything else is a dial (caps, vol targeting) or a loss, and `make_room` should not become
   the default.

One real Friday (2026-09-18, the live ETF strategy's latest week with a sale), printed by
`param_dry_run.py --friday-only`. Score = sum of the five window ranks (equal weights); the
hand-rebuilt score matched the engine's to 0.000000.

| Instrument | 1w % | 4w % | 13w % | 26w % | 52w % | Ranks 1/4/13/26/52 | Score | Rank | Held | This week |
|---|---|---|---|---|---|---|---|---|---|---|
| Nasdaq 100 | 2.3 | 1.5 | 0.5 | 24.6 | 31.7 | 2/1/9/1/3 | 16 | 1 | yes | ADD |
| Nifty Pharma | 0.7 | 1.3 | 9.2 | 18.5 | 17.7 | 5/2/1/6/6 | 20 | 2 | yes | HOLD (at 35% cap) |
| Nifty Metal | 0.4 | -0.9 | 0.2 | 14.4 | 30.7 | 6/4/10/7/4 | 31 | 3 | yes | ADD |
| Gold | 1.1 | -3.7 | 5.6 | 4.5 | 38.5 | 3/13/2/13/2 | 33 | 4 | no | BUY |
| Nifty Smallcap 250 | -0.3 | -0.7 | 3.2 | 23.6 | 4.5 | 13/3/6/2/10 | 34 | 5 | yes | ADD |
| Silver | 4.5 | -3.8 | 1.2 | 1.9 | 81.2 | 1/15/8/15/1 | 40 | 6 | no | |
| Nifty Midcap 150 | 0.2 | -2.2 | -0.3 | 13.2 | 4.6 | 7/6/11/8/9 | 41 | 7 | no | |
| Nifty Capital Markets | -0.8 | -1.8 | -4.2 | 20.0 | 21.6 | 18/5/17/5/5 | 50 | 8 | yes | HOLD (rank 8 <= 10) |
| Nifty Next 50 | -0.1 | -2.7 | -0.5 | 12.8 | 3.3 | 10/10/12/10/11 | 53 | 9 | no | |
| Hang Seng | 0.2 | -4.6 | 4.8 | 0.9 | 0.5 | 8/17/4/17/13 | 59 | 10 | no | |
| Nifty India Defence | -3.8 | -4.9 | -2.5 | 20.9 | 12.4 | 21/18/15/4/8 | 66 | 14 | yes | SELL: rank 14 > 10 |

The remaining ten instruments ranked 11 to 21 and were neither held nor bought. Defence (26.2%
of the portfolio) was sold; Pharma was already at 35.7%, inside the 35% cap plus its 5-point
band, so it was neither trimmed nor topped up; the proceeds went in four equal 6.4% slices to
Nasdaq 100, Metal, Gold (new) and Smallcap 250. Holdings after: Smallcap 21.0%, Metal 18.9%,
Pharma 36.2%, Nasdaq 15.2%, Gold 6.4%, Capital Markets 2.3%.
