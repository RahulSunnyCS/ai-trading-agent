# Momentum: reversal / turnaround sleeve

**Status:** Tested · **Last updated:** 2026-10-14

## What it is

A separate sleeve that buys names that were beaten down and have turned, meant to sit next to
momentum, not replace it. Code: `reversal.py`; not in any strategy.

| Setting | Default | Mechanism | Grade |
|---|---|---|---|
| Gate | bottom-quintile 52-week return, or more than 40% below the 52-week high, or below the 40-week average for 26 of 52 weeks; sticky for 52 weeks | "Was beaten down". Design: see the module docstring | R |
| Turned / exit | 13-week return > 0 and not at a new 52-week low (a new low = sold) | "Has turned" | R |
| Entry confirm (`no_buy`) | 26-week return still negative, above the 10-week average, up-week volume > down-week volume (stocks) | Only blocks entry, so a recovering holding is not sold for recovering | R |
| `rank_on` | `acceleration` (also `momentum`) | Rank survivors on 13-week return minus the prior 13 weeks, or on plain 13-week return | M, TODO 3.9.23 |

## Live value

Not used anywhere. Opt-in research code.

## Tested

| Item | Values tried | Data / period | Verdict | Evidence |
|---|---|---|---|---|
| TODO 3.9.23 | `rank_on="acceleration"` | Stocks (point-in-time Total Market) and ETFs | Rejected | Stock sleeve 1.9% CAGR, -44.9% MaxDD |
| TODO 3.9.23 | `rank_on="momentum"`, held as 20% next to Broad | Stocks, 28 rolling 3-year windows; judged against Broad alone and against 80% Broad + 20% liquid fund | A slightly better cash substitute, not alpha | Sleeve 11.4% / 0.43, correlation 0.22 with Broad. 80% Broad + 20% sleeve 29.3% / 1.05 / -18.2% vs Broad 31.7% / 1.06 / -20.4% vs 80% Broad + 20% liquid fund 29.1% / 1.04 / -18.7%. Beats the cash blend in 82 / 71 / 64% of windows (median +0.6); MaxDD better than Broad alone in every window, but costs about 4 points of CAGR |
| TODO 3.9.23 | ETF version | ETFs | Loses to plain cash | TODO 3.9.23 |

Reproduce: `uv run python scripts/reversal_experiment.py --rank-on momentum` from
`packages/momentum-backtesting`.

## What we know

- Ranking on acceleration fails outright. Ranking on 13-week momentum gives a sleeve that is a
  little better than holding the same 20% in a liquid fund.
- It never beats plain momentum on return.
- The ETF grouped tilt (prefer long-run losers among short-run winners) is a related idea that
  did help ETFs: see [score](score.md).

## Not yet tested

- The sleeve after tax.

## In plain words

Turnaround stocks: the beaten-down-and-recovering screen (`reversal.py`) is a little better than
keeping 20% of the money in a liquid fund, but costs about 4 points a year against plain
momentum. Not worth running on its own; never use it to replace momentum.

## Related

- [Score](score.md) (grouped tilt), [lookbacks and weights](lookbacks.md) (why a negative weight
  cannot express "beaten down and recovering"), [sizing](sizing.md).
