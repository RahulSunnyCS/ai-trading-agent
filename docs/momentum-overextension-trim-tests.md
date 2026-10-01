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

(Empty until the local run.)
