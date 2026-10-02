# Volume and turnover as a ranking aid: validation plan

Owner's idea, 2026-10-02. Does rising turnover (more shares changing hands over the last couple
of weeks) help pick better momentum stocks? A local session runs this on real data and reports.
The owner decides what to build. Nothing here is a result yet.

Scope: Broad Momentum only. Indices have no volume, ETF volume mostly reflects flows into the
ETF itself, and the Nifty 50 stock tab hardly trades and loses money (TODO 3.9.26).

## Hypotheses (fixed before any data is looked at)

| ID | Hypothesis | Why it might hold | Why it might not |
|---|---|---|---|
| H1 | A recent surge in shares traded predicts better returns over the next 1 to 13 weeks, beyond momentum rank and the recent price move | Attention: unusually high recent volume has been followed by small outperformance in published research | The 1-week and 4-week returns already in the score may capture it |
| H2 | Volume separates blow-off spikes from clean spikes. A 2-week spike on climax volume with a weak close is worth trimming; a clean one is not | The trim test (3.9.26) found spikes continue on average, carried by a fat right tail. Volume may identify the minority that reverse | Too few events per subgroup to tell |
| H3 | A liquidity floor removes names whose backtest prices could not really be traded | Thin names have stale closes and wide spreads | Not an alpha question. It measures how much CAGR is real |
| H4 | Accumulation (more volume on up days than down days) predicts continuation | Traders' accumulation idea | Weak academic support |
| H5 | Life cycle: winners with surging volume reverse sooner over 26 to 52 weeks | Published "momentum life cycle" research | Check, do not assume |

## Validation protocol (the standard the last two tests followed)

1. **Cheapest test first.** Measure before simulating, and simulate before touching the engine.
   No `engine.py` changes in this plan.
2. **Pre-registered features and thresholds.** Only the list below. Report every cell, not the
   best ones.
3. **Control for what we already know.** Volume moves with momentum and with the recent price
   jump. Every test compares stocks with similar momentum rank and similar 2-week return.
4. **Uncertainty over weeks, not stocks.** Average within a week first, then a 4-week block
   bootstrap with 2,000 resamples. Report distinct weeks and distinct stocks.
5. **Stability.** Both halves (2017 to 2021, 2022 onward) must agree in sign. Rolling 3-year
   windows stepped by a quarter for anything simulated.
6. **Base rates.** Compare every conditional result with the same statistic for all eligible
   stock-weeks.
7. **Costs and tax.** Anything that changes trading reports results gross and after a
   conservative short-term tax charge (20.8% of realised gains).
8. **Multiple testing.** 5 features x 3 horizons x 2 universes is 30 tests, so at 95% one or two
   pass by chance. A feature passes only at both 4 and 13 weeks and in both halves.
9. **Checkpoints.** Stop and show the owner after V0 and after V1.

## Data construction (no lookahead)

- **Source:** daily rows from `categories/prices.py::load_daily_prices` (date, symbol, close,
  turnover). Turnover is rupees traded. The stored daily `volume` column (shares) is in
  `daily.parquet` and may be in the catalog's `bars_1d_stock`; use it if present, otherwise
  shares = turnover / close.
- **Splits:** shares traded jump at a split. Compute every ratio within a price segment (the
  `symbol#N` columns from `build_stock_weekly_prices`, boundaries from its `events` table).
  A new segment has no ratio until it has 26 weeks of its own history.
- **Medians, not sums.** Block deals, index rebalancing days, results days and F&O expiry
  produce single-day turnover spikes with no directional meaning.
- **Weekly alignment:** every feature at Friday `t` uses sessions up to and including `t`, on the
  same weekly calendar as the Broad price frame.

## Features (the complete list)

| Name | Definition | For |
|---|---|---|
| VR2 | Median daily shares over the last 10 sessions / median over the prior 130 sessions (26 weeks) | H1 |
| VR4 | Same with the last 20 sessions | H1 |
| RISE2 | Weekly median shares up in each of the last 2 weeks (true/false) | H1, owner's literal idea |
| ACC13 | Shares traded on up-close days / shares on down-close days, last 65 sessions | H4 |
| LIQ13 | Median daily turnover in rupees, last 65 sessions | H3 |
| CLV2 | Where the 2-week close sits in its 2-week range: (close - low) / (high - low). Needs daily high and low from `daily.parquet` or the catalog | H2 |

## Tests

### V0. Data checks (checkpoint)

- Coverage: share of eligible stock-weeks with each feature, by year.
- If both are available, agreement between stored volume and turnover / close.
- The 20 largest single-day turnover jumps, with dates. Expect index rebalancing and block deals.
  Confirm the medians blunt them.
- Rank correlation of each feature with momentum rank, 2-week return and 4-week return. A
  correlation above 0.7 means the feature mostly re-measures momentum.

### V1. Spike split (H2, cheapest; checkpoint)

Reuse the event table from `scripts/overextension_trim_tests.py` (`build_broad`,
`event_table`, `cell_excess`, `weekly_mean_ci`) for C3, C4 and C5, all triggers. Split events by:

- spike volume: VR2 at the event week, terciles;
- close strength: CLV2 below 0.5 vs at least 0.5;
- climax: top VR2 tercile and CLV2 below 0.5, against all other events.

Report trim excess (alternative B, the rest of the portfolio) at 4 and 8 weeks per subgroup,
with intervals, event weeks and the right-tail check (sign survives removing the best 5 and
worst 5).

Pass: a subgroup with positive excess, an interval excluding zero, at least 10 event weeks,
same sign in both halves, in C3 and at least one of C4 or C5.

### V2. Predictive test (H1, H4, H5)

Universe each week: Broad's qualifying pool (top 200 by momentum, with the same membership gate
the engine uses, which is not yet point-in-time). Repeat within held names only.

1. Within each week, remove the part of each feature explained by momentum rank and 2-week
   return: rank-regress the feature on those two and keep the residual.
2. Weekly rank correlation (IC) between the residual and forward returns at 1, 4 and 13 weeks.
   Report mean IC, block-bootstrap interval, share of positive weeks.
3. Top-third minus bottom-third forward return spread on the residual.
4. H5: the same at 26 and 52 weeks. A negative long-horizon IC after a positive short one is the
   life-cycle reversal.
5. Both halves separately.

Pass for a feature: interval excludes zero at both 4 and 13 weeks, same sign in both halves,
and the spread in the same direction.

### V3. Liquidity floor (H3)

Rerun C3 and C4 with a `no_buy` mask where LIQ13 is below 1, 5 or 10 crore. The mask blocks new
buys only and never forces a sale. Report CAGR, Sharpe, max drawdown and trades per year
against the unfloored run. Also report the share of the unfloored run's profit that came from
names below each floor.

This is judged on honesty, not edge. If most of the CAGR comes from names below 5 crore a day,
the headline CAGR overstates what can be traded.

### V4. Ranking variants (only for features that pass V2)

No engine change:

- Gate (C3 and C4): `no_buy` for fresh buys in the feature's bad third.
- Tie-break (C4, category mode off, whose stock ranks pass straight through `external_ranks`):
  among names within 3 rank places, reorder by the feature.
- Score term (C4 only): add the feature's rank at weight 0.5 to the momentum score, via
  `external_ranks`.

Evaluate on full, last 5 years, last 3 years and rolling 3-year windows. Report CAGR, Sharpe,
max drawdown, turnover, and tax-adjusted CAGR.

Pass: Sharpe at least the base in two-thirds of rolling windows, CAGR cost at most 1 point a
year, and better than the base in both halves.

## Known caveats

- **Survivorship bias favours "rising volume is good".** Broad's universe is today's 755 names
  applied backwards (TODO 3.9.25). Stocks that grew into it had rising volume on the way up;
  the ones that faded are missing. A positive H1 or H4 result is provisional until membership is
  point-in-time.
- **Skipped weeks.** Shipped Broad skips 38% of weeks (3.9.25). Use the `weekly_marks` fill from
  `breadth_regime_tests.py`, and exclude events that land on skipped weeks from V1, as in 3.9.26.
- **No delivery data.** NSE's delivery percentage, the "real buying" measure, is not stored.
  Fetching it is a possible later data addition, not part of this plan.

## Deliverables

1. `packages/momentum-backtesting/scripts/volume_turnover_tests.py`, stages `v0` to `v4`,
   runnable with `uv run`. Reuse helpers from the breadth and trim scripts by import. Do not
   copy them.
2. Unit tests on a small hand-built frame for:
   - segment-aware share volume;
   - the median ratios;
   - CLV2;
   - the residual step;
   - IC arithmetic.
3. CSVs in `data/backtests/volume/` (gitignored).
4. A Results section appended to this file, with a plain-English answer for each of H1 to H5.
5. TODO.md row 3.9.27 updated in the same commit. If anything passes, add its parameters to
   `docs/momentum-parameters-reference.md` (grade M) and the plain-English guide.

## Results

(Empty until the local run.)
