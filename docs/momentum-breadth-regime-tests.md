# Breadth and trend regime tests for the momentum strategy (cheap first pass)

Owner's questions, written 2026-10-01. A local session runs these on real data and reports.
The owner decides what to build after seeing the results. Nothing here is a result yet.

## The four questions

1. **Euphoria helps momentum.** When a high share of stocks is above its 50-day average, does
   the momentum strategy do better than at other times? If yes, stay fully invested then and
   hold some cash otherwise.
2. **Euphoria rolling over.** In euphoria, if breadth starts falling, should we move a little
   to cash?
3. **Washout.** When very few stocks are above their 50-day average (a bottoming market), is that
   a time to go to cash, or a time to buy?
4. **The owner's original rule.** When the trend is falling, reinvest only part of each sale
   (for example 90%).

## Why the test is an overlay, not an engine change

The engine already has a hook that withholds part of a week's fresh cash
(`Config.mass_exit_throttle` plus `run_backtest(mass_exit_weeks=...)`). It cannot hold a cash
level across weeks. On the next trade week `_run_buffer` sells the parked cash back into the top
names (the `UNPARK` step, `engine.py` around line 999). Each flagged week re-parks only a fraction
of that week's flow. Steady-state cash stays tiny, and each round trip pays costs and liquid-fund
tax. So the hook can test question 4 literally, but not questions 1 to 3.

Cheap and honest first pass: run the strategy once, unchanged, then apply an exposure overlay to
its weekly returns:

    r_overlay[t+1] = w[t] * r_strategy[t+1] + (1 - w[t]) * r_cash[t+1] - cost[t]
    cost[t] = |w[t] - w[t-1]| * 2 * cost_pct / 100

- `w[t]` is decided from data known at Friday close `t` and applied to the following week.
- `r_strategy` comes from `Result.equity`; `r_cash` from `Result.cash` (the liquid fund).
- Exposure never exceeds 1. "Add more money" means returning to 100% from a lower level.
- Known simplification: switching tax is ignored. Each switch would realise mostly short-term
  gains. Report the number of switches so the owner can judge. Only a scenario that survives the
  overlay gets built properly in the engine.

## Inputs to compute (no lookahead)

| Input | Definition | Notes |
|---|---|---|
| `B10[t]` | Percent of point-in-time Total Market members whose weekly close is above their 10-week average | Stands in for the 50-day average. Source: `categories/broad.py::load_stock_universe_frame` (price frame plus point-in-time membership) |
| `B40[t]` | Same with a 40-week average | Stands in for the 200-day average |
| `dB[t]` | `B10[t] - B10[t-4]` | Breadth rate of change over 4 weeks |
| `T[t]` | Nifty 50 close above its 40-week average, and that average higher than 4 weeks ago | Standard trend comparator |
| Eligibility | A stock counts only once it has the full average history, and only in weeks it is a member | Report the eligible count each week. Skip weeks with fewer than 100 eligible names |

Cross-check `B10` against the survivorship-free Nifty 50 stock layer (about 95 names). If the two
disagree badly, report it rather than pick one.

## Strategies and windows

- **Strategies:** (a) ETF dataset with the `live_config.toml` settings, (b) Broad Momentum with
  shipped defaults. The overlay is the same for both.
- **Windows:** full (2017 to latest), last 5 years, last 3 years, plus rolling 3-year windows
  stepped by a quarter.
- **Named episodes:** the 2018 small and mid cap fall, the 2020 COVID crash and rebound, and 2022.
  For each, report the strategy's drawdown with and without the overlay. For 2020 also report the
  weeks from the Nifty trough until exposure returned to 100%.

## Test cases

### T0. Diagnostic first (cheapest, decides whether T1 is worth running)

Bucket every week by regime using `B10[t]`:
- euphoria: `B10 >= 70` (also report with 80);
- washout: `B10 <= 30` (also report with 20);
- middle: everything else.

For each bucket report:
- the number of weeks and the number of separate episodes (runs of consecutive weeks);
- the mean next-week and next-4-week return of the strategy, of Nifty 50, and the excess;
- a 95% interval from a block bootstrap (4-week blocks).

Also split euphoria by `dB < 0` versus `dB >= 0` (question 2), and washout by `dB > 0` versus
`dB <= 0` (question 3: is washout-and-turning-up the buy signal?).

Answer questions 1 to 3 directly from this table. If no bucket's interval excludes the
all-weeks average, say so plainly. That means the overlays below are unlikely to help.

### T1. Overlay scenarios (base is always 100% invested)

| ID | Question | Rule for `w[t]` | Grid |
|---|---|---|---|
| S0 | Base | 1 always | none |
| S1 | 1 | 1 if euphoria, else `x` | hi in {70, 80}, x in {0.8, 0.6} |
| S2 | 2 | `x` if euphoria and `dB < -d`, else 1 | hi in {70, 80}, d in {5, 10}, x in {0.8, 0.6} |
| S3a | 3, cash | `x` if washout, else 1 | lo in {20, 30}, x in {0.5, 0.8} |
| S3b | 3, buy | Start from S4. Override to 1 when washout and `dB > 0` | lo in {20, 30} |
| S4 | Comparator | 1 if `T[t]`, else 0.5 | none |
| S5 | Comparator | Volatility target: `min(1, median trailing 26-week vol / current 26-week vol)` | none |

Run every case in the grid and report all of them, not only the best. That is 1 + 4 + 8 + 4 + 2
+ 1 + 1 = 21 overlay runs per strategy. Overlays are arithmetic on one equity series, so this
takes seconds.

Hysteresis: any rule that switches must hold its new state at least 2 weeks before switching
again. Report switches per year.

### T2. The owner's literal rule (question 4)

Flag weeks where `T[t]` is false. Pass them as `mass_exit_weeks` with
`Config(mass_exit_throttle=True, mass_exit_throttle_fraction=f)` for f in {0.1, 0.3}, buffer rule.
Report results next to S4. Explain in the write-up why cash does not accumulate under this hook,
using the `PARK` and `UNPARK` rows from the trade log as evidence.

## Metrics per run

CAGR, Sharpe against cash, max drawdown, Calmar (CAGR divided by max drawdown), average exposure,
switches per year, total switching cost, and the share of rolling 3-year windows where the
scenario beats S0 on Sharpe and on max drawdown.

## Proposed decision rule (the owner makes the final call)

A scenario is worth building properly in the engine only if all of these hold:

1. T0 shows the regime matters: its bucket's interval excludes the all-weeks average, with at
   least 3 separate episodes.
2. Sharpe at least equal to S0 in two-thirds or more of the rolling windows.
3. Shallower drawdown in at least 2 of the 3 named episodes.
4. CAGR cost no more than 2 points a year against S0.
5. It beats or matches both comparators S4 and S5, or is clearly different from them.

Anything that only wins on the full-sample window fails.

## Deliverables from the local session

1. `packages/momentum-backtesting/scripts/breadth_regime_tests.py`, runnable with `uv run`. Add
   tests for the breadth calculation and the overlay arithmetic on a small hand-built frame.
2. CSVs in `data/backtests/regime/` (gitignored): the weekly breadth series, the T0 table, and
   one row per T1/T2 run.
3. A short write-up appended to this file under "Results". Include the T0 table, the T1 summary,
   the episode table, and a plain-English answer to each of the four questions.
4. A TODO.md row update (3.9.24) in the same commit. If a scenario passes, add its parameters to
   `docs/momentum-parameters-reference.md` (grade M) and the plain-English guide.

## Results

Run 2026-10-01 on branch `claude/momentum-backtest-improvements-7jqye2` (base 24477de) with
`packages/momentum-backtesting/scripts/breadth_regime_tests.py` (`t0`, then `t1`). Data: the
shared `~/TradingData` catalog plus `data/` as of 2026-09-25 (stock frame) / 2026-10-02 (weekly
closes). ETF: 2017-01-06 to 2026-10-02, 508 weeks. Broad Momentum: 2017-01-13 to 2026-09-25,
507 weeks. All CSVs are in `data/backtests/regime/` (gitignored). Pre-tax throughout.

### Read this first: two data problems

1. **Total Market membership is not point-in-time.** Every row of `total_market_membership.csv`
   (8,305 rows) has `source_tier = constant_current`: today's 755 names applied to every year
   from 2016 to 2026. So B10/B40 are survivorship-biased: stocks that collapsed and left are
   missing, and stocks that later grew into the list count from the day they listed. The
   cross-check on the survivorship-free Nifty 50 layer measures the size of that bias.
   - Nifty 50 B10 with today's members applied backwards, minus point-in-time Nifty 50 B10:
     +2.5 points on average (mean absolute gap 3.6).
   - Total Market B10 against point-in-time Nifty 50 B10, from 2017: correlation 0.88, mean
     gap -1.8, mean absolute gap 9.0, same 70/30 regime label 76% of weeks.

   The two disagree moderately, not badly. Both series are in
   `breadth_crosscheck_nifty50.csv`. The same bias inflates Broad Momentum's own CAGR, so treat
   its absolute numbers as optimistic. Comparisons between overlays on the same series are less
   affected.
2. **Shipped Broad Momentum skips 38% of weeks.** Its effective `top_n` is 8 (4 categories x 2
   picks). `engine.run_backtest` drops every week with fewer than 8 ranked names (the `enough`
   gate): 193 of 507 weeks, with the most in 2018 (34) and 2025 (36). A skipped week is neither
   traded nor marked, so Broad cannot sell during thin-breadth weeks.
   - The script fills those weeks by carrying the last kept week's post-trade holdings at
     current prices (`weekly_marks`).
   - Nothing trades in a skipped week, so the fill is exact apart from costs. The worst
     disagreement with the engine's own equity at a kept week is 0.18%.
   - Without the fill, Broad's "next week" would sometimes be 5 weeks, and annualisation would
     be wrong.

Other checks:
- At least 284 names had 10 weeks of history in every week (median 514), so no week fell below
  the 100-name floor.
- The S0 overlay reproduces each strategy's own equity exactly. This is asserted in the script.

### T0 diagnostic

The block bootstrap uses 4-week circular blocks and 2,000 resamples. 14 buckets x 4 starred
statistics x 2 strategies = 112 intervals. At 95%, about 5 would exclude the average by chance
alone.

**ETF (live_config.toml)** — forward returns in %, 95% block-bootstrap interval; \* = interval excludes the all-weeks mean

| Bucket | Weeks | Episodes | Strategy next 1w | Nifty next 1w | Excess next 1w | Strategy next 4w | Excess next 4w |
|---|---:|---:|---|---:|---|---|---|
| all weeks | 508 | 1 | +0.47 [+0.23, +0.70] | +0.23 | +0.25 [+0.06, +0.44] | +1.90 [+1.07, +2.67] | +0.99 [+0.38, +1.65] |
| euphoria B10>=70 | 139 | 31 | +0.64 [+0.27, +0.97] | +0.30 | +0.34 [+0.04, +0.61] | +2.58 [+1.40, +3.71] | +1.28 [+0.28, +2.24] |
| euphoria B10>=80 | 82 | 24 | +0.74 [+0.26, +1.16] | +0.35 | +0.39 [-0.02, +0.77] | +2.73 [+1.16, +4.16] | +1.56 [+0.35, +2.68] |
| middle 30<B10<70 | 280 | 56 | +0.51 [+0.20, +0.83] | +0.29 | +0.23 [-0.05, +0.51] | +1.86 [+0.81, +2.87] | +1.16 [+0.34, +2.05] |
| washout B10<=30 | 89 | 24 | +0.07 [-0.54, +0.75] | -0.09 | +0.17 [-0.34, +0.71] | +0.95 [-0.64, +2.72] | +0.03 [-1.23, +1.47] |
| washout B10<=20 | 41 | 18 | -0.26 [-1.29, +0.97] | -0.13 | -0.13 [-0.93, +0.75] | +0.65 [-1.64, +3.39] | -0.90 [-2.93, +1.45] |
| euphoria>=70 & dB<0 | 42 | 22 | +0.52 [-0.17, +1.23] | +0.10 | +0.43 [-0.09, +0.92] | +2.32 [+0.85, +3.84] | +1.11 [-0.38, +2.62] |
| euphoria>=70 & dB>=0 | 97 | 31 | +0.68 [+0.22, +1.11] | +0.39 | +0.30 [-0.09, +0.66] | +2.70 [+1.19, +4.14] | +1.35 [+0.20, +2.46] |
| euphoria>=80 & dB<0 | 17 | 12 | +0.55 [-0.68, +1.67] | +0.16 | +0.39 [-0.56, +1.18] | +2.60 [-0.12, +5.21] | +2.39 [+0.46, +4.17] |
| euphoria>=80 & dB>=0 | 65 | 25 | +0.79 [+0.23, +1.27] | +0.40 | +0.39 [-0.09, +0.84] | +2.76 [+0.93, +4.34] | +1.35 [-0.03, +2.57] |
| washout<=30 & dB>0 | 10 | 6 | +0.53 [-0.98, +2.15] | -0.10 | +0.62 [-0.89, +1.66] | +0.70 [-2.58, +4.69] | -0.34 [-2.93, +3.44] |
| washout<=30 & dB<=0 | 79 | 25 | +0.02 [-0.62, +0.75] | -0.09 | +0.11 [-0.44, +0.71] | +0.99 [-0.71, +2.83] | +0.07 [-1.27, +1.64] |
| washout<=20 & dB>0 | 4 | 3 | +1.59 [-0.65, +5.51] | +1.44 | +0.15 [-3.43, +3.81] | +1.04 [-1.67, +4.76] | -0.92 [-3.60, +3.23] |
| washout<=20 & dB<=0 | 37 | 18 | -0.46 [-1.48, +0.66] | -0.30 | -0.16 [-1.01, +0.75] | +0.60 [-1.72, +3.56] | -0.90 [-3.11, +1.59] |

**Broad Momentum (shipped defaults)** — forward returns in %, 95% block-bootstrap interval; \* = interval excludes the all-weeks mean

| Bucket | Weeks | Episodes | Strategy next 1w | Nifty next 1w | Excess next 1w | Strategy next 4w | Excess next 4w |
|---|---:|---:|---|---:|---|---|---|
| all weeks | 507 | 1 | +0.66 [+0.36, +0.95] | +0.22 | +0.44 [+0.18, +0.69] | +2.70 [+1.71, +3.65] | +1.80 [+0.97, +2.64] |
| euphoria B10>=70 | 139 | 31 | +1.13 [+0.56, +1.69] | +0.30 | +0.83 [+0.27, +1.39] | +4.18 [+2.40, +6.05] | +2.88 [+1.20, +4.63] |
| euphoria B10>=80 | 82 | 24 | +1.28 [+0.63, +1.85] | +0.35 | +0.93 [+0.27, +1.54] | +4.50 [+1.96, +6.94] | +3.33 [+0.98, +5.82] |
| middle 30<B10<70 | 279 | 55 | +0.51 [+0.15, +0.85] | +0.29 | +0.22 [-0.11, +0.55] | +2.10 [+0.90, +3.26] | +1.40 [+0.37, +2.44] |
| washout B10<=30 | 89 | 24 | +0.42 [-0.27, +1.17] | -0.09 | +0.52 [-0.09, +1.11] | +2.28 [+0.54, +4.09] | +1.35 [-0.05, +2.76] |
| washout B10<=20 | 41 | 18 | +0.42 [-0.72, +1.61] | -0.13 | +0.55 [-0.20, +1.29] | +2.23 [+0.12, +4.35] | +0.68 [-1.10, +2.59] |
| euphoria>=70 & dB<0 | 42 | 22 | +1.14 [+0.19, +2.30] | +0.10 | +1.05 [+0.06, +2.32] | +4.46 [+2.18, +6.82] | +3.25 [+0.82, +5.64] |
| euphoria>=70 & dB>=0 | 97 | 31 | +1.13 [+0.42, +1.76] | +0.39 | +0.74 [+0.09, +1.34] | +4.06 [+1.78, +6.27] | +2.71 [+0.79, +4.84] |
| euphoria>=80 & dB<0 | 17 | 12 | +1.04 [-0.64, +2.50] | +0.16 | +0.88 [-0.74, +2.60] | +3.73 [+0.25, +7.91] | +3.51 [-0.06, +7.71] |
| euphoria>=80 & dB>=0 | 65 | 25 | +1.34 [+0.65, +1.98] | +0.40 | +0.94 [+0.26, +1.60] | +4.70 [+1.91, +7.37] | +3.29 [+0.73, +5.97] |
| washout<=30 & dB>0 | 10 | 6 | +0.76 [-1.08, +3.05] | -0.10 | +0.86 [+0.08, +1.61] | +1.40 [-0.92, +4.49] | +0.37 [-1.95, +3.25] |
| washout<=30 & dB<=0 | 79 | 25 | +0.38 [-0.38, +1.18] | -0.09 | +0.47 [-0.20, +1.16] | +2.39 [+0.45, +4.39] | +1.47 [-0.06, +2.98] |
| washout<=20 & dB>0 | 4 | 3 | +1.47 [+0.38, +3.36] | +1.44 | +0.03 [-1.14, +1.18] | +0.56 [-2.25, +3.10] | -1.39 [-4.17, +1.57]\* |
| washout<=20 & dB<=0 | 37 | 18 | +0.30 [-0.94, +1.60] | -0.30 | +0.60 [-0.23, +1.44] | +2.41 [+0.12, +4.81] | +0.91 [-1.03, +2.88] |

Only **one** of the 112 intervals excludes the all-weeks mean: Broad, washout ≤20 with breadth
turning up, next-4-week return over Nifty. That bucket is 4 weeks in 3 episodes, and the
direction is the opposite of a buy signal. That is fewer exclusions than chance alone would
produce.

### T1 overlays and T2 (the owner's literal rule)

Reading the table:
- Switch cost is the summed overlay switching cost, as a share of capital. T2 has no overlay
  switching cost, because its costs are inside the engine.
- For T2, "switches/yr" counts mass-exit PARK rows.
- Rule 1 is judged on the strategy's own forward return (1w or 4w) in the scenario's T0
  bucket, with at least 3 episodes. The overlay trades the strategy against cash, so excess
  over Nifty is not the relevant comparison. Counting the excess column as well would change
  only S3b lo=20 for Broad, which fails rules 2 and 4 anyway.
- Rule 5 passes if full-sample Sharpe is at least the higher of S4 and S5, or if the exposure
  correlates below 0.5 with both.
- The rule columns on S0, S4, S5 and T2 are for information only.

**ETF (live_config.toml)** — full window unless noted; rolling = share of the 27 rolling 3-year windows

| Run | CAGR | Sharpe | Max DD | Calmar | 5y Sharpe | 3y Sharpe | Avg exposure | Switches/yr | Switch cost | Rolling Sharpe ≥ S0 | Rolling DD shallower | R1 | R2 | R3 | R4 | R5 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:-:|:-:|:-:|:-:|:-:|
| S0 | 25.5% | 0.98 | -30.5% | 0.83 | 1.16 | 1.39 | 1.00 | 0.0 | 0.0% | 100% | 0% | — | ✓ | ✗ | ✓ | ✓ |
| S1 hi=70 x=0.8 | 22.7% | 0.99 | -24.2% | 0.94 | 1.15 | 1.36 | 0.86 | 6.3 | 2.4% | 67% | 100% | ✗ | ✓ | ✓ | ✗ | ✓ |
| S1 hi=70 x=0.6 | 19.8% | 1.00 | -17.4% | 1.14 | 1.11 | 1.31 | 0.71 | 6.3 | 4.9% | 59% | 100% | ✗ | ✗ | ✓ | ✗ | ✓ |
| S1 hi=80 x=0.8 | 22.6% | 1.00 | -23.6% | 0.96 | 1.15 | 1.40 | 0.83 | 4.4 | 1.7% | 70% | 100% | ✗ | ✓ | ✓ | ✗ | ✓ |
| S1 hi=80 x=0.6 | 19.6% | 1.03 | -16.1% | 1.22 | 1.13 | 1.41 | 0.66 | 4.4 | 3.4% | 67% | 100% | ✗ | ✓ | ✓ | ✗ | ✓ |
| S2 hi=70 d=5 x=0.8 | 25.2% | 0.97 | -30.5% | 0.83 | 1.16 | 1.39 | 0.99 | 2.7 | 1.0% | 33% | 0% | ✗ | ✗ | ✗ | ✓ | ✓ |
| S2 hi=70 d=5 x=0.6 | 25.0% | 0.97 | -30.5% | 0.82 | 1.15 | 1.39 | 0.98 | 2.7 | 2.1% | 30% | 0% | ✗ | ✗ | ✗ | ✓ | ✓ |
| S2 hi=70 d=10 x=0.8 | 24.8% | 0.96 | -30.5% | 0.81 | 1.15 | 1.39 | 0.99 | 1.6 | 0.6% | 7% | 0% | ✗ | ✗ | ✗ | ✓ | ✓ |
| S2 hi=70 d=10 x=0.6 | 24.2% | 0.94 | -30.5% | 0.79 | 1.14 | 1.39 | 0.98 | 1.6 | 1.3% | 7% | 0% | ✗ | ✗ | ✗ | ✓ | ✓ |
| S2 hi=80 d=5 x=0.8 | 25.5% | 0.98 | -30.5% | 0.84 | 1.16 | 1.39 | 1.00 | 0.4 | 0.2% | 93% | 0% | ✗ | ✓ | ✗ | ✓ | ✓ |
| S2 hi=80 d=5 x=0.6 | 25.6% | 0.99 | -30.5% | 0.84 | 1.16 | 1.39 | 1.00 | 0.4 | 0.3% | 93% | 0% | ✗ | ✓ | ✗ | ✓ | ✓ |
| S2 hi=80 d=10 x=0.8 | 25.2% | 0.97 | -30.5% | 0.83 | 1.16 | 1.39 | 1.00 | 0.2 | 0.1% | 56% | 0% | ✗ | ✗ | ✗ | ✓ | ✓ |
| S2 hi=80 d=10 x=0.6 | 25.0% | 0.96 | -30.5% | 0.82 | 1.16 | 1.39 | 1.00 | 0.2 | 0.2% | 56% | 0% | ✗ | ✗ | ✗ | ✓ | ✓ |
| S3a lo=20 x=0.5 | 27.4% | 1.12 | -22.0% | 1.25 | 1.29 | 1.65 | 0.95 | 3.1 | 3.0% | 70% | 70% | ✗ | ✓ | ✓ | ✓ | ✓ |
| S3a lo=20 x=0.8 | 26.3% | 1.04 | -27.2% | 0.97 | 1.22 | 1.50 | 0.98 | 3.1 | 1.2% | 70% | 70% | ✗ | ✓ | ✓ | ✓ | ✓ |
| S3a lo=30 x=0.5 | 25.6% | 1.07 | -22.4% | 1.14 | 1.24 | 1.53 | 0.91 | 4.1 | 4.0% | 85% | 70% | ✗ | ✓ | ✓ | ✓ | ✓ |
| S3a lo=30 x=0.8 | 25.5% | 1.02 | -27.3% | 0.93 | 1.20 | 1.45 | 0.96 | 4.1 | 1.6% | 96% | 70% | ✗ | ✓ | ✓ | ✓ | ✓ |
| S3b lo=20 | 25.7% | 1.11 | -22.5% | 1.14 | 1.36 | 1.87 | 0.85 | 3.9 | 3.9% | 41% | 74% | ✗ | ✗ | ✓ | ✓ | ✓ |
| S3b lo=30 | 25.4% | 1.09 | -22.5% | 1.13 | 1.33 | 1.87 | 0.85 | 4.1 | 4.1% | 37% | 74% | ✗ | ✗ | ✓ | ✓ | ✗ |
| S4 trend | 25.6% | 1.11 | -22.3% | 1.15 | 1.37 | 1.87 | 0.84 | 3.3 | 3.3% | 41% | 74% | — | ✗ | ✓ | ✓ | ✓ |
| S5 vol target | 21.6% | 0.93 | -28.0% | 0.77 | 1.23 | 1.47 | 0.86 | 16.9 | 1.1% | 41% | 100% | — | ✗ | ✓ | ✗ | ✗ |
| T2 throttle f=0.1 | 25.3% | 0.97 | -30.4% | 0.83 | 1.16 | 1.38 | 1.00 | 15.6 | — | 15% | 52% | — | ✗ | ✓ | ✓ | ✓ |
| T2 throttle f=0.3 | 25.0% | 0.97 | -30.1% | 0.83 | 1.14 | 1.37 | 0.99 | 15.6 | — | 44% | 81% | — | ✗ | ✓ | ✓ | ✓ |

**Broad Momentum (shipped defaults)** — full window unless noted; rolling = share of the 27 rolling 3-year windows

| Run | CAGR | Sharpe | Max DD | Calmar | 5y Sharpe | 3y Sharpe | Avg exposure | Switches/yr | Switch cost | Rolling Sharpe ≥ S0 | Rolling DD shallower | R1 | R2 | R3 | R4 | R5 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:-:|:-:|:-:|:-:|:-:|
| S0 | 37.5% | 1.23 | -23.6% | 1.59 | 1.36 | 1.22 | 1.00 | 0.0 | 0.0% | 100% | 0% | — | ✓ | ✗ | ✓ | ✓ |
| S1 hi=70 x=0.8 | 34.0% | 1.26 | -19.1% | 1.78 | 1.41 | 1.26 | 0.85 | 6.1 | 2.4% | 85% | 100% | ✗ | ✓ | ✓ | ✗ | ✓ |
| S1 hi=70 x=0.6 | 30.4% | 1.28 | -17.2% | 1.77 | 1.45 | 1.29 | 0.71 | 6.1 | 4.7% | 74% | 100% | ✗ | ✓ | ✓ | ✗ | ✓ |
| S1 hi=80 x=0.8 | 33.4% | 1.28 | -19.1% | 1.75 | 1.39 | 1.24 | 0.83 | 4.3 | 1.7% | 100% | 100% | ✗ | ✓ | ✓ | ✗ | ✓ |
| S1 hi=80 x=0.6 | 29.1% | 1.33 | -14.4% | 2.02 | 1.41 | 1.24 | 0.66 | 4.3 | 3.4% | 96% | 100% | ✗ | ✓ | ✓ | ✗ | ✓ |
| S2 hi=70 d=5 x=0.8 | 37.0% | 1.22 | -23.6% | 1.57 | 1.34 | 1.18 | 0.99 | 2.7 | 1.0% | 19% | 0% | ✗ | ✗ | ✗ | ✓ | ✓ |
| S2 hi=70 d=5 x=0.6 | 36.5% | 1.21 | -23.6% | 1.55 | 1.33 | 1.14 | 0.98 | 2.7 | 2.1% | 19% | 0% | ✗ | ✗ | ✗ | ✓ | ✓ |
| S2 hi=70 d=10 x=0.8 | 36.8% | 1.21 | -23.6% | 1.56 | 1.35 | 1.21 | 0.99 | 1.6 | 0.6% | 7% | 0% | ✗ | ✗ | ✗ | ✓ | ✓ |
| S2 hi=70 d=10 x=0.6 | 36.1% | 1.19 | -23.6% | 1.53 | 1.33 | 1.20 | 0.98 | 1.6 | 1.3% | 7% | 0% | ✗ | ✗ | ✗ | ✓ | ✓ |
| S2 hi=80 d=5 x=0.8 | 37.4% | 1.23 | -23.6% | 1.58 | 1.36 | 1.22 | 1.00 | 0.4 | 0.2% | 67% | 0% | ✗ | ✓ | ✗ | ✓ | ✓ |
| S2 hi=80 d=5 x=0.6 | 37.4% | 1.23 | -23.6% | 1.58 | 1.36 | 1.22 | 1.00 | 0.4 | 0.3% | 59% | 0% | ✗ | ✗ | ✗ | ✓ | ✓ |
| S2 hi=80 d=10 x=0.8 | 37.2% | 1.22 | -23.6% | 1.58 | 1.36 | 1.22 | 1.00 | 0.2 | 0.1% | 56% | 0% | ✗ | ✗ | ✗ | ✓ | ✓ |
| S2 hi=80 d=10 x=0.6 | 36.9% | 1.21 | -23.6% | 1.56 | 1.36 | 1.22 | 1.00 | 0.2 | 0.2% | 56% | 0% | ✗ | ✗ | ✗ | ✓ | ✓ |
| S3a lo=20 x=0.5 | 38.0% | 1.29 | -19.0% | 2.00 | 1.41 | 1.34 | 0.95 | 3.1 | 3.0% | 67% | 70% | ✗ | ✓ | ✓ | ✓ | ✓ |
| S3a lo=20 x=0.8 | 37.7% | 1.26 | -20.7% | 1.82 | 1.38 | 1.27 | 0.98 | 3.1 | 1.2% | 67% | 70% | ✗ | ✓ | ✓ | ✓ | ✓ |
| S3a lo=30 x=0.5 | 36.2% | 1.27 | -19.0% | 1.91 | 1.39 | 1.33 | 0.91 | 4.1 | 4.0% | 59% | 85% | ✗ | ✗ | ✓ | ✓ | ✓ |
| S3a lo=30 x=0.8 | 37.0% | 1.25 | -21.4% | 1.73 | 1.38 | 1.27 | 0.96 | 4.1 | 1.6% | 67% | 85% | ✗ | ✓ | ✓ | ✓ | ✓ |
| S3b lo=20 | 33.6% | 1.21 | -23.4% | 1.44 | 1.47 | 1.43 | 0.85 | 3.8 | 3.7% | 22% | 81% | ✗ | ✗ | ✓ | ✗ | ✓ |
| S3b lo=30 | 33.1% | 1.19 | -23.4% | 1.42 | 1.43 | 1.43 | 0.85 | 4.0 | 3.9% | 19% | 81% | ✗ | ✗ | ✓ | ✗ | ✗ |
| S4 trend | 33.3% | 1.21 | -23.4% | 1.43 | 1.46 | 1.43 | 0.84 | 3.2 | 3.1% | 22% | 81% | — | ✗ | ✓ | ✗ | ✗ |
| S5 vol target | 35.3% | 1.21 | -21.2% | 1.66 | 1.35 | 1.26 | 0.93 | 15.2 | 0.9% | 30% | 100% | — | ✗ | ✓ | ✗ | ✓ |
| T2 throttle f=0.1 | 37.1% | 1.22 | -23.6% | 1.57 | 1.34 | 1.21 | 0.99 | 10.3 | — | 15% | 78% | — | ✗ | ✓ | ✓ | ✓ |
| T2 throttle f=0.3 | 36.4% | 1.20 | -23.6% | 1.54 | 1.31 | 1.19 | 0.97 | 10.3 | — | 11% | 78% | — | ✗ | ✓ | ✓ | ✓ |

**Why T2 cannot hold cash** (`t2_park_unpark.csv`):
- Each flagged week, the throttle parks a fraction of that week's fresh sale proceeds (a
  `PARK` row). On the next trade week, `_run_buffer` sells it back into the top names (an
  `UNPARK` row "back into the top N") before deciding afresh.
- ETF: 163 trend-down weeks produced 152 mass-exit PARK rows and 151 UNPARK rows. Every PARK
  except the last is undone by the next UNPARK, within 5% of its value (median ratio 1.00). In
  March to May 2020, for example, the parked amounts were 0.112, 0.049, 0.015, 0.023, 0.038 and
  so on (in units of starting capital), each sold back the following week.
- Idle cash during flagged weeks averaged 1.2% of the portfolio at f=0.1 and 4.3% at f=0.3. Its
  maximum is one week's withheld flow: 10% or 30%.
- Broad: 101 flagged weeks, 100 PARK rows, 99 UNPARK rows, and 2.5% / 8.6% average idle.
- So the hook never builds a cash level. It delays a small slice of each week's buys by one
  week and pays costs on the round trip.
- The PARK reason text says "over half of last week's held names exited". That is the engine's
  fixed label for this hook. The trigger here was the trend flag.

### Episodes

Drawdown is measured inside each window from the window's own running peak. The windows are:
- 2018: 2018-01-01 to 2019-06-30
- 2020: calendar 2020
- 2022: 2021-10-01 to 2022-12-31

"Re-entry" counts the weeks from the Nifty 2020 trough (weekly close 2020-04-03) until the
decided exposure is back to at least 99%. Two caveats:
- S3b reaches 1 quickly on a washout-and-turning-up week but can drop back to 0.5.
- S5 is continuous, so it rarely reaches 99%.

The selected rows are below. All 23 runs per strategy are in `t1_t2_runs.csv`.

| Run | ETF 2018 | ETF 2020 | ETF 2022 | ETF 2020 re-entry (wks) | Broad 2018 | Broad 2020 | Broad 2022 | Broad 2020 re-entry (wks) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| S0 | -16.6% | -20.4% | -15.8% | 0 | -20.5% | -23.6% | -16.1% | 0 |
| S1 hi=70 x=0.8 | -13.3% | -16.5% | -14.7% | 9 | -17.1% | -19.1% | -13.7% | 9 |
| S1 hi=80 x=0.6 | -10.5% | -12.4% | -12.6% | 9 | -12.2% | -14.4% | -9.0% | 9 |
| S2 hi=70 d=5 x=0.6 | -16.6% | -20.4% | -15.8% | 0 | -20.5% | -23.6% | -16.1% | 0 |
| S3a lo=20 x=0.5 | -13.4% | -13.7% | -15.9% | 2 | -18.9% | -16.2% | -18.2% | 2 |
| S3a lo=20 x=0.8 | -15.3% | -17.8% | -15.8% | 2 | -19.1% | -20.7% | -16.9% | 2 |
| S3a lo=30 x=0.5 | -13.0% | -14.7% | -16.7% | 3 | -17.2% | -18.1% | -14.2% | 3 |
| S3b lo=20 | -15.9% | -14.7% | -15.8% | 1 | -23.4% | -18.1% | -12.9% | 1 |
| S4 trend | -15.9% | -14.7% | -15.8% | 33 | -23.4% | -18.1% | -12.9% | 33 |
| S5 vol target | -16.5% | -17.7% | -12.2% | 137 | -18.9% | -21.2% | -15.9% | 77 |
| T2 throttle f=0.1 | -16.5% | -20.4% | -15.8% | 0 | -20.5% | -23.6% | -16.0% | 0 |
| T2 throttle f=0.3 | -16.3% | -20.1% | -15.8% | 1 | -20.5% | -23.6% | -16.0% | 0 |

### Answers to the four questions

1. **Does euphoria help momentum?** It points that way, but it isn't proven. In euphoria
   (B10 ≥ 70) both strategies earned more per week than average: ETF +0.64% vs +0.47%, Broad
   +1.13% vs +0.66%. Every interval overlaps the average. Holding cash outside euphoria (S1)
   gives up 3 to 8 CAGR points a year. It cuts drawdowns only because you are less invested
   most of the time: average exposure is 0.66 to 0.86. It fails the 2-point CAGR limit at every
   grid point.
2. **Should we trim when euphoric breadth rolls over?** No. Inside euphoria, falling breadth
   does about the same as rising breadth: ETF +0.52% vs +0.68% a week, Broad +1.14% vs +1.13%.
   S2 fires rarely (0.2 to 2.7 switches a year). It never changes any episode drawdown, and
   its Sharpe is flat to slightly lower. Only the rarest versions (hi=80, d=5) hold Sharpe in
   two-thirds of rolling windows, and they hardly ever act.
3. **Is a washout a cash signal or a buy signal?**
   - **Not a buy signal.** Washout-and-turning-up weeks are rare: 4 to 10 weeks. Their 4-week
     returns are, if anything, below average. S3b behaves like the trend comparator S4
     (exposure correlation 0.96 to 0.97) and fails on rolling Sharpe.
   - **As a cash signal**, T0 cannot show it: washout returns are lower for ETF and similar for
     Broad, but neither is significant. The overlay test is more encouraging. S3a (cut to 50% or
     80% when B10 ≤ 20 or ≤ 30) raised Sharpe and cut drawdowns on both strategies:
     - ETF lo=20 x=0.5: Sharpe 1.12 vs 0.98, max drawdown -22.0% vs -30.5%, CAGR +1.9 points.
     - Broad lo=20 x=0.5: Sharpe 1.29 vs 1.23, max drawdown -19.0% vs -23.6%, CAGR +0.5 points.
     - It held its Sharpe in 59% to 96% of rolling windows, cost at most 1.3 CAGR points, and kept
       only 2 to 9% in cash on average.
   - The gain comes from washout weeks being both more volatile and somewhat weaker, without
     the weakness being significant on its own. That is why T0 misses it. Weekly standard
     deviation in B10 ≤ 20 weeks vs all weeks: ETF 3.2% vs 2.6% (mean -0.26% vs +0.47%), Broad
     3.7% vs 3.2% (+0.42% vs +0.66%).
   - The weaknesses: it worsened Broad's 2022 drawdown (-18.2% vs -16.1%). Washout weeks are
     concentrated in 2018 to 2020, 2022 and 2025, so a few episodes carry the result. And the
     washout threshold is measured on a survivorship-biased universe.
4. **Reinvest only part of each sale when the trend falls (the owner's original rule).**
   - **As written (T2), it does nothing useful.** f=0.1 is the 90% rule. Through the existing
     hook it leaves drawdowns unchanged and costs 0.2 to 1.1 CAGR points, because the parked
     cash is redeployed the following week (see above).
   - Holding a real cash level whenever the trend is down (S4, 50% invested) has a mixed
     record:
     - For ETF it cut the full-sample max drawdown (-22.3% vs -30.5%) and lifted full and
       recent Sharpe, at no CAGR cost. But it beat S0 on Sharpe in only 41% of rolling windows.
     - For Broad it cost 4.2 CAGR points and lowered Sharpe.
     - Both versions took 33 weeks after the 2020 trough to get fully back in.

### Decision rule applied

| Strategy | Scenarios passing all five rules | Pass rules 2–5 but fail rule 1 |
|---|---|---|
| ETF | none | S3a lo=20 x=0.5, lo=20 x=0.8, lo=30 x=0.5, lo=30 x=0.8 |
| Broad | none | S3a lo=20 x=0.5, lo=20 x=0.8, lo=30 x=0.8 |

**By the proposed rule, nothing qualifies to be built.** Rule 1 fails for every breadth
scenario, because T0 found no bucket whose interval excludes the average. The near-miss worth
the owner's attention is S3a, "partly to cash in a washout", which passes rules 2 to 5 on both
strategies. Before building S3a, the evidence would need:
- point-in-time Total Market membership;
- the switching tax the overlay ignores (about 3 to 4 switches a year, mostly short-term gains);
- a check that it isn't carried by two or three episodes.

No parameters are added to `docs/momentum-parameters-reference.md`, since none passed. The
build decision is the owner's.
