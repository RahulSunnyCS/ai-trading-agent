# Pullback in a strong uptrend: validation plan

Owner's idea, 2026-10-02. Buy stocks that are strong on the long lookbacks (13, 26, 52 weeks),
have consolidated over the last 4 weeks (4-week momentum fell), and turned up again last week.
A local session runs this on real data and reports. The owner decides what to build. Nothing here
is a result yet.

## What earlier tests already say

| Source | Finding | What it means here |
|---|---|---|
| TODO 3.9.23, ETF | Dropping the 1-week lookback lost (median -1.6 CAGR). Skip-month (3-1/6-1/12-1) lost badly (-5.7) | On ETFs recent strength helps. This is mainly a stock idea. ETF is a control only |
| TODO 3.9.23, Broad (every week simulated, baseline 31.7% / 1.06 / -20.4%) | Weights 0,1,1,1,1 +2.8 median (64% of windows, fork caveat). One-week signal delay +4.1 (wins 89% / 96%). Every 2 weeks +5.0. Skip-month was never run on Broad | Waiting a week before buying helps on stocks. That fits short-term reversal, the same mechanism as this idea. The plan must check whether a pullback rule adds anything beyond the delay or cadence |
| TODO 3.9.27 V2 (candidate 3.9.30) | Stocks below their 10-week average did better over 13 to 52 weeks, after controls | A hint in this direction, found after the fact. Not proof |
| `levers.grouped_momentum_ranks` | Already built: short-term rank plus a tilt toward long-term losers, combined as percentiles, with a screen | This idea is its mirror image: long-term rank plus a tilt toward short-term losers. Reuse the percentile design |

## Baseline and data rules

- Broad Momentum with **every week simulated** (`min_ranked=1`, as `scripts/alpha_experiments.py`
  does). That is the corrected baseline from 3.9.23, not the shipped version that skips 38% of weeks.
- Primary strategy: Broad, category mode on, dashboard defaults. Secondary: category mode off,
  top 10 / exit 20. Control: ETF live config.
- Follow the validation protocol in `docs/momentum-volume-turnover-tests.md` (pre-registered
  definitions, controls, week-level block bootstrap, both halves, every cell reported).
- Every result is reported for all years and with 2020 excluded (the 2020 false splits, 3.9.3).

## Definitions (fixed before the run)

Universe each week: Broad's qualifying pool.

| Name | Rule |
|---|---|
| LT | Average within-pool percentile of the 13, 26 and 52-week returns (1.0 = strongest) |
| LT-strong | LT in the top 20% of the pool that week |
| Trend intact | Stage 2 by the 1% slope rule in `scripts/volume_turnover_tests.py` |
| Pullback (PB) | LT-strong, trend intact, 4-week return at or below 0, and close 5% to 20% below its 13-week high |
| Pullback and turn (PBR) | PB and last week's return above 0 |

No 9-week lookback: it is not in the engine's lookbacks, and adding it would widen the grid.

## Tests

### P1. Settings-only versions (cheap; checkpoint)

On Broad (both modes), each as a fresh run over the 28 rolling 3-year windows plus full, last 5
years and last 3 years, scored with `sweep.compare_rolling`, deflated Sharpe across the variants:

- P1a: weights 1,0,1,1,1 (drop the 4-week lookback).
- P1b: weights 0,0,1,1,1 (drop 1-week and 4-week).
- P1c: skip-month ranking (`levers.skip_month_ranks`), never run on Broad before.

### P2. Does the pullback state predict returns? (checkpoint; decides P4)

Within LT-strong names each week, regress the forward return on LT and a PB flag; separately on
LT and a PBR flag. Horizons 1, 4 and 13 weeks (26 for information). Report the flag coefficient
with a 4-week block-bootstrap interval, the number of weeks with at least 3 names on each side,
and both halves.

Cross-check on the point-in-time Nifty 50 stock layer, which has no survivorship bias, using the
top 30% by LT (the universe is only about 50 names). Report the sign, even if not significant.

Pass: the PB or PBR coefficient is positive with an interval excluding zero at both 4 and 13
weeks, in both halves, with and without 2020, and the Nifty 50 cross-check has the same sign.

### P3. Exit side: hold through a small pullback

Category mode off, through custom ranks. For a held stock in PB state, set its rank to no worse
than `exit_rank`, so it is not sold while the pullback lasts but is never a fresh buy for that
reason. Everything else unchanged. Evaluate like P1.

### P4. Entry ranking (only if P2 passes)

A new `levers.pullback_ranks`, the mirror of `grouped_momentum_ranks`:
- score = LT percentile + tilt x 4-week-weakness percentile, with tilt in {0.3, 0.5};
- screen: only LT-strong names are ranked;
- `no_buy` guard: not in Stage 2, or more than 20% below the 13-week high;
- variant with an extra `no_buy` when last week's return is at or below 0 (the "turned up" rule).

Run on Broad through its custom stock-rank hook (`stock_tilt_ranks` or whatever applies to the
mode; say which), evaluate like P1.

### P5. Does it stack with the cadence fix?

The one-week delay and every-2-weeks cadence already win on Broad, probably through the same
short-term reversal. For any variant that passes P1, P3 or P4, rerun it on the every-2-weeks
2-tranche blend and compare with that blend alone. If the gain disappears, the two levers are the
same effect, and only the simpler one should be adopted.

## Pass rule for strategy variants (P1, P3, P4, P5)

"Wins most" as in 3.9.23 (better Sharpe and CAGR in over half the rolling windows), MaxDD not
worse in most windows, the same direction in both halves, and a deflated Sharpe above 0.95.

## Known caveats

- **Survivorship bias flatters this idea.** Broad's universe is today's names applied backwards
  (3.9.25). Stocks that dipped and kept falling, then left the index, are missing. A positive
  result is provisional until membership is point-in-time. The Nifty 50 cross-check in P2 is the
  partial guard.
- **Fork caveat.** Changing the ranking changes category selection. Use fresh reruns per window.

## Deliverables

1. `packages/momentum-backtesting/scripts/pullback_tests.py`, stages `p1` to `p5`. Reuse helpers
   by import. Any new lever goes in `levers.py`, with tests. No engine changes.
2. Unit tests for the PB and PBR flags, the 13-week-high distance, `pullback_ranks` and the P3
   rank cap, on a small hand-built frame.
3. CSVs in `data/backtests/pullback/` (gitignored).
4. A Results section appended here, with a plain-English answer to: does buying a strong stock
   after a small pullback beat the current ranking, and does it add anything beyond trading less
   often?
5. TODO.md row 3.9.31 updated in the same commit.

## Results

(Empty until the local run.)
