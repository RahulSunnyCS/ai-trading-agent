# Momentum lab: parameter reference

Purpose: a durable record of every parameter the momentum lab uses, its shipped default and where
that default lives, what it does mechanically, why it is set that way, and the evidence.
Companion: `docs/momentum-parameters-plain-english.md`.

Evidence grades: **M** = measured in a logged real-data backtest (cited to `TODO.md` row);
**R** = reasoned from the code, not isolated by a backtest; **D** = pending local dry run
(handover Step 3). No figure here is newly computed. Every number is copied from the repo's own
logs or code. Where a default lives: `Config` = `engine.py`; `API` = `BacktestRequest` in
`api.py`; `Broad` = `categories/broad.py`; `Live` = `live_config.toml`.

## 1. Universe and data

| Parameter | Default (source) | Mechanism | Rationale and benefit | Grade |
|---|---|---|---|---|
| `start` | 2017-01-01 (Config, API, Live) | First week of the backtest. History is fetched from 2016-01-01 so 52-week returns exist from Jan 2017 | Gives a full 52-week look-back before the first trade | R |
| `end` | None = latest (Config) | Last week of the backtest | Used to define evaluation windows | R |
| `universe` / `include_optional` | every `core` row, optional off (Config) | Which instruments are ranked. Core is 21 rows in `universe.csv` (4 broad, 13 sector/thematic, gold, silver, Nasdaq 100, Hang Seng) | Optional rows have ETF turnover below about 2 crore a day or overlap heavily with a core row | R |
| `benchmark` | `Nifty 50` (Config, API) | Column used as the comparison line | Price-return series, so like-for-like only when P&L is also index price-return. Plan adds TRI benchmarks | R |
| Weekly close | last trading day of each Mon-Fri week, labelled Friday | Turns daily data into the signal frequency | One decision per week | R |

## 2. Ranking

| Parameter | Default (source) | Mechanism | Rationale and benefit | Grade |
|---|---|---|---|---|
| `lookbacks` | (1, 4, 13, 26, 52) weeks (Config, API, Live) | Return over each window, ranked across eligible instruments | Approximates 1w, 1m, 3m, 6m, 12m. Eligibility requires history for the longest window | R |
| `weights` | None = equal (Config) | Score = sum of weight x rank; lowest wins. Negative weight rewards worst-ranked on that window. All-zero rejected | Equal weights avoid tuned hyperparameters. The 1w window may add reversal noise. Test `test_negative_weight_rewards_the_worst_performer_on_that_lookback` | R, D |
| Tie-break | middle lookback's return, then name (engine) | Makes runs reproducible | Deterministic ranks independent of column order | R |
| `score` | `ranksum` (Config, API) | `voladj`: 6m and 12m return divided by 26-week vol, z-scored and summed. `blend`: average of both ranks | `blend` looked strong in recent windows but carries the cold-start fork caveat (not claimed proven) | M (inconclusive), 3.9.18 |
| `voladj_skip_recent_month` | True | voladj returns measured 4 weeks ago | Standard 12-1 convention: avoids short-term reversal | R |

## 3. Selection and exit (hysteresis)

| Parameter | Default (source) | Mechanism | Rationale and benefit | Grade |
|---|---|---|---|---|
| `top_n` | 5 (Config, API, Live). Custom Index 8 (3.9.8) | Names eligible for fresh money | Custom Index: 5 to 8 cut max drawdown -34.42% to -30.80% while CAGR rose 19.77% to 24.60%; 5y drawdown -25.82% to -19.27% | M, 3.9.8 |
| `exit_rank` | 10 (Config, API, Live). Custom Index 16 | Sell only when rank is worse than this | Buffer band reduces churn, costs and tax. Must be >= `top_n` (validated) | R |
| Zero-cost check | n/a | Re-ran with `cost_pct=0` | Drawdown improved only 0.5 to 2 points, so whipsaw is not the main driver and an exit debounce was not built | M, 3.9.8 |

## 4. Portfolio rule and position sizing

| Parameter | Default (source) | Mechanism | Rationale and benefit | Grade |
|---|---|---|---|---|
| `portfolio` | `buffer` (Config) | Hold until rank fails; proceeds split equally over current top N, topping up holdings. `slots` = N equal pots, no top-ups | Buffer compounds winners. Slots tested as a lever and not adopted | M, 3.9.18 |
| `entry` | `wait` (Config). `make_room` available | `make_room` trims all holdings equally to buy a new top-N name at once | Broad: make_room >= wait on CAGR, MaxDD, Sharpe in all three windows (full 47.17% / -22.49% / 1.78 vs 47.04% / -22.49% / 1.73). Recommended default flip | M, 3.9.18 |
| `max_position` | 0.35 (Config, API, Live). Broad UI 0.15 | No holding bought or topped up past it | Without a cap one ETF reached 84%. At 0.35 the max stays at or under 40% for about 1.3 points less CAGR and slightly better Sharpe. Broad sweep: a monotonic risk/return dial (0.25 lower return, better Sharpe and MaxDD; 0.50 the reverse) | M, README, 3.9.18 |
| `cap_band` | 0.05 | Trim back to cap only once over cap + band | Avoids a trade and tax event on small drifts | R |
| `max_group` (UI "max category") | None in Config; Broad UI 0.30 | Cap on all stocks held through one category | Two stocks from one sector should not exceed one category's intended bet. Default is unswept | R, D (3.9.22 says unswept) |
| `max_stock_price` | Broad UI 20,000 rupees; 0 = off | Entry-only block via `no_buy` | A small budget cannot afford one share of e.g. MRF. Never forces a sale | R |
| `MIN_TRADE` | 0.5% of portfolio (engine constant) | Parked cash not moved for less | Avoids dust trades | R |
| `commodity_copies`, `debt_copies` | 1 (API) | Duplicate ranked slots for gold/silver or cash/gilt in Custom Index | Default 1 = ordinary single-instrument behaviour | R |

## 5. Risk overlays (all opt-in, off by default)

| Parameter | Default | Mechanism | Verdict | Grade |
|---|---|---|---|---|
| `defensive` | `off` (modes `ranked`, `filter`) | `ranked`: cash and gilt compete in the ranking. `filter`: hold only names whose `filter_lookback` (13w) return beats cash | No meaningful help; worse on the 5-year window in Custom Index | M, 3.9.8, 3.9.18 |
| `momentum_sizing` (+ `_window` 10, `_floor` 0.0) | False | Scale fresh buys by weighted recent win rate of closed trades | Gives up about 4 to 5 points of CAGR with flat-to-worse Sharpe. Rejected | M, 3.9.8, 3.9.18 |
| `mass_exit_throttle` (+ `_fraction` 0.5; threshold 0.5) | False | Withhold a fraction of fresh capital when more than 50% of held categories exit in one week | No repeatable edge. Rejected | M, 3.9.20 |
| `mass_exit_response` | `off` (`throttle`, `halve_top_n`) | Broad Momentum response variants | Same verdict | M, 3.9.20 |

## 6. Costs and tax

| Parameter | Default | Mechanism | Rationale | Grade |
|---|---|---|---|---|
| `cost_pct` | 0.10 percent per side (Config, API, Live) | Flat cost on each buy and each sell | Simple stand-in for all frictions | R |
| `cost_model` | `flat`. `itemised` available | STT 0.1% each side, stamp duty 0.015% buy, exchange fees about 0.004% each side, slippage `slippage_bps` 5, DP charge 16 rupees per sell scaled by `capital` (1,000,000) and capped at 5% | Itemised cost about 1.0 to 1.3 points of CAGR in every window; edge survives | M, 3.9.18 |
| `tax` / `TaxRules` | off; slab 0.30, cess 0.04, equity STCG 0.20, LTCG 0.125, long-term after 365 days | Per-lot tax on each sale, loss set-off, carry-forward | Rates are settings, not facts. Gold, silver, international are assumed. Not modelled: 1.25 lakh LTCG exemption, surcharge, 8-year limit | R (see `tax.py` docstring) |

## 7. Execution

| Parameter | Default | Mechanism | Rationale | Grade |
|---|---|---|---|---|
| `signal_delay` | 0 weeks (API range 0 to 4) | Trade N weeks after the signal | 0 is slightly optimistic, 1 is the pessimistic check | M (lever swept), 3.9.18 |
| `execution` | `fri_close` (`mon_open`, `mon_10am`) | Fill time | The live job's 14:40 preview targets the Friday close | R |
| `track` | `index` in Config/API; `etf` in `Live` | P&L on the index or the traded ETF | ETF gap measured at +0.72 CAGR points a year, above the 0.5 threshold, so the live job tracks the ETF | M, README, Live comment |
| `rebalance` | `weekly` (`monthly`) | Monthly trades only on the last week of each month | Changes the equity path materially. No every-K-weeks option yet | M, 3.9.18; plan Step 0b |
| `premium_warn_pct` | 1.0 (2.0 international) | Live job flags a buy whose ETF trades above NAV | Premium drag is a steady cost for momentum buying | R |

## 8. Broad Momentum funnel (`category_mode="on"`)

| Parameter | Default | Mechanism | Rationale and evidence | Grade |
|---|---|---|---|---|
| `pool_top_n` | 200 | Stocks qualifying from about 755 (Nifty Total Market, point-in-time membership) | Refreshed quarterly | R, swept 3.9.18 |
| `pool_exit_rank` | 250 | Pool hysteresis exit | 250 beat the original 300 guess on CAGR, Sharpe, drawdown and turnover | M, 3.9.13 |
| `coverage_floor` | 0.40 | Minimum share of a category's members in the pool | Stops one stock carrying a category. 0.25 gave better Sharpe and MaxDD in all three windows (full Sharpe 1.97 vs 1.73, MaxDD -17.92% vs -22.49%) but is unverified for the fork caveat. 0.60 starves the strategy | M (candidate), 3.9.18 |
| `category_top_n` / `category_exit_rank` | 4 / 8 | Category-level hysteresis | 6 and 12 tested marginally better in isolation; kept to avoid overfitting one run | M, 3.9.13 |
| `picks_per_category` | 2 | Top stocks per held category, by pool rank | Diversifies within a sector; an atomic (gold etc.) counts as 1 | R |
| `off_top_n` / `off_exit_rank` (category mode off) | 10 / 20 | Direct stock ranking from the pool | Independent of the category numbers | R |

Cold-start caveat (3.9.18): levers that change selection fork the portfolio before `start`, so
their full-window MaxDD compares unrelated portfolios. Prefer rolling windows and tranches.

## 9. Custom Index tab

| Parameter | Default | Mechanism | Grade |
|---|---|---|---|
| `inner_top_n` / `inner_exit_rank` | 2 / 8 (`compose.py`) | Stock rotation inside each held category | R |
| Outer `top_n` / `exit_rank` | 8 / 16 | Category-vs-category rotation across 62 to 68 categories | M, 3.9.8 |

## 10. Proposed parameters (not built; see handover)

| Proposed | Purpose | Expected benefit (hypothesis) | Grade |
|---|---|---|---|
| `rebalance_every`, `rebalance_offset` | Fortnightly and staggered tranches | Removes start-date luck; enables the owner's 2-week cadence | D |
| Skip-month / 1w weight | Drop short-term reversal | Lower turnover, better Sharpe | D |
| `vol_target` | Scale exposure by trailing strategy vol | Shallower momentum-crash drawdowns | D |
| `high52_min` / `score="high52"` | 52-week-high proximity | Continuation with less turnover | D |
| Breadth gate | Mask fresh buys in weak markets | Less time in drawdown | D |
| Tax-aware exit | Wait for a lot to cross 365 days on marginal rank | Higher after-tax CAGR | D |
| Reversal sleeve (gate, confirm, rank) | Diversifying turnaround sleeve | Better blended Sharpe and drawdown | D |

## 11. Dry-run appendix (to be filled by the local session)

Paste the script's output table and one fully walked Friday here. Update the grade column from
D to M with the TODO row that holds the numbers.
