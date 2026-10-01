# Over-extension trim rule: cheap edge test before any engine work

Owner's idea, 2026-10-01. A local session runs this on real data and reports. The owner decides
whether to build it. Nothing here is a result yet.

## The idea

Momentum winners often run very fast just before they peak. Proposed rule: if a held stock rose
more than X% (for example 30%) over the last 2 weeks, sell 50% of it. Put that money somewhere
else.

## Why this needs a careful test

- **There is a real basis.** Very short-term winners partly give back gains. That is why
  standard momentum skips the most recent month. Indian small and mid caps also see frequent
  sharp, short-lived spikes.
- **The hindsight trap.** Looking at the top stocks before their peak will always show fast
  run-ups. The question that matters is the reverse: of all fast run-ups, how many were
  followed by weak returns? Many spikes are the start of a re-rating (results, orders, sector
  news) and keep going.
- **Momentum profits are concentrated.** A few very large winners carry most of the return.
  Trimming 50% of the stock that later triples can cost more than many small saves.
- **Survivorship bias.** Broad Momentum's universe is today's 755 names applied backwards
  (TODO 3.9.25). That removes stocks that spiked, collapsed and left the index, which are
  exactly the cases where trimming helps. So the bias works against the rule. The Nifty 50
  stock layer has point-in-time membership and is the primary evidence here.
- **Overlap with existing rules.** The position cap (15% per stock in Broad, 35% in ETF, trim
  band 5 points) already trims some spikes. Report how often the cap trimmed the same position
  within 2 weeks of an event.
- **The engine would buy it back.** In the buffer rule, cash is split equally across the current
  top N, including holdings. A trimmed stock still in the top N gets topped up at once. The
  `no_buy` mask does not block top-ups of held names (`engine.py`, `_Sim.top_names`, around
  line 470). A real implementation needs a cooldown on top-ups. This test assumes one.
- **Tax.** A trim realises short-term gains: 20% plus 4% cess on equity.

## Lessons carried over from the breadth test (TODO 3.9.24)

- Reuse the helpers in `packages/momentum-backtesting/scripts/breadth_regime_tests.py`:
  `block_bootstrap_means`, `weekly_marks`, `run_etf_base`, `run_broad_base`, `windows`,
  `episode_dd`, `metrics_from_returns`. Do not copy them. Import them or move them into a
  shared module.
- Shipped Broad Momentum skips 38% of weeks (the `enough` gate). Use `weekly_marks` to fill
  them. A skipped week cannot trade, so count separately the events that land on skipped weeks.
- Report every grid cell, not only the best.

## Strategies (6)

Chosen to span the configuration space, not because they had the highest returns. Picking the
best-returning configs and then tuning a rule on them double-counts luck.

| ID | Dataset | Settings | Role |
|---|---|---|---|
| C1 | Nifty 50 stocks (point-in-time) | defaults: top 5, exit 10, buffer, wait | **Primary evidence** |
| C2 | Nifty 50 stocks | as C1 with `entry="make_room"` | Primary |
| C3 | Broad Momentum | shipped defaults, category mode on | Secondary (survivorship-biased) |
| C4 | Broad Momentum | category mode off, top 10, exit 20 | Secondary |
| C5 | Broad Momentum | `entry="make_room"`, coverage floor 0.25 | Secondary |
| C6 | ETF | `live_config.toml` | Control. Indices rarely move 30% in 2 weeks, so use the ETF thresholds below |

For Nifty 50 stocks, use the same path `api.py` uses for the stock dataset.

## Event definition (no lookahead)

At Friday close `t`, for every position held since at least `t-2`:

- `r2 = P[t] / P[t-2] - 1`, using the adjusted weekly close the engine values the position at.
- Triggers (each tested separately):
  - absolute: `r2 >= X`, with X in {20%, 30%, 40%} for stocks and {8%, 12%} for ETFs;
  - volatility-scaled: `r2 / (26-week weekly vol x sqrt(2)) >= z`, with z in {3, 4}. A 30% move
    is ordinary for a small cap and extreme for a large cap.
- Sensitivity only: the same with a 1-week and a 4-week window.
- One event per position per 4 weeks, so a long run-up counts once.
- The trim would trade at close `t` (the engine's Friday-close assumption).

Sanity check: list the 20 largest `r2` events with their corporate-action events. A large jump
can be a data artefact (a missed consolidation or demerger adjustment, see TODO 3.9.21).

## Measurements

### M1. Forward returns after an event (the core test)

For each event, measure the stock's forward return over 1, 2, 4, 8 and 13 weeks, and until the
engine actually sold it. Compare with where the trimmed money would have gone:

- A. the liquid fund;
- B. the portfolio's other holdings at `t`, equal-weighted;
- C. the best-ranked stock not held at `t`.

`excess = alternative return - stock return`. A positive excess means trimming helped.

Report per strategy and trigger:
- event count, distinct event weeks, distinct stocks;
- mean and median excess, hit rate;
- a 95% block-bootstrap interval, computed over event weeks (average events within a week first)
  with 4-week blocks;
- the same for held stock-weeks without an event, as a baseline. Is a spike special, or do
  held momentum stocks just behave like this?

### M2. The right tail

- Share of events where the stock rose another 50% or more within 13 weeks.
- Mean excess with the 5 best and the 5 worst events removed. The sign must survive both.

### M3. The hindsight view the owner asked for, with base rates

For each strategy, take the 20 biggest winning closed trades. For each, print the 2-week returns
in the weeks before the highest close during the hold, and mark any trigger hits.

Then build the base-rate table:

| | Peak within the next 4 weeks | No peak within the next 4 weeks |
|---|---|---|
| Trigger hit | a | b |
| No trigger | c | d |

"Peak" means the highest close during that holding period. The rule only has value if
`a/(a+b)` is clearly above `c/(c+d)`.

### M4. Cheap portfolio-level estimate

For each event: `edge = 0.5 x position weight at t x excess over H weeks`, for H in {4, 8}.
Subtract `0.5 x weight x 2 x cost_pct` for the round trip. Sum per year to get an approximate
CAGR impact.

Show two tax views. Gross. Conservative: subtract 20.8% of the trimmed half's gain as if it were
an extra cost. Also report the share of events within 13 weeks of the 365-day mark, where
trimming gives up a chance of long-term tax treatment.

This ignores second-order effects: cap interactions, re-ranking, and compounding.

### M5. Hold-out

Choose the trigger using 2017 to 2021 events only. Report its result on 2022 onwards untouched.

## Proposed decision rule (the owner decides)

Build the rule in the engine only if all of these hold:

1. On C1 (point-in-time), the 4-week and 8-week excess is positive, with an interval excluding
   zero, and at least 20 distinct event weeks.
2. The same sign appears in both halves (2017 to 2021, 2022 onwards) and in at least 4 of the 6
   strategies.
3. The M4 estimate is positive after costs under the conservative tax view.
4. The sign survives removing the top 5 and the bottom 5 events.
5. In M3, `a/(a+b)` is clearly above `c/(c+d)`.

If it passes, the engine design is: a new TRIM step in `_run_buffer` after the cap trim, plus a
top-up cooldown of k weeks for the trimmed name, both opt-in and byte-identical by default.

## Deliverables

1. `packages/momentum-backtesting/scripts/overextension_trim_tests.py`, runnable with `uv run`.
   Unit tests for the event detection, the one-event-per-4-weeks rule, and the excess
   arithmetic, on a hand-built frame.
2. CSVs in `data/backtests/trim/` (gitignored).
3. A Results section appended to this file, with a plain-English answer to: does a fast 2-week
   run-up predict weaker returns, and is trimming worth it after tax?
4. TODO.md row 3.9.26 updated in the same commit. No engine changes.

## Results

Run 2026-10-01 on branch `claude/momentum-backtest-improvements-7jqye2` (base 3700e5e) with
`packages/momentum-backtesting/scripts/overextension_trim_tests.py`: `sanity`, then `c1`, then
`broad`. Data: the shared `~/TradingData` catalog plus `data/`, stock frame to 2026-09-25. CSVs
are in `data/backtests/trim/` (gitignored). Every backtest is an unchanged
`engine.run_backtest`; the trim is measured, never simulated.

### Scope change: Broad Momentum, not the Nifty 50 layer

The spec named C1 (point-in-time Nifty 50 stocks) as the primary evidence. The run on C1 showed
it cannot carry the test:

- **The triggers almost never fire.** Over 2017–2026 there were 6 events at 2w ≥ 20%, 1 at
  ≥ 30%, 0 at ≥ 40%, 6 at z ≥ 3 and 2 at z ≥ 4. No 4-week or 8-week interval excludes zero
  (`m1_c1.csv`). Large caps rarely
  rise 20% in 2 weeks, and C1 rarely holds a name 3 weeks in a row.
- **C1 itself loses money:** CAGR −2.4%, max drawdown −53%, against +12.6% for the Nifty 50
  TRI.
  - This is not a construction error. The shipped Stock-tab defaults (top 10, exit 20, from
    2012) give +1.7%. Switching off debt in the ranking or using flat costs changes little.
  - C1 turns over about 57 buys a year, typically holding 3 names at the 35% cap with 30% idle.
  - This fits TODO 3.6: that data layer has had only a light review.
- **The api.py Stock path is broken against the shared database.**
  `stocks/ui_data.load_stock_dataset` raises KeyError, because the catalog has stock prices
  but not the three Nifty benchmark TRI series. The script uses the same function with its
  database branch switched off. The catalog's stock prices and membership were checked
  identical to the files (zero differences across 95 names).

The owner then asked to run the test on Broad Momentum instead. So **C3 (shipped Broad) is the
primary evidence here**, C4 and C5 are the cross-checks, and C6 (ETF) stays as the spec's
control. C1 and C2 were not analysed further.

Two caveats carry over from TODO 3.9.25:

- **Survivorship bias.** The Broad universe is today's 755 names applied backwards. Stocks
  that spiked, collapsed and left are missing, and those are the cases where trimming helps.
  The bias therefore works **against** the rule. A negative result here is not proof that the
  rule fails on an unbiased universe.
- **Skipped weeks.** C3 skips 193 weeks and C5 skips 310, because the engine's `enough` gate
  drops them. An event on a skipped week cannot trade, so it is excluded from M1 to M5 and
  counted in the "On skipped weeks" column. In C5 more events fall on skipped weeks than on
  tradable ones.

| Strategy | Span | CAGR | Max DD | Skipped weeks |
|---|---|---:|---:|---:|
| C3 Broad, shipped defaults | 2017-01-13 to 2026-09-25 | 37.5% | −23.6% | 193 |
| C4 Broad, category mode off, top 10/exit 20 | 2017-01-06 to 2026-09-25 | 41.8% | −40.4% | 0 |
| C5 Broad, entry make_room, coverage floor 0.25 | 2017-01-06 to 2026-09-11 | 35.0% | −27.5% | 310 |
| C6 ETF, live_config.toml (control, ETF thresholds) | 2017-01-06 to 2026-10-02 | 25.5% | −30.5% | 0 |

Method notes:

- An event needs the position held after trades at t−2, t−1 and t. If the engine sells the
  whole position at t anyway, there is nothing to trim.
- The volatility scale uses the 26 weekly returns ending at t−2, so the spike does not inflate
  its own yardstick.
- There is one event per holding spell per 4 weeks. Intervals are 4-week block bootstraps over
  event weeks, averaging within a week first. No interval is reported below 5 event weeks.

### Sanity check: the 20 largest 2-week rises in held positions

None has a corporate action from 3 weeks before to 1 week after, either in the Total Market
detector or in the Nifty 50 feed. The price paths are continuous, and most are recognisable
real rallies: IRFC and IFCI in Jan 2024, RVNL in May 2023, GPIL in Dec 2017, Tanla in Nov 2020.
All 20 are in the Broad strategies. One name to watch: `PCJEWELLER#9`, which the mechanical
split detector has cut into 9 segments.

| Week | Asset | 2-week rise | Held in | Close t−3 … t+4 | Corporate action nearby |
|---|---|---:|---|---|---|
| 2021-02-26 | HINDCOPPER#3 | +106% | C4 | 71.0 72.8 86.0 149.8 142.1 133.6 125.8 123.2 | none |
| 2024-02-02 | IFCI | +88% | C5,C3 | 30.9 32.1 52.8 60.3 62.0 54.4 46.9 45.5 | none |
| 2023-05-05 | RVNL#2 | +83% | C4 | 73.5 77.5 107.5 141.7 120.4 116.2 115.8 118.0 | none |
| 2022-07-22 | PCJEWELLER#9 | +76% | C4 | 23.8 31.1 47.5 54.7 46.9 54.7 60.5 69.2 | none |
| 2022-02-04 | SHARDACROP | +73% | C5 | 363.1 379.3 601.7 657.9 558.6 561.0 541.0 546.2 | none |
| 2024-01-26 | IFCI | +71% | C3,C5 | 29.8 30.9 32.1 52.8 60.3 62.0 54.4 46.9 | none |
| 2020-11-27 | TANLA#2 | +63% | C4 | 348.8 376.4 480.2 612.6 744.6 859.7 665.4 662.0 | none |
| 2019-07-12 | REFEX | +63% | C5,C3 | 79.8 78.2 99.8 127.2 120.3 110.2 85.4 80.7 | none |
| 2022-02-11 | DBREALTY#2 | +62% | C4 | 74.2 78.6 100.2 127.7 107.8 92.0 109.8 106.7 | none |
| 2021-07-02 | TTML#2 | +62% | C4 | 23.9 30.4 38.6 49.1 46.5 43.9 37.8 38.0 | none |
| 2021-06-25 | TTML#2 | +62% | C4 | 18.9 23.9 30.4 38.6 49.1 46.5 43.9 37.8 | none |
| 2019-03-01 | REFEX | +61% | C5,C3 | 22.1 21.7 27.6 35.0 42.5 44.4 44.4 37.9 | none |
| 2021-06-18 | TTML#2 | +61% | C4 | 14.9 18.9 23.9 30.4 38.6 49.1 46.5 43.9 | none |
| 2021-06-18 | RPOWER#4 | +59% | C4 | 8.2 9.9 12.5 15.8 15.1 14.9 14.1 13.0 | none |
| 2024-01-19 | IRFC | +59% | C5,C3 | 99.3 100.8 113.4 160.2 173.8 168.9 153.7 155.4 | none |
| 2017-12-22 | GPIL | +59% | C4,C3 | 168.5 187.8 217.1 298.6 343.2 410.8 473.9 493.9 | none |
| 2021-01-22 | TTML#2 | +59% | C4 | 7.8 8.9 11.2 14.2 17.1 21.8 17.0 17.4 | none |
| 2017-12-29 | GPIL | +58% | C4,C3 | 187.8 217.1 298.6 343.2 410.8 473.9 493.9 598.0 | none |
| 2021-07-02 | RTNPOWER | +58% | C4,C3 | 4.9 5.6 7.0 8.8 7.7 7.7 7.1 6.5 | none |
| 2017-11-10 | RAIN | +58% | C4 | 216.8 245.7 309.2 387.5 330.1 327.5 345.2 378.4 | none |

### M1. Forward returns after an event

Excess means the alternative's return minus the stock's. **Positive means trimming would have
helped.** The alternatives are:

- A: the liquid fund.
- B: the other holdings at t, equal-weighted. This is where a buffer-rule trim with a top-up
  cooldown would actually put the money, so it is the alternative the decision rule uses.
- C: the best-ranked stock not held.

\* marks an interval that excludes zero. The baseline is held stock-weeks with no trigger.

| Strategy | Trigger | Events (tradable) | On skipped weeks | Event weeks | Names | 4w A | 4w B | 4w C | 8w B [95% CI] | 8w B hit rate | Until sold B | Baseline 8w B |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|
| C3 | 2w r>=20% | 53 | 27 | 49 | 39 | -5.9%\* | -3.2% | +2.2% | -5.5% [-16.4%, +3.6%] | 55% | -4.3% | -0.8% |
| C3 | 2w r>=30% | 17 | 8 | 17 | 13 | -9.9% | -7.4% | -9.0% | -13.9% [-38.2%, +5.0%] | 47% | -7.1% | -0.4% |
| C3 | 2w r>=40% | 10 | 2 | 10 | 10 | -10.6% | -9.1% | -4.7% | -16.8% [-56.8%, +12.0%] | 50% | -3.5% | -0.8% |
| C3 | 2w z>=3 | 25 | 17 | 22 | 23 | -5.3% | -3.0% | +2.8% | -1.4% [-11.7%, +7.1%] | 52% | +1.7% | -0.9% |
| C3 | 2w z>=4 | 12 | 5 | 11 | 12 | -6.7% | -4.3% | -2.0% | -5.2% [-24.9%, +8.1%] | 42% | -6.1% | -0.8% |
| C4 | 2w r>=20% | 167 | 0 | 139 | 109 | -6.0%\* | -1.9% | -2.9% | -2.7% [-7.1%, +1.5%] | 53% | -1.0% | -0.1% |
| C4 | 2w r>=30% | 82 | 0 | 76 | 58 | -5.6%\* | -2.1% | -1.8% | -2.5% [-8.7%, +2.6%] | 50% | -0.4% | -0.5% |
| C4 | 2w r>=40% | 34 | 0 | 34 | 26 | -5.4% | -0.3% | -2.4% | +1.0% [-8.4%, +9.6%] | 59% | -0.2% | -1.0% |
| C4 | 2w z>=3 | 65 | 0 | 59 | 58 | -3.0% | -0.9% | -1.1% | -2.1% [-8.6%, +3.8%] | 52% | +0.1% | -0.4% |
| C4 | 2w z>=4 | 23 | 0 | 21 | 21 | -8.4%\* | -5.7% | -4.5% | -10.0% [-21.3%, -0.7%]\* | 30% | -0.3% | -0.2% |
| C5 | 2w r>=20% | 29 | 38 | 28 | 24 | -2.7% | +0.3% | +8.2% | +1.4% [-8.4%, +9.3%] | 59% | -2.0% | +0.1% |
| C5 | 2w r>=30% | 11 | 15 | 11 | 8 | -3.7% | -0.6% | +0.8% | -2.6% [-19.6%, +13.2%] | 45% | -14.0% | +0.5% |
| C5 | 2w r>=40% | 7 | 6 | 7 | 6 | -4.6% | -2.8% | +7.8% | +3.5% [-17.3%, +20.1%] | 57% | +0.2% | +0.3% |
| C5 | 2w z>=3 | 12 | 21 | 12 | 10 | +0.1% | +4.3% | +10.4%\* | +7.4% [-0.8%, +16.2%] | 67% | +4.9% | +0.1% |
| C5 | 2w z>=4 | 5 | 6 | 5 | 5 | +6.6% | +9.0%\* | +18.8%\* | +10.6% [-3.1%, +28.9%] | 80% | +10.6%\* | +0.4% |
| C6 | 2w r>=8% | 109 | 0 | 85 | 18 | -2.8%\* | -1.1% | -1.7% | -2.0% [-4.3%, -0.1%]\* | 45% | -3.4% | +0.1% |
| C6 | 2w r>=12% | 38 | 0 | 35 | 11 | -5.2%\* | -3.1%\* | -3.5% | -4.7% [-9.8%, -0.8%]\* | 32% | -1.4% | +0.0% |
| C6 | 2w z>=3 | 35 | 0 | 28 | 15 | -0.6% | +0.5% | +0.8% | -1.6% [-5.0%, +1.6%] | 40% | -0.5% | +0.0% |
| C6 | 2w z>=4 | 7 | 0 | 6 | 4 | -1.0% | -0.0% | +3.4% | -3.8% [-10.8%, +4.0%] | 29% | -0.7% | +0.0% |

**Sensitivity (1-week and 4-week windows, alternative B).**
- C3 is mixed at a 1-week window: +2% to +4% at r ≥ 20% and z ≥ 3 (32–34 events), −6% to −8%
  at z ≥ 4. It is mostly negative at a 4-week window.
- C4 is mostly negative at both windows.
- C5 is positive at both, on 3 to 26 events per cell.
- C6 is mostly negative.
- Only 5 of the 76 sensitivity cells (alternative B, 4 and 8 weeks) have an interval excluding
  zero. The
full table is in `m1_sensitivity_1w_4w.csv`.

### M2. The right tail

| Strategy | Trigger | Events | Rose another 50%+ within 13w | 4w B mean | without best 5 | without worst 5 | 8w B mean | without best 5 | without worst 5 |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| C3 | 2w r>=20% | 54 | 13% | -3.0% | -5.4% | +2.1% | -4.8% | -8.5% | +4.4% |
| C3 | 2w r>=30% | 17 | 29% | -7.4% | -17.5% | +7.2% | -13.9% | -28.9% | +7.6% |
| C3 | 2w r>=40% | 10 | 30% | -9.1% | -34.8% | +16.6% | -16.8% | -53.9% | +20.3% |
| C3 | 2w z>=3 | 26 | 12% | -2.8% | -7.4% | +3.8% | -1.2% | -7.1% | +5.3% |
| C3 | 2w z>=4 | 12 | 8% | -4.1% | -14.0% | +7.0% | -4.7% | -18.9% | +9.5% |
| C4 | 2w r>=20% | 170 | 22% | -1.9% | -3.0% | +0.4% | -2.6% | -4.1% | +0.3% |
| C4 | 2w r>=30% | 82 | 30% | -2.7% | -5.0% | +0.9% | -3.2% | -5.9% | +1.5% |
| C4 | 2w r>=40% | 34 | 35% | -0.3% | -5.6% | +7.5% | +1.0% | -5.8% | +10.1% |
| C4 | 2w z>=3 | 66 | 21% | -0.4% | -2.2% | +2.8% | -0.9% | -4.1% | +3.9% |
| C4 | 2w z>=4 | 23 | 17% | -5.4% | -11.4% | +2.4% | -9.1% | -16.3% | -0.5% |
| C5 | 2w r>=20% | 29 | 10% | +0.6% | -4.0% | +6.6% | +1.9% | -4.3% | +9.9% |
| C5 | 2w r>=30% | 11 | 36% | -0.6% | -15.3% | +14.6% | -2.6% | -23.2% | +16.9% |
| C5 | 2w r>=40% | 7 | 43% | -2.8% | -36.6% | +19.8% | +3.5% | -21.7% | +29.1% |
| C5 | 2w z>=3 | 12 | 17% | +4.3% | -4.1% | +13.5% | +7.4% | -3.9% | +17.5% |
| C5 | 2w z>=4 | 5 | 0% | +9.0% | — | — | +10.6% | — | — |
| C6 | 2w r>=8% | 109 | 4% | -1.2% | -1.7% | -0.3% | -2.0% | -2.8% | -0.3% |
| C6 | 2w r>=12% | 38 | 8% | -3.1% | -4.9% | -0.5% | -4.7% | -7.4% | -1.2% |
| C6 | 2w z>=3 | 35 | 0% | +0.4% | -1.5% | +2.6% | -1.6% | -4.0% | +1.4% |
| C6 | 2w z>=4 | 7 | 0% | -0.8% | -9.5% | +6.8% | -4.3% | -14.8% | +4.9% |

### M3. Hindsight view and base rates

**Top 20 winning trades per strategy.** The median trade returned +74% (C3), +80% (C4), +69%
(C5) and +47% (C6). A trigger fired in the weeks before the peak in 14 of 20 (C3), 20 of 20
(C4), 14 of 20 (C5) and 12 of 20 (C6). That is the owner's observation, and it holds. But the
trigger usually fired well before the top. Two examples:

- GPIL: 2w +59% on 2017-12-22 at a close of 298.6, then +58%, +38% and +38% in the following
  weeks, peaking on 2018-01-26 near 600.
- IRFC: +28% on 2023-12-22, peaking on 2024-01-26.

Trimming half at the first trigger would have given up most of these moves. The full lists are
in `m3_top20.csv`.

**Base rates.** "Peak" means the highest close of that holding spell, at t to t+4. Closed
spells only.

| Strategy | Trigger | a: hit, peak ≤4w | b: hit, no peak | c: no hit, peak | d: no hit, no peak | P(peak \| hit) | P(peak \| no hit) | Fisher p (one-sided) |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| C3 | 2w r>=20% | 59 | 31 | 465 | 786 | 0.66 | 0.37 | 0.0000 |
| C3 | 2w r>=30% | 25 | 10 | 499 | 807 | 0.71 | 0.38 | 0.0001 |
| C3 | 2w r>=40% | 14 | 4 | 510 | 813 | 0.78 | 0.39 | 0.0009 |
| C3 | 2w z>=3 | 31 | 9 | 493 | 808 | 0.78 | 0.38 | 0.0000 |
| C3 | 2w z>=4 | 9 | 6 | 515 | 811 | 0.60 | 0.39 | 0.0817 |
| C4 | 2w r>=20% | 239 | 4 | 840 | 103 | 0.98 | 0.89 | 0.0000 |
| C4 | 2w r>=30% | 113 | 2 | 966 | 105 | 0.98 | 0.90 | 0.0010 |
| C4 | 2w r>=40% | 50 | 1 | 1029 | 106 | 0.98 | 0.91 | 0.0455 |
| C4 | 2w z>=3 | 82 | 2 | 997 | 105 | 0.98 | 0.90 | 0.0130 |
| C4 | 2w z>=4 | 27 | 2 | 1052 | 105 | 0.93 | 0.91 | 0.5053 |
| C5 | 2w r>=20% | 30 | 10 | 246 | 267 | 0.75 | 0.48 | 0.0007 |
| C5 | 2w r>=30% | 12 | 3 | 264 | 274 | 0.80 | 0.49 | 0.0161 |
| C5 | 2w r>=40% | 10 | 1 | 266 | 276 | 0.91 | 0.49 | 0.0054 |
| C5 | 2w z>=3 | 14 | 4 | 262 | 273 | 0.78 | 0.49 | 0.0139 |
| C5 | 2w z>=4 | 5 | 1 | 271 | 276 | 0.83 | 0.50 | 0.1073 |
| C6 | 2w r>=8% | 64 | 113 | 656 | 1748 | 0.36 | 0.27 | 0.0081 |
| C6 | 2w r>=12% | 16 | 41 | 704 | 1820 | 0.28 | 0.28 | 0.5392 |
| C6 | 2w z>=3 | 9 | 34 | 711 | 1827 | 0.21 | 0.28 | 0.8873 |
| C6 | 2w z>=4 | 1 | 7 | 719 | 1854 | 0.12 | 0.28 | 0.9272 |

In Broad, a trigger week **is** about twice as likely to be within 4 weeks of the holding's
peak: C3 0.66–0.78 vs 0.37–0.39, with p < 0.001 for most triggers. That passes rule 5. But
being near the peak in time is not the same as a weak forward return. "Peak within 4 weeks"
includes cases where the stock keeps rising for another 4 weeks. After the peak, the engine
itself sells the name within a few weeks. So the timing signal is real, but it does not turn
into money (M1, M4). For C4 the table is uninformative: about 90% of all held weeks are within
4 weeks of the spell peak.

### M4. Portfolio-level estimate

Points of CAGR per year, from the sum over tradable events of
0.5 × weight × excess B − round-trip cost. The after-tax view also subtracts 20.8% of the
trimmed half's gain since entry.

| Strategy | Trigger | Events | Gross, 4w (pts/yr) | After tax, 4w | Gross, 8w | After tax, 8w | Mean weight | Cap trim within 2w | Within 13w of LTCG |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| C3 | 2w r>=20% | 54 | -1.72 | -4.60 | -2.53 | -5.41 | 15% | 22% | 4% |
| C3 | 2w r>=30% | 17 | -1.15 | -2.38 | -1.99 | -3.22 | 16% | 41% | 0% |
| C3 | 2w r>=40% | 10 | -0.68 | -1.44 | -1.09 | -1.85 | 18% | 40% | 0% |
| C3 | 2w z>=3 | 26 | -0.79 | -2.04 | -0.39 | -1.64 | 15% | 23% | 0% |
| C3 | 2w z>=4 | 12 | -0.51 | -1.15 | -0.52 | -1.16 | 16% | 25% | 0% |
| C4 | 2w r>=20% | 170 | -3.00 | -9.50 | -3.63 | -10.14 | 14% | 7% | 0% |
| C4 | 2w r>=30% | 82 | -2.34 | -6.32 | -2.57 | -6.55 | 15% | 12% | 0% |
| C4 | 2w r>=40% | 34 | -0.50 | -2.88 | -0.22 | -2.60 | 17% | 32% | 0% |
| C4 | 2w z>=3 | 66 | -0.33 | -3.61 | -0.40 | -3.67 | 15% | 14% | 0% |
| C4 | 2w z>=4 | 23 | -1.22 | -2.52 | -1.94 | -3.24 | 16% | 17% | 0% |
| C5 | 2w r>=20% | 29 | +0.09 | -1.21 | +0.43 | -0.88 | 15% | 10% | 3% |
| C5 | 2w r>=30% | 11 | -0.01 | -0.73 | -0.10 | -0.82 | 17% | 36% | 0% |
| C5 | 2w r>=40% | 7 | -0.09 | -0.65 | +0.33 | -0.22 | 19% | 43% | 0% |
| C5 | 2w z>=3 | 12 | +0.48 | -0.24 | +0.93 | +0.22 | 16% | 25% | 0% |
| C5 | 2w z>=4 | 5 | +0.47 | +0.14 | +0.57 | +0.24 | 18% | 20% | 0% |
| C6 | 2w r>=8% | 109 | -2.40 | -8.86 | -3.53 | -9.98 | 19% | 5% | 6% |
| C6 | 2w r>=12% | 38 | -1.60 | -4.23 | -2.51 | -5.14 | 19% | 13% | 0% |
| C6 | 2w z>=3 | 35 | +0.39 | -1.53 | -0.45 | -2.37 | 18% | 9% | 0% |
| C6 | 2w z>=4 | 7 | -0.12 | -0.51 | -0.37 | -0.75 | 13% | 0% | 0% |

### M5. Hold-out, plus the two halves

For each strategy, the trigger is chosen on 2017–2021 events (best mean 4w/8w excess, at least
10 event weeks) and then reported on 2022 onwards, untouched.

| Strategy | Trigger chosen on 2017–2021 | In-sample 4w / 8w B | 2022+ event weeks | 2022+ 4w B [CI] | 2022+ 8w B [CI] |
|---|---|---|---:|---|---|
| C3 | 2w r>=20% | -6.7% / -12.4% | 27 | -0.4% [-5.49%, +4.86%] | +0.2% [-8.30%, +7.03%] |
| C4 | 2w r>=40% | -5.2% / -1.5% | 11 | +9.9% [+0.16%, +18.10%] | +6.1% [-6.84%, +20.12%] |
| C5 | 2w r>=20% | -4.3% / -8.8% | 13 | +5.5% [-0.09%, +11.96%] | +13.2% [+5.95%, +19.86%] |
| C6 | 2w z>=3 | +1.8% / +1.6% | 16 | -0.4% [-3.89%, +2.71%] | -4.1% [-8.26%, -0.08%] |

In C3 and C4, every "chosen" trigger was **negative** in-sample. It was simply the least bad. The
halves show a pattern across C3, C4 and C5: trimming **hurt** on average in 2017–2021 (only C4
at r ≥ 20% excludes zero) and was roughly neutral to positive from 2022. The sign is not
stable.

| Strategy | Trigger | 2017–2021: weeks, 4w B, 8w B | 2022+: weeks, 4w B, 8w B |
|---|---|---|---|
| C3 | 2w r>=20% | 22, -6.7%, -12.4% | 27, -0.4%, +0.2% |
| C3 | 2w r>=30% | 8, -19.1%, -28.1% | 9, +2.9%, -1.3% |
| C3 | 2w r>=40% | 4, -38.0%, -54.6% | 6, +10.2%, +8.3% |
| C3 | 2w z>=3 | 8, -10.1%, -5.1% | 14, +0.7%, +0.7% |
| C3 | 2w z>=4 | 4, -11.9%, -10.9% | 7, +0.1%, -1.9% |
| C4 | 2w r>=20% | 72, -5.8%, -6.2% | 67, +2.2%, +1.0% |
| C4 | 2w r>=30% | 42, -4.9%, -5.5% | 34, +1.4%, +1.1% |
| C4 | 2w r>=40% | 23, -5.2%, -1.5% | 11, +9.9%, +6.1% |
| C4 | 2w z>=3 | 29, -4.0%, -6.0% | 30, +2.1%, +1.6% |
| C4 | 2w z>=4 | 11, -8.8%, -13.8% | 10, -2.3%, -5.8% |
| C5 | 2w r>=20% | 15, -4.3%, -8.8% | 13, +5.5%, +13.2% |
| C5 | 2w r>=30% | 7, -10.5%, -16.3% | 4, +16.7%, +21.4% |
| C5 | 2w r>=40% | 4, -15.4%, -6.9% | 3, +14.0%, +17.4% |
| C5 | 2w z>=3 | 6, +2.4%, +6.1% | 6, +6.2%, +8.6% |
| C5 | 2w z>=4 | 2, +4.8%, +9.0% | 3, +11.8%, +11.7% |
| C6 | 2w r>=8% | 34, +0.5%, +0.8% | 51, -2.2%, -3.9% |
| C6 | 2w r>=12% | 15, -1.3%, -2.5% | 20, -4.4%, -6.4% |
| C6 | 2w z>=3 | 12, +1.8%, +1.6% | 16, -0.4%, -4.1% |
| C6 | 2w z>=4 | 1, +7.6%, -0.8% | 5, -1.5%, -4.4% |

### Decision rule (2-week triggers, C3 primary)

The rule was adapted to the owner's instruction:

- Rules 1 and 3–5 are judged on C3 instead of C1.
- Rule 2 needs the same sign in both C3 halves and in at least 2 of the 3 Broad strategies,
  instead of 4 of 6.
- Rule 5 is read as "clearly above": P(peak | hit) at least 1.5 × P(peak | no hit) with Fisher
  p < 0.05.

| Trigger | R1 | R2 | Broad strategies positive (4w & 8w) | R3 | R4 | R5 | Passes |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| 2w r>=20% | ✗ | ✗ | 1 of 3 | ✗ | ✗ | ✓ | ✗ |
| 2w r>=30% | ✗ | ✗ | 0 of 3 | ✗ | ✗ | ✓ | ✗ |
| 2w r>=40% | ✗ | ✗ | 0 of 3 | ✗ | ✗ | ✓ | ✗ |
| 2w z>=3 | ✗ | ✗ | 1 of 3 | ✗ | ✗ | ✓ | ✗ |
| 2w z>=4 | ✗ | ✗ | 1 of 3 | ✗ | ✗ | ✗ | ✗ |

**Nothing passes.** The only rule that passes is rule 5, the base-rate test, and only for four
of the five triggers. On C3 the 4-week and 8-week excess on alternative B is negative at every
trigger, and no interval excludes zero. In
the after-tax M4 view, every C3 and C4 trigger costs between 1.1 and 10.1 CAGR points a year.

### Plain-English answer

**Does a fast 2-week run-up predict weaker returns?** Not in a way you can trade on.
- In shipped Broad Momentum, stocks that had just risen 20–40% in two weeks went on to do
  *better* than the rest of the portfolio over the next 4–8 weeks: by 3 to 17 points on
  average, depending on the threshold. Trimming them would have cost money.
- That average is driven by the big winners. Removing the 5 best events makes trimming look
  even worse. Removing the 5 worst makes it look good. So the result rests on a handful of
  stocks either way.
- A spike week *is* more often close to the eventual top: two-thirds of the time vs one-third
  for an ordinary week. That's why the hindsight view looks so convincing. But the top is often
  still 2 to 6 weeks and another 20–60% away. The engine's own exit rule already catches the
  roll-over afterwards.
- The cross-checks agree:
  - Broad with category mode off (C4) shows the same thing, with more events.
  - The ETF control (C6) shows it more strongly: trimming an ETF after an 8–12% two-week rise
    hurt. The interval excludes zero at both horizons for 12%, and at 8 weeks for 8%.
  - Only C5 (make_room, coverage floor 0.25) leans the other way, on 5 to 12 events. C5 also
    skips 61% of its weeks.

**Is trimming worth it after tax?** No.
- Before tax it already costs C3 0.4 to 2.5 CAGR points a year.
- Selling half a winner also realises short-term gains at 20.8%. That brings the cost to 1.1–5.4
  points a year for C3 and up to 10 for C4.
- The 15% position cap already trims many of these spikes. 22–41% of C3 events had a cap trim
  within 2 weeks.

**Caveat:** survivorship bias works against the rule, and the 2022-onwards half is roughly
neutral to positive. If the owner wants to revisit this, the honest next step is a
point-in-time Total Market universe (TODO 3.9.25), not tuning thresholds on this one. No
parameters are added to the parameter reference. The build decision is the owner's.
