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

Run 2026-10-03, real data, `scripts/pullback_tests.py` (`uv run pytest`: 690 passed / 5 skipped;
`ruff check src tests`: clean). All figures below are CAGR / Sharpe / MaxDD unless stated, from the
corrected Broad baseline (every week simulated, `min_ranked=1`). "Both modes" = category mode on
(dashboard defaults) and off (direct pool rank, top 10 / exit 20). The full pass rule (all four
must hold): wins most (better Sharpe AND CAGR in over half the 28 rolling windows), MaxDD not
worse in most windows, the same sign of median dCAGR in both halves (2017-2021 vs 2022+), and a
deflated Sharpe above 0.95.

### P1. Settings-only variants

Baseline: mode on 31.66% / 1.057 / -20.39%; mode off 41.81% / 1.182 / -40.39%.

| Variant | Mode | Full CAGR/Sharpe/MaxDD | Roll win share CAGR/Sharpe/MaxDD | Median dCAGR | 2017-21 | 2022+ | Same dir | DSR | **Full pass** |
|---|---|---|---|---|---|---|---|---|---|
| p1a weights 1,0,1,1,1 | on | 32.63% / 1.078 / -25.98% | 57% / 50% / 61% | +0.6pt | +2.43 | -1.15 | No | 0.9992 | **No** |
| p1b weights 0,0,1,1,1 | on | 36.48% / 1.149 / -38.91% | 64% / 64% / 36% | +9.5pt | +9.39 | +9.59 | Yes | 0.9996 | **No** (MaxDD) |
| p1c skip-month | on | 36.09% / 1.153 / -30.78% | 61% / 46% / 7% | +0.6pt | +1.83 | -3.86 | No | 0.9995 | **No** |
| p1a weights 1,0,1,1,1 | off | 43.83% / 1.247 / -52.81% | 68% / 79% / 71% | +3.8pt | +1.01 | +15.22 | Yes | 0.9999 | **Yes** |
| p1b weights 0,0,1,1,1 | off | 40.85% / 1.115 / -40.17% | 43% / 43% / 50% | -9.1pt | -18.51 | +9.62 | No | 0.9993 | **No** |
| p1c skip-month | off | 44.15% / 1.213 / -35.45% | 46% / 50% / 61% | -5.4pt | -13.87 | +10.53 | No | 0.9997 | **No** |

Only **p1a (drop the 4-week lookback), category mode off**, passes the full rule. It does not
pass on, and no variant passes in both modes — the fork caveat (changing the ranking changes
which categories get selected before the window even starts) applies to every row here, so even
the one pass is provisional, not a clean settings change. Skip-month, run on Broad for the first
time, is a clear loser once MaxDD and both halves are checked, matching its ETF result in 3.9.23.

### P2. Does the pullback state predict returns?

Within LT-strong Broad-pool names, flag coefficient on forward returns, LT-controlled, 4-week
block bootstrap (positive = a flagged name went on to do better):

| Flag | Horizon | Weeks | Mean | 95% CI | 2017-21 | 2022+ | Ex-2020 mean |
|---|---|---|---|---|---|---|---|
| PB | 1w | 139 | +0.06pt | [-0.45, +0.58] | -0.06 | +0.35 | -0.04 |
| PB | 4w | 139 | -0.02pt | [-1.28, +1.21] | -0.33 | +0.69 | +0.13 |
| PB | 13w | 139 | +0.59pt | [-2.73, +3.95] | -0.76 | +3.71 | +0.22 |
| PB | 26w | 139 | +1.92pt | [-3.08, +6.82] | +1.15 | +3.69 | +0.79 |
| PBR | 1w | 28 | +0.09pt | [-0.83, +1.08] | +0.20 | -0.14 | +0.11 |
| PBR | 4w | 28 | +0.10pt | [-1.93, +2.05] | -0.45 | +1.27 | +0.43 |
| PBR | 13w | 28 | -0.59pt | [-5.75, +5.06] | -1.20 | +0.71 | +0.35 |
| PBR | 26w | 28 | -3.04pt | [-11.74, +5.42] | -5.16 | +1.44 | -1.02 |

**P2 fails.** Every interval at 4 and 13 weeks includes zero, for both PB and PBR, in both
halves and with 2020 excluded — the pre-registered pass rule needs a positive, zero-excluding
interval at both horizons and it never gets one. PBR also has far fewer eligible weeks (28 vs
139) because "at least 3 names on each side" is a harder bar once the flag also requires the
turn. **Nifty 50 point-in-time cross-check** (no survivorship bias, top 30% by LT, last week
2026-09-25, 50-name pool): PB's sign agrees with the Broad-pool direction (positive at both 4
and 13 weeks, 200 eligible weeks), but PBR's disagrees (negative at both, only 35 eligible
weeks). Because the Broad-pool test already fails on its own terms, this cross-check does not
change the verdict — it is reported per the spec, not folded into the pass/fail.

**P4 is built (`p4_study`/`run_p4` in `scripts/pullback_tests.py`) but was not run.** The spec
gates P4 on P2 passing; running it now, after P2 failed, would be a post-hoc fishing expedition
over a ranking that nothing here supports. Left in place for later if the owner wants the
building-blocks re-examined on their own.

### P3. Exit side: hold through a small pullback

Category mode off, baseline (same as P1 off base) 41.81% / 1.182 / -40.39%.

| Variant | Full CAGR/Sharpe/MaxDD | Roll win share CAGR/Sharpe/MaxDD | Median dCAGR | 2017-21 | 2022+ | Same dir | DSR | **Full pass** |
|---|---|---|---|---|---|---|---|---|
| Hold through PB | 44.04% / 1.242 / -37.24% | 82% / 89% / 75% | +2.0pt | +0.87 | +3.37 | Yes | 0.9999 | **Yes** |
| Hold through PBR | 42.06% / 1.189 / -40.30% | 50% / 50% / 21% | 0.0pt | — | — | — | 0.9998 | **No** |

**Hold through PB passes the full rule** — not selling a held name during a brief, trend-intact
dip (capping its rank at `exit_rank` rather than letting it drop out) wins on CAGR and Sharpe in
most rolling windows, has a shallower worst drawdown more often than not, and the direction is
the same in both halves. Hold through PBR (the stricter flag, requiring the turn) does nothing —
win shares sit at or below 50%, consistent with PBR's much smaller, noisier sample in P2.

### P5. Does it stack with the cadence fix?

Only "p1a, mode off" and "hold through PB" qualify to run P5 (the full pass in P1/P3 above).
Baseline for both: the every-2-weeks, 2-tranche cadence blend alone, mode off, no pullback lever:
36.32% / 1.248 / -19.85%.

| Stacked variant | Full CAGR/Sharpe/MaxDD | Roll win share CAGR/Sharpe/MaxDD | Median dCAGR | Wins most | DSR |
|---|---|---|---|---|---|
| p1a weights 1,0,1,1,1 + cadence | 46.98% / 1.398 / -37.16% | 79% / 54% / **0%** | +10.6pt | Yes | 0.99997 |
| Hold through PB + cadence | 44.09% / 1.313 / -28.30% | 71% / 50% / **0%** | +6.6pt | No (Sharpe exactly 50%) | 0.99995 |

**The gain does not stack cleanly with the cadence fix.** CAGR keeps improving when either lever
is added on top of the every-2-weeks blend, but the MaxDD win share is exactly **0% in both
cases** — the stacked variant has a deeper worst drawdown than the cadence blend alone in every
single one of the 28 rolling windows, with no exception. For "hold through PB" the Sharpe win
share also drops to exactly 50%, so it no longer even passes "wins most" once cadence is already
in place. This is the sharpest finding in the whole study: whatever edge p1a and the PB hold
rule have on their own comes substantially from the same place the cadence fix already found
(fewer, later trades reacting to the same short-term reversal), and stacking them trades away
drawdown robustness for a CAGR number that was already mostly captured by the simpler lever.

### Plain-English answer

**Does buying a strong stock after a small pullback beat the current ranking?** Only in a
narrow, caveated sense. The direct test of the idea — does being in a pullback state actually
predict better forward returns for an already-strong stock? — fails (P2): the effect is
statistically indistinguishable from zero at both the 4- and 13-week horizons that matter, in
both halves of the sample, with or without 2020. Two mechanical variants of the idea do pass
the pre-registered backtest rule in isolation — dropping the 4-week lookback from the ranking
(P1a) and not selling a held name through a brief pullback (P3, hold-through-PB) — but only on
one of the two category-selection modes each, and the fork caveat (a different ranking changes
which categories get chosen in the first place) applies to every row that passed, including
those two.

**Does it add anything beyond trading less often?** No. That is the decisive result of P5: when
either passing variant is stacked on top of the already-known every-2-weeks cadence fix (3.9.23),
the drawdown benefit disappears completely — the stacked backtest has a worse worst-drawdown
than the cadence-alone blend in literally every one of the 28 rolling windows — and for the P3
exit-hold variant the Sharpe advantage disappears too (exactly a 50% win share). The surviving
CAGR gain looks like the same short-term-reversal mechanism the cadence fix already captures,
expressed a second way, not a second, independent edge. Combined with survivorship bias
(today's Nifty 50 members backdated — a name that fell into a pullback and never recovered, then
left the index, is invisible here) and the failed direct predictive test, there is no case for
building this as a live feature. The one clean, cross-validated finding from the whole exercise
is the opposite direction from the hint in 3.9.30: this says nothing new is added once the
cadence lever is in place; nothing here overturns that lever's own standing recommendation.
Build decisions are left to the owner.
