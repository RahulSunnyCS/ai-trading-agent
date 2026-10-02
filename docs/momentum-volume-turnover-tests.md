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
8. **Multiple testing.** 7 predictive features x 3 horizons x 2 universes is 42 tests, so at 95%
   about two pass by chance. A feature passes only at both 4 and 13 weeks and in both halves.
   (Was 8 features; DIST10 became a cross-check after V0, see "Decisions after V0".)
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
| EARLY2 | In Stage 2 and entered it within the last 13 weeks (true/false). Unknown for a left-censored Stage 2 spell (see "Decisions after V0") | H7, H8 |

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
worst 5). Also report each subgroup's mean and median 2-week rise, so a "weak close" group is
not just a "smaller spike" group.

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
- Stage gate (C3 and C4): `no_buy` for fresh buys in Stage 3. (The "Stage 3 or 4" variant was
  dropped after V0: Stage 4 is 0.4-1.7% of fresh buys.)
- Early Stage 2 tie-break (C4): among names within 3 rank places, early Stage 2 first.
- ABOVE10 gate (C3 only, after V0): `no_buy` for fresh buys below the 10-week average.

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

## Decisions after V0 (owner, 2026-10-03)

Fixed before V2 is run. They change the plan above where they disagree with it.

1. **H7 (stage) continues.** The 1% slope band stays primary. Every H7 result in V2 and V4 is
   also reported with the 2% band. A pass needs the 1% band to pass **and** the 2% band to agree
   in sign. The 2% band is a robustness check, not a second chance. The "Stage 3 or 4" gate
   variant is dropped.
2. **H6 (50-day average) continues in cut-down form.** ABOVE10 stays in V2 on the pool. In V4
   the ABOVE10 gate is tested on C3 only: C4 bought below its 10-week average only 2.1% of the
   time, under the 5% floor. DIST10 stays in V2 as a flagged cross-check (rank correlation 0.79
   with momentum and 0.85 with the 4-week return) and counts as a pass for nothing. The
   multiple-testing count is 7 features.
3. **EARLY2 is left-censored where the start is unknown.** When a Stage 2 spell's confirming run
   starts at the first classifiable week of a price segment (data start in 2016, or any segment
   restart, including the March 2020 false splits), its true start is unknown. Its
   weeks-in-stage and EARLY2 are set to unknown for the whole spell, and those stock-weeks are
   excluded from the H7 and H8 tests. V0 reports how many Stage 2 spells are censored.
4. **The 2020 check.** The split detector made 215 false splits in March 2020 (TODO 3.9.3).
   Each restarts a price segment, so about 28% of 2020's eligible stock-weeks have no features
   and no momentum rank. V2 reports every result twice: all years, and with 2020 excluded. A
   feature passes only if its sign holds in both.
5. **V1** reports each subgroup's mean and median 2-week rise next to its excess.

## Decisions after V1 (owner, 2026-10-03)

1. **H2's close-strength half is closed as untestable as written.** No new post-hoc close
   measure. The trigger and CLV2 measure the same two weeks, so a 20%+ two-week rise almost
   always closes near its two-week high: median CLV2 at an event is about 0.9, and no C3 or C4
   event is below 0.5 (one C5 event is).
2. **H2 fails** (see V1 below). V2 is not changed because of V1's direction; H1 tests it.

## Results

Run 2026-10-03 on branch `claude/momentum-backtest-improvements-7jqye2` (base e136b99) with
`packages/momentum-backtesting/scripts/volume_turnover_tests.py`. Data: the shared
`~/TradingData` catalog (`bars_1d_stock` to 2026-10-01) plus `data/` (weekly closes to
2026-10-02). CSVs are in `data/backtests/volume/` (gitignored).

**Data source.** Both `daily.parquet` and the catalog's `bars_1d_stock` carry share `volume`,
`high` and `low` on every row. The script reads `bars_1d_stock`, the table the Broad price frame
itself is built from. The 2,980 synthetic archive-gap rows are dropped (their volume is a copy).
Volume ratios need full windows (130 + 10 or 20 sessions, about 28 weeks) inside one price
segment, slightly stricter than the 26 weeks above.

### V0. Data checks

- **Coverage.** 87–94% of eligible stock-weeks have each volume and moving-average feature in
  every year except 2020 (VR2 75%, STAGE 70%). EARLY2 coverage is 64.9% in 2020 and 72.1% in
  2021, because the censored spells (decision 3) cluster after the 2020 restarts. The cause is
  the split detector's 215 false splits in March 2020 (COVID crash days with a turnover ratio
  under 3x): each restarts a price segment with no history. 7,039 of the 7,578 stage-less 2020
  stock-weeks are in such restarted segments. Broad's own momentum ranks restart the same way.
- **Stored volume vs turnover / close.** They agree: median ratio 0.998, 99.99% of rows within
  10%, VR2 rank correlation 0.9999 between the two.
- **The 20 largest single-day turnover jumps** (pool stock-weeks from 2017) are 210–760x the
  prior 20-session median. None is a month-end session, so they look like block deals rather
  than index rebalancing (examples: FACT 2026-08-25, AGARWALEYE 2026-08-12, CYIENT 2017-09-27,
  GODREJIND 2025-02-21). The weekly median-based VR2 at those weeks is mostly 0.4–3.5, against
  5–53 for a mean-based ratio, so the medians blunt them. The exception, GALLANTT in April 2026,
  is a real sustained surge (weekly median shares about 300x for two weeks, price +50%).
- **Mean weekly rank correlation in the pool** (|r| above 0.7 = re-measures the score):

  | Feature | Momentum strength | 2w return | 4w return |
  |---|---:|---:|---:|
  | VR2 | +0.26 | +0.23 | +0.31 |
  | VR4 | +0.24 | +0.13 | +0.26 |
  | RISE2 | +0.06 | +0.12 | +0.04 |
  | ACC13 | +0.43 | +0.21 | +0.31 |
  | LIQ13 | +0.05 | −0.00 | −0.01 |
  | CLV2 | +0.59 | **+0.75** | +0.49 |
  | ABOVE10 | +0.60 | +0.48 | +0.62 |
  | DIST10 | **+0.79** | +0.66 | **+0.85** |

- **Redundancy count** (1% slope band; Stage 3 share at 0.5% / 2% in brackets):

  | | C3 fresh buys | C3 weekly top 8 | C4 fresh buys | C4 weekly top 10 |
  |---|---:|---:|---:|---:|
  | Count | 763 | 1,627 | 3,255 | 5,090 |
  | Below the 10-week average | 7.1% | 6.7% | 2.1% | 1.4% |
  | Stage 3 | 9.4% (6.6 / 17.7) | 6.1% | 5.5% (3.7 / 10.4) | 4.2% |
  | Stage 4 | 1.7% | 1.0% | 0.4% | 0.3% |
  | Early Stage 2 | 32.8% | 29.9% | 27.8% | 27.3% |

  H7 clears the 5% floor in both strategies, H6 only in C3. Decisions: see "Decisions after V0".
- **EARLY2 censoring.** 545 of 6,882 Stage 2 spells (7.9%) are left-censored: 324 start in a
  restarted segment, 159 in 2020, and 444 belong to names that were in the pool at some point.
- **Stage sanity.** Each big run sits inside a long Stage 2: IRFC Aug 2023–Sep 2024, RVNL#2
  Oct 2022–May 2024+, IFCI Sep 2023–Oct 2024 (after an 18-week Stage 1 base), HINDCOPPER#3
  Oct 2020–Aug 2021 (after Stage 4 then Stage 1), GPIL Jan 2017–Jul 2018. Each is followed by
  Stage 3 and then Stage 4. None was early Stage 2 at its spike week: all were 19–48 weeks in.
  Weekly detail: `v0_stage_timelines.csv`.

### V1. Spike split (H2)

Events are the 3.9.26 trim events (tradable weeks only): 68 distinct in C3, 191 in C4, 33 in
C5. VR2 tercile cuts, computed over each strategy's distinct events: C3 2.09 / 3.89, C4
1.92 / 4.24, C5 1.53 / 3.20. The CLV2 subgroups are empty or equal to "all events" (decision 1)
and are left out below; they are in `v1_spike_split.csv`. Excess is the other holdings' return
minus the stock's, so **positive means trimming would have helped**. \* = the 95% interval
excludes zero. No interval is shown under 5 event weeks.

| Strategy | Trigger | Subgroup | Events | 2w rise mean / median | 4w excess [95% CI] (event weeks) | 8w excess [95% CI] (event weeks) | 8w 2017–21 / 2022+ | 8w drop best 5 / worst 5 |
|---|---|---|---:|---|---|---|---|---|
| C3 | 2w r>=20% | all events | 54 | +29% / +25% | -3.2% [-9.6, +2.5] (50) | -5.5% [-16.4, +3.6] (49) | -12.4% / +0.2% | -8.5% / +4.4% |
| C3 | 2w r>=20% | VR2 low third | 17 | +25% / +23% | -2.0% [-12.2, +5.9] (17) | -5.5% [-29.4, +12.1] (16) | -11.5% / +0.5% | -19.8% / +14.0% |
| C3 | 2w r>=20% | VR2 middle third | 18 | +32% / +26% | -2.6% [-11.6, +5.9] (18) | -2.3% [-13.8, +6.9] (18) | -3.9% / -1.6% | -9.8% / +6.8% |
| C3 | 2w r>=20% | VR2 top third | 19 | +31% / +29% | -4.3% [-17.8, +6.0] (19) | -6.6% [-26.5, +9.7] (19) | -12.8% / +4.1% | -18.0% / +10.7% |
| C3 | 2w r>=30% | all events | 17 | +44% / +40% | -7.4% [-21.9, +4.8] (17) | -13.9% [-38.2, +5.0] (17) | -28.1% / -1.3% | -28.9% / +7.6% |
| C3 | 2w r>=30% | VR2 low third | 3 | +39% / +36% | -8.5% (3) | -37.7% (3) | -66.6% / +20.1% | — / — |
| C3 | 2w r>=30% | VR2 middle third | 7 | +46% / +44% | -7.0% [-27.1, +10.3] (7) | -8.8% [-33.5, +11.8] (7) | -28.6% / -5.5% | -43.6% / +20.6% |
| C3 | 2w r>=30% | VR2 top third | 7 | +44% / +40% | -7.4% [-28.8, +10.4] (7) | -8.9% [-34.1, +14.5] (7) | -12.7% / +0.5% | -47.0% / +24.5% |
| C3 | 2w r>=40% | all events | 10 | +50% / +45% | -9.1% [-35.0, +11.1] (10) | -16.8% [-56.8, +12.0] (10) | -54.6% / +8.3% | -53.9% / +20.3% |
| C3 | 2w r>=40% | VR2 low third | 1 | +46% / +46% | -61.8% (1) | -146.8% (1) | -146.8% / — | — / — |
| C3 | 2w r>=40% | VR2 middle third | 5 | +50% / +45% | -0.2% [-31.8, +19.5] (5) | +4.1% [-21.0, +21.4] (5) | -28.6% / +12.3% | — / — |
| C3 | 2w r>=40% | VR2 top third | 4 | +52% / +52% | -7.0% (4) | -10.5% (4) | -21.4% / +0.5% | — / — |
| C3 | 2w z>=3 | all events | 26 | +31% / +25% | -3.0% [-12.1, +4.0] (23) | -1.4% [-11.7, +7.1] (22) | -5.1% / +0.7% | -7.1% / +5.3% |
| C3 | 2w z>=3 | VR2 low third | 6 | +16% / +17% | -3.5% [-8.8, +3.7] (5) | +0.7% (4) | +3.4% / -7.4% | — / — |
| C3 | 2w z>=3 | VR2 middle third | 10 | +37% / +39% | -0.4% [-13.6, +10.7] (10) | +3.3% [-8.5, +14.0] (10) | +2.3% / +3.7% | -9.9% / +16.5% |
| C3 | 2w z>=3 | VR2 top third | 10 | +33% / +28% | -4.2% [-20.6, +9.0] (10) | -6.4% [-25.9, +10.9] (10) | -18.5% / -1.3% | -25.7% / +12.9% |
| C3 | 2w z>=4 | all events | 12 | +34% / +27% | -4.3% [-20.3, +5.7] (11) | -5.2% [-24.9, +8.1] (11) | -10.9% / -1.9% | -18.9% / +9.5% |
| C3 | 2w z>=4 | VR2 low third | 1 | +26% / +26% | -8.7% (1) | -7.2% (1) | -7.2% / — | — / — |
| C3 | 2w z>=4 | VR2 middle third | 6 | +37% / +33% | +2.1% [-8.0, +10.2] (6) | +4.9% [-9.7, +15.8] (6) | +12.1% / -2.2% | -13.4% / +19.7% |
| C3 | 2w z>=4 | VR2 top third | 5 | +31% / +28% | -10.7% [-47.9, +6.5] (5) | -15.7% [-60.7, +5.5] (5) | -72.1% / -1.6% | — / — |
| C4 | 2w r>=20% | all events | 169 | +31% / +29% | -1.9% [-5.2, +1.2] (141) | -2.6% [-6.9, +1.7] (140) | -6.2% / +1.2% | -4.0% / +0.4% |
| C4 | 2w r>=20% | VR2 low third | 57 | +31% / +29% | -2.7% [-7.9, +2.0] (51) | -0.9% [-9.1, +6.2] (50) | -4.5% / +1.7% | -4.2% / +4.9% |
| C4 | 2w r>=20% | VR2 middle third | 58 | +28% / +25% | +0.3% [-4.3, +4.9] (54) | +1.1% [-4.8, +6.7] (54) | -4.2% / +6.4% | -1.3% / +5.5% |
| C4 | 2w r>=20% | VR2 top third | 54 | +33% / +30% | -4.3% [-11.6, +2.5] (51) | -9.8% [-19.4, -0.3]\* (51) | -11.6% / -6.7% | -13.6% / -0.7% |
| C4 | 2w r>=30% | all events | 82 | +40% / +36% | -2.1% [-7.0, +2.1] (76) | -2.5% [-8.5, +2.6] (76) | -5.5% / +1.1% | -5.9% / +1.5% |
| C4 | 2w r>=30% | VR2 low third | 29 | +38% / +35% | -3.5% [-10.3, +3.4] (27) | -1.1% [-12.8, +9.4] (27) | -8.6% / +5.9% | -6.6% / +9.5% |
| C4 | 2w r>=30% | VR2 middle third | 22 | +37% / +34% | +2.9% [-3.1, +8.5] (22) | -0.0% [-8.4, +8.9] (22) | -0.1% / +0.0% | -6.9% / +7.7% |
| C4 | 2w r>=30% | VR2 top third | 31 | +45% / +37% | -5.1% [-15.3, +3.4] (30) | -6.5% [-16.9, +3.3] (30) | -7.4% / -4.5% | -15.2% / +2.4% |
| C4 | 2w r>=40% | all events | 34 | +53% / +49% | -0.3% [-8.2, +6.4] (34) | +1.0% [-8.8, +9.2] (34) | -1.5% / +6.1% | -5.8% / +10.1% |
| C4 | 2w r>=40% | VR2 low third | 9 | +51% / +50% | -5.4% [-18.5, +8.0] (9) | +4.3% [-14.1, +21.5] (9) | -0.4% / +13.6% | -21.9% / +28.8% |
| C4 | 2w r>=40% | VR2 middle third | 11 | +47% / +44% | -0.0% [-15.3, +11.6] (11) | -3.0% [-23.2, +13.6] (11) | -4.3% / +0.5% | -23.1% / +17.5% |
| C4 | 2w r>=40% | VR2 top third | 14 | +58% / +52% | +2.7% [-13.4, +16.2] (14) | +2.0% [-17.1, +18.5] (14) | +0.3% / +5.1% | -13.4% / +20.5% |
| C4 | 2w z>=3 | all events | 66 | +39% / +35% | -0.9% [-5.4, +3.0] (60) | -2.1% [-8.3, +3.8] (59) | -6.0% / +1.6% | -4.1% / +3.9% |
| C4 | 2w z>=3 | VR2 low third | 16 | +40% / +36% | +1.6% [-5.4, +8.1] (15) | +3.8% [-9.8, +17.4] (14) | -2.8% / +6.4% | -9.9% / +18.4% |
| C4 | 2w z>=3 | VR2 middle third | 23 | +36% / +33% | +2.2% [-3.6, +7.8] (21) | +2.6% [-5.5, +9.9] (21) | +5.1% / -0.7% | -3.4% / +8.4% |
| C4 | 2w z>=3 | VR2 top third | 27 | +42% / +37% | -4.1% [-12.7, +2.9] (26) | -7.9% [-19.6, +2.3] (26) | -13.1% / -0.8% | -13.7% / +5.0% |
| C4 | 2w z>=4 | all events | 23 | +46% / +41% | -5.7% [-16.5, +2.8] (21) | -10.0% [-21.3, -0.9]\* (21) | -13.8% / -5.8% | -16.3% / -0.5% |
| C4 | 2w z>=4 | VR2 low third | 2 | +43% / +43% | +0.7% (2) | -6.4% (2) | — / -6.4% | — / — |
| C4 | 2w z>=4 | VR2 middle third | 12 | +39% / +42% | +1.5% [-5.8, +9.3] (10) | -4.8% [-13.4, +3.6] (10) | -6.6% / -2.1% | -11.9% / +3.3% |
| C4 | 2w z>=4 | VR2 top third | 9 | +56% / +40% | -15.2% [-35.1, +2.6] (9) | -16.6% [-38.3, +1.2] (9) | -22.5% / -9.2% | -39.9% / +4.7% |
| C5 | 2w r>=20% | all events | 29 | +32% / +26% | +0.3% [-5.9, +5.9] (28) | +1.4% [-8.4, +9.3] (28) | -8.8% / +13.2% | -4.3% / +9.9% |
| C5 | 2w r>=20% | VR2 low third | 10 | +27% / +24% | -3.1% [-14.2, +5.8] (10) | -8.1% [-28.4, +9.6] (10) | -15.6% / +21.9% | -31.2% / +14.9% |
| C5 | 2w r>=20% | VR2 middle third | 9 | +34% / +26% | -1.3% [-18.9, +15.5] (9) | +7.9% [-9.4, +24.2] (9) | -3.7% / +17.1% | -14.2% / +30.5% |
| C5 | 2w r>=20% | VR2 top third | 10 | +34% / +26% | +6.1% [-0.1, +11.8] (10) | +6.6% [-1.4, +15.0] (10) | +6.2% / +6.9% | -5.0% / +18.3% |
| C5 | 2w r>=30% | all events | 11 | +49% / +44% | -0.6% [-15.6, +10.7] (11) | -2.6% [-19.6, +13.2] (11) | -16.3% / +21.4% | -23.2% / +16.9% |
| C5 | 2w r>=30% | VR2 low third | 2 | +40% / +40% | +10.4% (2) | -3.8% (2) | -3.8% / — | — / — |
| C5 | 2w r>=30% | VR2 middle third | 5 | +45% / +41% | -6.0% [-36.6, +21.5] (5) | -3.2% [-33.6, +32.8] (5) | -27.5% / +33.2% | — / — |
| C5 | 2w r>=30% | VR2 top third | 4 | +57% / +60% | +0.7% (4) | -1.1% (4) | -11.9% / +9.7% | — / — |
| C5 | 2w r>=40% | all events | 7 | +57% / +59% | -2.8% [-25.7, +14.4] (7) | +3.5% [-17.3, +20.1] (7) | -6.9% / +17.4% | -21.7% / +29.1% |
| C5 | 2w r>=40% | VR2 low third | 1 | +44% / +44% | +18.1% (1) | +25.3% (1) | +25.3% / — | — / — |
| C5 | 2w r>=40% | VR2 middle third | 3 | +54% / +49% | -17.3% (3) | -3.5% (3) | -21.7% / +32.8% | — / — |
| C5 | 2w r>=40% | VR2 top third | 3 | +65% / +61% | +4.7% (3) | +3.3% (3) | -9.5% / +9.7% | — / — |
| C5 | 2w z>=3 | all events | 12 | +42% / +36% | +4.3% [-3.2, +11.7] (12) | +7.4% [-0.8, +16.2] (12) | +6.1% / +8.6% | -3.9% / +17.5% |
| C5 | 2w z>=3 | VR2 low third | 2 | +32% / +32% | +12.0% (2) | +19.7% (2) | +19.7% / — | — / — |
| C5 | 2w z>=3 | VR2 middle third | 3 | +48% / +49% | -4.5% (3) | +8.6% (3) | -12.5% / +19.1% | — / — |
| C5 | 2w z>=3 | VR2 top third | 7 | +42% / +28% | +5.9% [-1.3, +12.7] (7) | +3.4% [-5.6, +14.6] (7) | +3.3% / +3.4% | -8.4% / +21.9% |
| C5 | 2w z>=4 | all events | 5 | +43% / +28% | +9.0% [+0.0, +18.6]\* (5) | +10.6% [-3.1, +28.9] (5) | +9.0% / +11.7% | — / — |
| C5 | 2w z>=4 | VR2 low third | 0 | — | — | — | — / — | — / — |
| C5 | 2w z>=4 | VR2 middle third | 2 | +45% / +45% | +7.6% (2) | +12.9% (2) | -7.1% / +32.8% | — / — |
| C5 | 2w z>=4 | VR2 top third | 3 | +41% / +28% | +9.9% (3) | +9.1% (3) | +25.0% / +1.1% | — / — |

**Pass rule: 0 of 80 cells pass** (5 triggers x 8 subgroups x 2 horizons, judged on C3 plus C4
or C5).

**Direction.** In C3 and C4 the heavy-volume third was usually the *worst* one to trim:
heavy-volume spikes tended to keep rising more than the rest of the portfolio. That is the
opposite of the blow-off idea. Spike size does not explain it: the top third's 2-week rise is
only a few points larger than the middle third's. C5 leans the other way on 9–10 event weeks,
as it did in 3.9.26.

**Chance check.** One cell of 80 has an interval excluding zero (C4, r ≥ 20%, top third, 8
weeks: −9.8% [−19.4%, −0.3%], negative in both halves). About 4 are expected by chance, so it
is not evidence on its own.

**H2: fails.** Volume does not identify the spikes that reverse. The close-strength half cannot
be tested as written (decision 1).
