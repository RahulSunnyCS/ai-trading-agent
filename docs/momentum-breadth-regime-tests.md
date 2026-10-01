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

(Empty until the local run.)
