# Volume, trend stage and moving averages as ranking aids: validation plan

Owner's ideas, 2026-10-02. Do rising turnover (more shares changing hands over the last couple
of weeks), a stock's trend stage (Weinstein stages 1 to 4), or being above its 50-day average
help pick better momentum stocks? Each is tested on its own first, in one shared harness. A local session runs this on real data and reports.
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
| H6 | A stock above its 50-day average does better than an equally ranked stock below it | Common trend-following practice | Top momentum stocks are almost always above it already. Distance from the average largely repeats the 4-week return. A short pullback below it may be a good entry, so even the sign is unknown |
| H7 | Excluding Stage 3 (topping) names from fresh buys, and preferring early Stage 2, improves results | A high 26 or 52-week rank can hide a stock that is rolling over. Life-cycle research favours early-stage winners | Stage 4 names are already sold by the exit rank. Stage 3 may be rare among top-ranked names |
| H8 | One planned combination: early Stage 2 with VR4 in the top third ("breakout on volume") | Weinstein's own entry rule | Tested only if H1 and H7 each pass on their own |

Not tested here: extra points for Stage 1 (basing) names. That is the turnaround idea and belongs
in the separate reversal sleeve (`docs/handover-momentum-alpha.md`, Step 2), not in the momentum
score.

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
8. **Multiple testing.** 8 predictive features x 3 horizons x 2 universes is 48 tests, so at 95%
   two or three pass by chance. A feature passes only at both 4 and 13 weeks and in both halves.
9. **Checkpoints.** Stop and show the owner after V0 and after V1. V0 includes a redundancy
   count that decides whether H6 and H7 are worth testing further.

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
| ABOVE10 | Weekly close above its 10-week simple average (true/false). Stands in for the 50-day average | H6 |
| DIST10 | Weekly close / 10-week simple average - 1 | H6 |
| STAGE | Stage 1 to 4 from the 30-week average, rules below | H7 |
| EARLY2 | In Stage 2 and entered it within the last 13 weeks (true/false) | H7, H8 |

The moving-average features come from the Broad weekly price frame itself, per segment. They need
no extra data. A segment has no value until it has 34 weeks of its own history.

### Stage rules (fixed before the run)

- `slope = MA30[t] / MA30[t-4] - 1`. Rising if above +1%, falling if below -1%, flat otherwise.
- Stage 2: close above MA30 and MA30 rising.
- Stage 4: close below MA30 and MA30 falling.
- Anything else (a flat average, or price on the wrong side of a sloping one): Stage 3 if the
  most recent Stage 2 or 4 was Stage 2, Stage 1 if it was Stage 4, unknown if neither yet.
- A new stage is recorded only after it holds for 2 consecutive weeks, so one noisy week does
  not flip it.
- Keep a weeks-in-stage counter for EARLY2.
- V0 also shows stage shares with a 0.5% and a 2% slope band, for information only. V2 to V5
  use the 1% band.

## Tests

### V0. Data checks (checkpoint)

- Coverage: share of eligible stock-weeks with each feature, by year.
- If both are available, agreement between stored volume and turnover / close.
- The 20 largest single-day turnover jumps, with dates. Expect index rebalancing and block deals.
  Confirm the medians blunt them.
- Rank correlation of each feature with momentum rank, 2-week return and 4-week return. A
  correlation above 0.7 means the feature mostly re-measures momentum.
- **Redundancy count (decides H6 and H7).** From the C3 and C4 trade logs, the share of fresh
  BUY rows that were below their 10-week average at purchase, and the share in each stage at
  purchase. Repeat for all names in the weekly top N. If under 5% of fresh buys are below the
  10-week average, H6 cannot change results much. If under 5% are in Stage 3, the same for H7.
  Report this and recommend whether to continue. The owner decides at the checkpoint.
- Stage sanity: print the weekly stage timeline for IRFC, RVNL, IFCI, HINDCOPPER and GPIL
  across their big runs (named in the trim test's sanity table), so a human can check the
  classifier looks right.

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

### V2. Predictive test (H1, H4, H5, H6, H7)

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

For the true/false and stage features (ABOVE10, Stage 3 vs Stage 2, EARLY2 vs late Stage 2),
replace steps 1 to 3 with one regression per week: forward return on momentum rank, 2-week
return and the flag. Report the flag's average coefficient with a block-bootstrap interval.

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
  `external_ranks`. Volume features only. Stage and ABOVE10 are tested as gates and
  tie-breaks, never as score points, because summed ranks dilute a condition.
- Stage gate (C3 and C4): `no_buy` for fresh buys in Stage 3 (variant: Stage 3 or 4).
- Early Stage 2 tie-break (C4): among names within 3 rank places, early Stage 2 first.
- ABOVE10 gate (C3 and C4): `no_buy` for fresh buys below the 10-week average.

Evaluate on full, last 5 years, last 3 years and rolling 3-year windows. Report CAGR, Sharpe,
max drawdown, turnover, and tax-adjusted CAGR.

Pass: Sharpe at least the base in two-thirds of rolling windows, CAGR cost at most 1 point a
year, and better than the base in both halves.

### V5. The one planned combination (H8)

Only if a volume measure (VR2 or VR4) and EARLY2 each pass V2. Gate on C3 and C4: fresh buys
only for early Stage 2 names with VR4 in the top third. Tie-break on C4 with the same flag.
Same evaluation and pass rule as V4. No other combinations.

## Known caveats

- **Survivorship bias favours "rising volume is good".** Broad's universe is today's 755 names
  applied backwards (TODO 3.9.25). Stocks that grew into it had rising volume on the way up;
  the ones that faded are missing. A positive H1 or H4 result is provisional until membership is
  point-in-time.
- **Skipped weeks.** Shipped Broad skips 38% of weeks (3.9.25). Use the `weekly_marks` fill from
  `breadth_regime_tests.py`, and exclude events that land on skipped weeks from V1, as in 3.9.26.
- **Survivorship bias works against the Stage 3 gate.** Stocks that topped, fell and left the
  index are missing, so the Stage 3 names that remain are survivors that may have recovered.
  A negative H7 result is not proof on an unbiased universe.
- **No delivery data.** NSE's delivery percentage, the "real buying" measure, is not stored.
  Fetching it is a possible later data addition, not part of this plan.

## Deliverables

1. `packages/momentum-backtesting/scripts/volume_turnover_tests.py`, stages `v0` to `v5`,
   runnable with `uv run`. Reuse helpers from the breadth and trim scripts by import. Do not
   copy them.
2. Unit tests on a small hand-built frame for:
   - segment-aware share volume;
   - the median ratios;
   - CLV2;
   - ABOVE10 and DIST10;
   - the stage classifier, including the 2-week hold and the Stage 1 vs Stage 3 memory;
   - the residual step;
   - IC arithmetic.
3. CSVs in `data/backtests/volume/` (gitignored).
4. A Results section appended to this file, with a plain-English answer for each of H1 to H8.
5. TODO.md row 3.9.27 updated in the same commit. If anything passes, add its parameters to
   `docs/momentum-parameters-reference.md` (grade M) and the plain-English guide.

## Results

(Empty until the local run.)
