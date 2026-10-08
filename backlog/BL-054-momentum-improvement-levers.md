# BL-054 — Six levers to improve the Broad Momentum strategies' return and falls

| | |
|---|---|
| **Priority** | P1 — the owner wants the strategies improved before real money follows them |
| **Status** | In progress |
| **Type** | research (+ opt-in engine features: daily stop, inverse-vol sizing, residual score) |
| **Area** | momentum |
| **Created** | 2026-10-09 |
| **Depends on** | BL-053 (the 11 strategies, the stop machinery), BL-010 (criteria, scored curves) |
| **TODO.md row** | 3.13.7 |

## Context

BL-053 killed the weekly stop-loss. The owner (2026-10-08) agreed to test the five improvement
ideas from its write-up and added one more: a **daily** stop, checked every evening on the close
and sold the next morning at the open. The owner asked what else is needed and how bad the 0.69
probability of backtest overfitting is.

**What 0.69 means.** Picking the best config on half the history lands below the median config
on the other half 69% of the time (a coin flip would be 50%), and below the index fund in 45% of
splits; the slope is -1.02, so the better a config looked, the worse it then did. It does not say
the family fails (82% of configs beat the index by 5 points); it says a config's rank tells
nothing about its future. Consequences for this item: every lever is judged on the typical result
across all 11 strategies, never on its best cell; rules are committed before the run; and a lever
has to hold on years it was not chosen on.

**What else is needed** (added to the plan): results judged after tax at the owner's Rs 5 lakh,
since tax is the largest drag measured (6-12 points); a split sample (levers chosen on
FY2018-FY2022, read once on FY2023-FY2026); fills at realistic times; every cell counted as a
trial; the daily stop read from the exchange's own adjusted previous close so a split never
fires it, and blocked by a lower-circuit lock. The live signal is not touched by this item.

## Goal

For each lever, a committed pass/kill verdict after tax, and an adopt/not-adopt line. Engine
features stay opt-in and off by default.

## Out of scope

Combining levers; a finer search; the dashboard; the weekly signal; the 2012-2016 hold-out.

## Plan

### Phase 0 — Pre-register (committed before any run)

The binding rule is `packages/momentum-backtesting/search_spaces/bl054_criteria.json`. In words:

| Lever | What is tested | Pass on FY2018-FY2022, after tax at Rs 5 lakh |
|---|---|---|
| L1 cadence and tax | rebalance every 4 / 6 / 8 / 13 weeks, with and without holding a gain to long-term (`tax_hold_band` 2, 8 weeks) | median after-tax CAGR +1.5 pts or more, Ulcer no worse than +1 pt, CAGR not lower in 7 of 11 |
| L2 all phases at once | own Friday vs all Fridays as equal tranches | report only |
| L3 ETF blend | 75% and 50% Broad with the ETF rotation, pre-tax | at 75%: less pain in 7 of 11, CAGR change at least -2 |
| L4 daily stop | 20 / 25% below buy, 25 / 30% below peak, and pairs; sell next open; cash | less pain in 7 of 11, CAGR change at least -2, bad years not worse |
| L5 inverse-vol sizing | each pick sized by 1 / 26-week volatility | same as L4 |
| L6 residual momentum | rank on the return left after the market and sector move | same as L4 |

A lever that passes is read once on FY2023-FY2026 and adopted only if the pass holds there.
"Less pain" means Ulcer and worst fall both shallower. Where a lever sells between rebalances it
must pass at both fill timings.

### Phase 1 — Quick reads from stored curves (L2, L3)
- **Done when:** the two tables are in the result section.

### Phase 2 — Cadence and tax grid (L1)
- `scripts/bl054_levers.py l1`: 11 strategies x 4 cadences x 2 tax-hold settings, every phase,
  pre- and after-tax. Resumable.

### Phase 3 — Daily stop (L4)
- Engine: `Config.stop_granularity="daily"` with a daily move table (close / prevclose) and next
  open table passed to `run_backtest` (data, not Config, like the lock masks); same stop fields
  as BL-053; tests for no look-ahead, the next-open fill, a split day, a lower-circuit day.
- `scripts/bl054_levers.py l4`.

### Phase 4 — Inverse-vol sizing (L5)
- Engine: `Config.weight_by="inverse_vol"` in the buffer rule's split loop; tests.
- `scripts/bl054_levers.py l5`.

### Phase 5 — Residual momentum (L6)
- A new score in `categories/broad.py`'s ranking (point-in-time regressions); tests; run.

### Phase 6 — Verdicts
- `search_spaces/bl054_result.json`, this file's Result section, TODO row.

## Risks

- Six levers x cells is another search on the same ten years: the split sample and the
  typical-result rule are the guards, and every cell is logged as a trial.
- The daily stop depends on daily data quality (gaps, suspensions): a day with no bar is a day
  with no sale, and the Fyers top-up rows (prevclose = open) can under-read a move.
- Residual momentum is a new signal: if it does not pass it is dropped, not tuned.

## Log

- 2026-10-09 — created and started; owner agreed to all five levers and added the daily stop.
  Phase 0 committed before any run.
