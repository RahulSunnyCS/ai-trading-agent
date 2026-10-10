# Top momentum strategies, ranked on every factor (2026-10-08)

Source: the 8,003 Broad Momentum configs of search round 7 arm A, re-scored by BL-010 on the
point-in-time universe (`data/search/round7_A/scored_pit/`), every rebalance phase blended,
pre-tax, Rs 2 lakh, 2017-01-06 to 2026-10-02 (509 weeks). This is the honest universe; numbers
on "today's list" are inflated by about 22 points of CAGR and are not used here.

Script: the session scratchpad `rank.py` (reproducible from the scored curves and
`results-*.jsonl`; it uses `choose.py`'s own CAGR, Ulcer and FY-excess helpers).

## Name changes (2026-10-09)

The volatility-adjusted score (`voladj`) always uses 26- and 52-week returns, measured 4 weeks
back and divided by 26-week volatility; it ignores the selected lookbacks and weights. For a
voladj config those settings only matter through the stock tilt (lookbacks only), so five names
that described them were renamed after what actually differs:

| Old name | New name |
|---|---|
| Four Sectors, Four Lookbacks | Four Sectors Monthly, No Tilt |
| Six Sectors, Equal Weights | Six Sectors Monthly, No Tilt |
| Four Sectors, Short Lookbacks | Four Sectors, Half Tilt |
| Six Sectors, Fast Signals | Six Sectors, Make Room |
| Five Sectors, Recent Weights | Five Sectors, Wide Pool |
| Four-by-Three Monthly, Fast Signals | Four-by-Three Monthly, Full Tilt |
| Sleeve C: Six Pairs Monthly, Short Lookbacks | Sleeve C: Six Pairs Monthly, Half Tilt |

The saved runs carry the new names. Pre-registered files written before the change
(`search_spaces/bl084_criteria.json`) keep the old labels; the config ids are what count.
In the parameter tables below, the lookbacks and weights of a voladj config are shown as
searched but have no effect on its ranking. Whether voladj should follow them is BL-086.

## Naming scheme

Each name says how many sectors (categories) the config picks from, how many stocks it takes
per sector when more than one ("Pairs" = 2, "by-Three" = 3, "Trio" = 3 sectors x 3 stocks),
how often it trades (Weekly, Fortnightly, Monthly = every 4 weeks), and the one setting that
sets it apart. "Sleeve A-D" are the four frozen Phase 6 ensemble members.

| Name                                         | Id             | What makes it different                                                                                              |
| -------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------- |
| Trio Fortnightly                             | `953915b70ffe` | 3 sectors x 3 stocks, 13/26/52-week blend score, every 2 weeks; shallowest fall in the top 10                        |
| Five Sectors Monthly                         | `afbc88e00f32` | 1 stock from each of 5 sectors, 13/26-week vol-adjusted score, half stock tilt                                       |
| Four Sectors Monthly, No Tilt                 | `fbb7ab054238` | 4 sectors, lookbacks 4/13/26/52, no stock tilt                                                                       |
| Five Sectors, Stock Tilt                     | `5f86065cbf17` | 5 sectors, full stock tilt, 35% position cap                                                                         |
| Six Sectors Monthly, No Tilt                   | `64488b1d979d` | 6 sectors, lookbacks weighted equally, no tilt                                                                       |
| Four Sectors, Quick Exit                     | `754368b3d2e8` | sells a sector once it drops to rank 5 (the tightest exit in the list); the only one that beat the index in every FY |
| Four Sectors, Half Tilt                | `f5c09c711710` | lookbacks 4/13/26 only, equal weights                                                                                |
| Six Sectors, Make Room                    | `f35ff75965bb` | includes the 1-week lookback, enters whenever room is made                                                           |
| Five Sectors, Wide Pool                 | `43046da93329` | recent-weighted 13/26, full tilt                                                                                     |
| Five Sectors, Rank Sum                       | `9f9ef3aa6c1b` | rank-sum score instead of vol-adjusted                                                                               |
| Eight Sectors Monthly                        | `46f0c599eb37` | 8 sectors x 1 stock, 20% cap, every 4 weeks                                                                          |
| Eight Sectors Fortnightly                    | `1b6bba0378ad` | 8 sectors x 1, four lookbacks, every 2 weeks                                                                         |
| Trio Weekly                                  | `a76bd317ab61` | 3 x 3 rank-sum, trades every week                                                                                    |
| Four-by-Three Weekly                         | `31d057b0432e` | 4 sectors x 3 stocks, no position cap, weekly                                                                        |
| Four-by-Three Monthly, Big Positions         | `b796e477722c` | 50% position cap, pool of only 99 stocks                                                                             |
| Four-by-Three Monthly, Full Tilt          | `5356faa56490` | includes the 1-week lookback                                                                                         |
| Four Pairs Monthly                           | `e7e673217c90` | 4 sectors x 2, no cap                                                                                                |
| Six Pairs, Quick Exit                        | `29751d2c74b8` | 6 x 2, exit at rank 6, 20% cap                                                                                       |
| Eight Sectors, Small Pool                    | `d0e97285f3c4` | 8 x 1 from a 135-stock pool, no tilt                                                                                 |
| Sleeve A: Six Pairs Monthly                  | `1281e8ed6824` | 6 x 2, four lookbacks, no tilt; best-scoring sleeve                                                                  |
| Sleeve B: Eight Sectors Monthly, Blend       | `08c4307d7aa9` | 8 x 1, 13/26/52 blend score, full tilt                                                                               |
| Sleeve C: Six Pairs Monthly, Half Tilt | `535b17b44ba5` | 6 x 2, lookbacks 4/13/26, half tilt                                                                                  |
| Sleeve D: Six Pairs Fortnightly              | `bad83df3821a` | 6 x 2 every 2 weeks, 35% cap                                                                                         |
| Four Pairs Fortnightly (median companion)    | `277ec4e98ace` | the typical config tracked next to the ensemble                                                                      |
| Seven Sectors Fortnightly                    | `ce6723a197b9` | Phase 5 conservative pick: 7 x 1 blend, equal weights                                                                |
| Three Stocks Weekly                          | `981d611037eb` | Phase 5 medium pick: 3 sectors x 1, weekly                                                                           |
| Three Stocks Weekly, Aggressive              | `fc31a2912213` | Phase 5 aggressive pick: 3 x 1, 50% cap, enters whenever room is made                                                |

## How the ranking works

Only configs whose worst fall stays inside the 40% ceiling are eligible (4,131 of 8,003).
Each is ranked on six factors and the composite is the mean percentile:

| Factor                                              | Why                                                 |
| --------------------------------------------------- | --------------------------------------------------- |
| CAGR                                                | the objective                                       |
| Max drawdown                                        | the owner's hard ceiling and basket limits          |
| Martin ratio (CAGR / Ulcer index)                   | rewards shallow, short falls, not just one deep one |
| Sharpe (weekly, annualised)                         | return per unit of volatility                       |
| Third-worst FY excess over Nifty200 Momentum 30 TRI | BL-010's committed lower-bound measure              |
| Worst rolling 3-year CAGR                           | would a 3-year holder ever have lost money          |

Benchmarks over the same weeks: Nifty200 Momentum 30 TRI 17.0% CAGR, max DD -30%;
Midcap 150 TRI 17.5%; Smallcap 250 TRI 15.3%.

## Top 10 by composite score

| #   | Config                                           | CAGR  | Max DD | Ulcer | Martin | Sharpe | 3rd-worst FY vs Mom30 | Worst FY vs Mom30 | FYs beaten | Worst 3y | H1 / H2 CAGR | Holdings | Rebalance | Phase range |
| --- | ------------------------------------------------ | ----- | ------ | ----- | ------ | ------ | --------------------- | ----------------- | ---------- | -------- | ------------ | -------- | --------- | ----------- |
| 1   | **Trio Fortnightly** `953915b70ffe`              | 42.9% | -26.1% | 8.0%  | 5.37   | 1.46   | +19.3                 | -4.2              | 8/9        | +14.5%   | 53.6 / 32.9  | 9        | 2w        | 41.8-43.9%  |
| 2   | **Five Sectors Monthly** `afbc88e00f32`          | 41.1% | -26.7% | 9.5%  | 4.33   | 1.57   | +22.8                 | -9.6              | 8/9        | +9.7%    | 42.4 / 39.9  | 5        | 4w        | 34.6-44.8%  |
| 3   | **Four Sectors Monthly, No Tilt** `fbb7ab054238`  | 44.2% | -27.0% | 9.2%  | 4.81   | 1.60   | +11.6                 | -13.0             | 8/9        | +8.2%    | 40.3 / 48.3  | 4        | 4w        | 40.8-48.8%  |
| 4   | **Five Sectors, Stock Tilt** `5f86065cbf17`      | 41.3% | -27.1% | 9.2%  | 4.47   | 1.56   | +12.8                 | -12.4             | 8/9        | +6.6%    | 42.3 / 40.3  | 5        | 4w        | 35.1-44.5%  |
| 5   | **Six Sectors Monthly, No Tilt** `64488b1d979d`    | 38.6% | -26.9% | 8.6%  | 4.49   | 1.57   | +18.7                 | -11.6             | 8/9        | +6.4%    | 40.0 / 37.1  | 6        | 4w        | 32.2-43.7%  |
| 6   | **Four Sectors, Quick Exit** `754368b3d2e8`      | 39.8% | -25.6% | 8.5%  | 4.70   | 1.57   | +7.0                  | +1.5              | 9/9        | +9.8%    | 42.2 / 37.5  | 4        | 4w        | 35.0-43.4%  |
| 7   | **Four Sectors, Half Tilt** `f5c09c711710` | 40.2% | -27.6% | 9.4%  | 4.29   | 1.51   | +11.0                 | -9.8              | 8/9        | +7.6%    | 41.6 / 38.9  | 4        | 4w        | 37.3-42.4%  |
| 8   | **Six Sectors, Make Room** `f35ff75965bb`     | 38.6% | -27.1% | 9.4%  | 4.10   | 1.54   | +15.0                 | -10.1             | 8/9        | +6.4%    | 40.5 / 36.7  | 6        | 4w        | 32.6-43.1%  |
| 9   | **Five Sectors, Wide Pool** `43046da93329`  | 37.6% | -27.1% | 9.5%  | 3.95   | 1.47   | +15.7                 | -12.0             | 8/9        | +4.8%    | 41.2 / 34.1  | 5        | 4w        | 30.9-42.7%  |
| 10  | **Five Sectors, Rank Sum** `9f9ef3aa6c1b`        | 40.6% | -28.2% | 9.2%  | 4.40   | 1.39   | +8.2                  | -9.3              | 8/9        | +5.7%    | 44.6 / 36.7  | 5        | 4w        | 36.8-46.1%  |

"Phase range" is the CAGR on the worst and best rebalance Friday; the headline is the blend.
H1 / H2 is the CAGR on the first and second half of the history.

### What the top 10 have in common

- **Rebalance every 4 weeks** (9 of 10), not weekly. Weekly configs top the raw-CAGR list but
  have deeper falls and worse bad years.
- **Lookbacks 13 and 26 weeks**, sometimes with 52; the 1-week lookback appears once.
- **Volatility-adjusted score** (`voladj`) in 8 of 10.
- **1 pick per category across 4-6 categories**, so 4-6 holdings, with a 25-35% position cap.
- **"wait" entry** (hold cash until a slot opens cleanly) in 7 of 10.
- Full parameters are printed by the script and in `results-*.jsonl` under each id.

### Parameters of the top 10

| Config                                           | Lookbacks  | Score   | Weights | Pool | Categories x picks | Exit rank cat / pool | Max pos | Entry     | Tilt | Every | Coverage floor |
| ------------------------------------------------ | ---------- | ------- | ------- | ---- | ------------------ | -------------------- | ------- | --------- | ---- | ----- | -------------- |
| **Trio Fortnightly** `953915b70ffe`              | 13,26,52   | blend   | long    | 332  | 3 x 3              | 6 / 494              | 0.35    | wait      | 0.5  | 2     | 0.072          |
| **Five Sectors Monthly** `afbc88e00f32`          | 13,26      | voladj  | long    | 241  | 5 x 1              | 11 / 364             | 0.25    | wait      | 0.5  | 4     | 0.018          |
| **Four Sectors Monthly, No Tilt** `fbb7ab054238`  | 4,13,26,52 | voladj  | long    | 193  | 4 x 1              | 11 / 364             | 0.25    | wait      | 0    | 4     | 0.031          |
| **Five Sectors, Stock Tilt** `5f86065cbf17`      | 13,26,52   | voladj  | recent  | 211  | 5 x 1              | 9 / 361              | 0.35    | wait      | 1.0  | 4     | 0.056          |
| **Six Sectors Monthly, No Tilt** `64488b1d979d`    | 4,13,26,52 | voladj  | equal   | 304  | 6 x 1              | 11 / 364             | 0.25    | wait      | 0    | 4     | 0.044          |
| **Four Sectors, Quick Exit** `754368b3d2e8`      | 13,26      | voladj  | recent  | 333  | 4 x 1              | 5 / 470              | 0.25    | make_room | 1.0  | 4     | 0.131          |
| **Four Sectors, Half Tilt** `f5c09c711710` | 4,13,26    | voladj  | equal   | 199  | 4 x 1              | 9 / 365              | 0.25    | wait      | 0.5  | 4     | 0.063          |
| **Six Sectors, Make Room** `f35ff75965bb`     | 1,4,13,26  | voladj  | long    | 290  | 6 x 1              | 7 / 389              | 0.35    | make_room | 1.0  | 4     | 0.093          |
| **Five Sectors, Wide Pool** `43046da93329`  | 13,26      | voladj  | recent  | 306  | 5 x 1              | 9 / 462              | 0.35    | wait      | 1.0  | 4     | 0.081          |
| **Five Sectors, Rank Sum** `9f9ef3aa6c1b`        | 13,26      | ranksum | equal   | 289  | 5 x 1              | 10 / 469             | 0.35    | wait      | 1.0  | 4     | 0.108          |

## Top 10 with 8-12 holdings (the owner's preferred size)

| #   | Config                                                  | CAGR  | Max DD | Ulcer | Martin | Sharpe | 3rd-worst FY | Worst FY | Worst 3y | Holdings | Rebalance |
| --- | ------------------------------------------------------- | ----- | ------ | ----- | ------ | ------ | ------------ | -------- | -------- | -------- | --------- |
| 1   | **Trio Fortnightly** `953915b70ffe`                     | 42.9% | -26.1% | 8.0%  | 5.37   | 1.46   | +19.3        | -4.2     | +14.5%   | 9        | 2w        |
| 2   | **Eight Sectors Monthly** `46f0c599eb37`                | 38.3% | -30.6% | 9.9%  | 3.87   | 1.57   | +11.0        | -14.5    | +3.2%    | 8        | 4w        |
| 3   | **Eight Sectors Fortnightly** `1b6bba0378ad`            | 36.7% | -29.8% | 10.2% | 3.61   | 1.51   | +13.5        | -14.0    | +3.2%    | 8        | 2w        |
| 4   | **Trio Weekly** `a76bd317ab61`                          | 45.8% | -33.4% | 13.1% | 3.51   | 1.50   | +12.9        | -13.0    | +7.5%    | 9        | 1w        |
| 5   | **Four-by-Three Weekly** `31d057b0432e`                 | 43.3% | -30.7% | 11.6% | 3.73   | 1.47   | +4.9         | -19.2    | +2.6%    | 12       | 1w        |
| 6   | **Four-by-Three Monthly, Big Positions** `b796e477722c` | 34.9% | -27.4% | 8.7%  | 3.99   | 1.34   | +3.7         | -6.5     | +4.6%    | 12       | 4w        |
| 7   | **Four-by-Three Monthly, Full Tilt** `5356faa56490`  | 35.0% | -28.7% | 9.8%  | 3.56   | 1.34   | +8.4         | -5.4     | +3.0%    | 12       | 4w        |
| 8   | **Four Pairs Monthly** `e7e673217c90`                   | 37.0% | -26.5% | 10.0% | 3.71   | 1.44   | -0.5         | -14.4    | +5.2%    | 8        | 4w        |
| 9   | **Six Pairs, Quick Exit** `29751d2c74b8`                | 34.7% | -29.4% | 8.1%  | 4.26   | 1.37   | +2.7         | -5.9     | +6.9%    | 12       | 4w        |
| 10  | **Eight Sectors, Small Pool** `d0e97285f3c4`            | 35.4% | -26.9% | 10.0% | 3.56   | 1.44   | +0.9         | -11.0    | +3.8%    | 8        | 4w        |

## Where the strategies already chosen sit

Composite percentile among the 4,131 eligible configs:

| Strategy                                                                                         | CAGR  | Max DD | Martin      | 3rd-worst FY | Percentile                      |
| ------------------------------------------------------------------------------------------------ | ----- | ------ | ----------- | ------------ | ------------------------------- |
| Phase 6 ensemble sleeve **Sleeve A: Six Pairs Monthly** `1281e8ed6824` (12, 4w)                  | 34.2% | -31.3% | 3.45        | +10.6        | 97.5%                           |
| Phase 6 ensemble sleeve **Sleeve D: Six Pairs Fortnightly** `bad83df3821a` (12, 2w)              | 28.4% | -28.5% | 2.37        | +2.7         | 71.7%                           |
| Phase 6 ensemble sleeve **Sleeve B: Eight Sectors Monthly, Blend** `08c4307d7aa9` (8, 4w)        | 32.9% | -38.3% | 2.76        | 0.0          | 68.2%                           |
| Phase 6 ensemble sleeve **Sleeve C: Six Pairs Monthly, Half Tilt** `535b17b44ba5` (12, 4w) | 31.6% | -35.2% | 2.50        | +0.6         | 54.8%                           |
| Phase 6 ensemble, equal capital reset each April                                                 | 32.3% | -31.5% | Ulcer 10.4% |              |                                 |
| Median companion **Four Pairs Fortnightly (median companion)** `277ec4e98ace`                    | 31.0% | -38.4% | 2.51        | -4.3         | 33.2%                           |
| Phase 5 conservative pick **Seven Sectors Fortnightly** `ce6723a197b9` (7, 2w)                   | 44.8% | -32.3% | 4.70        | +12.5        | 99.2%                           |
| Phase 5 medium pick **Three Stocks Weekly** `981d611037eb` (3, 1w)                               | 39.6% | -36.6% | 3.47        | +21.0        | 94.6%                           |
| Phase 5 aggressive pick **Three Stocks Weekly, Aggressive** `fc31a2912213` (3, 1w)               | 45.7% | -39.3% | 3.39        | +13.0        | 84.7%                           |
| Saved favourite "Run 165" (Broad, today's list, delay 0, flat cost)                              | 41.3% | -29.3% |             |              | not comparable: biased universe |

Typical config for scale: median eligible config 29.9% CAGR, -35% max DD, Martin 2.5,
Sharpe 1.18, third-worst FY -2.5 points below the index.

## ETF rotation (the original index/ETF strategy, `data/backtests/compare.xlsx`)

| Mode                     | CAGR  | Max DD | Sharpe vs cash | Volatility |
| ------------------------ | ----- | ------ | -------------- | ---------- |
| off (plain top-5 of 10)  | 20.9% | -36.2% | 0.85           | 17.0%      |
| ranked                   | 20.5% | -26.3% | 0.87           | 16.2%      |
| filter                   | 22.7% | -29.4% | 0.96           | 16.5%      |
| Nifty 50 price benchmark | 11.2% | -34.6% |                |            |

Lower return than Broad, but no stock picking, no universe bias and no circuit risk.

## What this ranking can and cannot tell you

1. **These are in-sample winners.** BL-010 Phase 4 measured the probability of backtest
   overfitting on this exact universe at 0.69 (0.53 inside the 40% ceiling), and Phase 5's
   walk-forward showed that picking the best config on the past did not beat picking a typical
   one. The top 10 above should be read as "the configs that happened to do best", not as
   "the configs that will do best". The gap between number 1 (42.9%) and the median (29.9%)
   is mostly selection.
2. **Everything is pre-tax and before Monday-open fills.** Phase 2 measured tax at 6-12 points
   and the Monday fill at about 1 point. Subtract 8-13 points for a realistic after-tax figure.
3. **The category tags still carry hindsight** (today's 113 themes applied to every year).
   The fair check with the exchange's own industry classification is parked in Phase 7.
4. **The hold-out failed.** On 2012-2016, years nothing was tuned on, the frozen ensemble
   returned 20.1% a year against 21.1% for the Nifty200 Momentum 30 index. The in-sample
   edge of about 15 points did not show up out of sample.
5. **What does survive:** the family beats the momentum index in-sample across almost the
   whole space (82% of configs beat it by 5 points), 4-week rebalancing and 8-12 holdings give
   the same return with much shallower falls, and the ensemble's walk-forward passed its own
   rule (36.7% against the group median 32.6%).

## Recommendation

- Keep the frozen Phase 6 ensemble as the thing being paper-tracked. It was picked by a rule
  that passed walk-forward, which none of the top-10 above were.
- If a second basket is wanted for tracking, **Trio Fortnightly** `953915b70ffe` is the only config that is top-10
  on every factor at once, with 9 holdings and the shallowest fall in the top 10. Track it on
  paper, do not fund it on this evidence..env
- Do not fund any single config from the top-10 list on in-sample rank alone; the PBO and
  walk-forward results say that rank is close to noise.
- Treat "Run 165" as unvalidated: it runs on today's stock list with no signal delay, the
  setup Phase 3 killed as a headline.
