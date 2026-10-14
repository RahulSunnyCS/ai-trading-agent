# ETF rotation (the live Friday signal)

**Last updated:** 2026-10-14

## What it is

A weekly rotation across the 21 core instruments of `universe.csv`: 4 broad and 13
sector/thematic NSE indices, gold, silver, Nasdaq 100 and Hang Seng, each traded through an ETF.
Each Friday every instrument is ranked on five lookback returns; the strategy holds the top 5 and
sells a holding once it falls below 10th. This is the strategy the Friday Telegram signal follows
when no favourite is set.

## Where it lives in code

- `packages/momentum-backtesting/src/momentum_backtesting/engine.py` (`run_backtest`, `Config`,
  the buffer rule and hysteresis).
- `live_config.toml` (the live strategy), `universe.csv` (instruments and trade ETFs),
  `weekly.py` / `mbt weekly` (the Friday job: 14:40 preview, 16:45 final).
- `levers.py`, `tranches.py`, `sweep.py`, `scripts/param_dry_run.py`,
  `scripts/alpha_experiments.py` (the 2026-10-01 study).

## Defaults (`live_config.toml`)

Top 5, exit 10, lookbacks 1 / 4 / 13 / 26 / 52 with equal weights, `defensive = "off"`, buffer,
wait, 35% cap (5-point band), 0.10% cost per side, start 2017-01-01, `track = "etf"`, Friday-close
fills, weekly, premium warnings at 1.0% (2.0% international).

## Variable pages that apply

- ETF-only: [sector relative strength](sector-rs.md) (not tested).
- Shared: [universe](../../common/universe.md) · [benchmarks](../../common/benchmarks.md) ·
  [lookbacks](../../common/lookbacks.md) · [skip-month](../../common/skip-month.md) ·
  [score](../../common/score.md) · [top N and exit rank](../../common/top-n-exit-rank.md) ·
  [portfolio rule and entry](../../common/portfolio-entry.md) · [caps](../../common/caps.md) ·
  [gates](../../common/gates.md) · [sizing](../../common/sizing.md) ·
  [costs](../../common/costs.md) · [tax](../../common/tax.md) ·
  [execution](../../common/execution.md) · [cadence](../../common/cadence.md) ·
  [reversal sleeve](../../common/reversal-sleeve.md)

## Strategy-specific findings

**Baseline (TODO 3.9.23):** 25.8% CAGR / Sharpe 0.99 / max drawdown -30.5% (2017-01 to 2026-09),
33.0% / 1.20 / -15.2% last 5 years, 39.9% / 1.37 / -15.2% last 3 years. +13.2 points a year over
Nifty 50 TRI and +8.7 over Nifty200 Momentum 30 TRI. After tax 20.9%.

**What won most, and is still an owner decision (none is in `live_config.toml`):**

- `exclude_high_vol=0.2`: +2.1 points, Sharpe 0.99 to 1.12, plateau-robust, sector-concentrated
  ([gates](../../common/gates.md)).
- Grouped tilt 0.3-0.5: the strongest single ETF finding of TODO 3.9.23
  ([score](../../common/score.md)).
- `top_n=3`: wins most but concentrates the bet ([top N](../../common/top-n-exit-rank.md)).

**What the ETF rotation should keep:** weekly trading on the signal Friday at the close (every
2 weeks, a one-week delay and Monday's open all lose), the 1-week lookback, `wait` entry, the
35% cap as a dial.

## A real Friday (2026-09-18)

The live ETF strategy's latest week with a sale at the time of the 2026-10-01 study, printed by
`param_dry_run.py --friday-only`. Score = sum of the five window ranks (equal weights); the
hand-rebuilt score matched the engine's to 0.000000.

| Instrument | 1w % | 4w % | 13w % | 26w % | 52w % | Ranks 1/4/13/26/52 | Score | Rank | Held | This week |
|---|---|---|---|---|---|---|---|---|---|---|
| Nasdaq 100 | 2.3 | 1.5 | 0.5 | 24.6 | 31.7 | 2/1/9/1/3 | 16 | 1 | yes | ADD |
| Nifty Pharma | 0.7 | 1.3 | 9.2 | 18.5 | 17.7 | 5/2/1/6/6 | 20 | 2 | yes | HOLD (at 35% cap) |
| Nifty Metal | 0.4 | -0.9 | 0.2 | 14.4 | 30.7 | 6/4/10/7/4 | 31 | 3 | yes | ADD |
| Gold | 1.1 | -3.7 | 5.6 | 4.5 | 38.5 | 3/13/2/13/2 | 33 | 4 | no | BUY |
| Nifty Smallcap 250 | -0.3 | -0.7 | 3.2 | 23.6 | 4.5 | 13/3/6/2/10 | 34 | 5 | yes | ADD |
| Silver | 4.5 | -3.8 | 1.2 | 1.9 | 81.2 | 1/15/8/15/1 | 40 | 6 | no | |
| Nifty Midcap 150 | 0.2 | -2.2 | -0.3 | 13.2 | 4.6 | 7/6/11/8/9 | 41 | 7 | no | |
| Nifty Capital Markets | -0.8 | -1.8 | -4.2 | 20.0 | 21.6 | 18/5/17/5/5 | 50 | 8 | yes | HOLD (rank 8 <= 10) |
| Nifty Next 50 | -0.1 | -2.7 | -0.5 | 12.8 | 3.3 | 10/10/12/10/11 | 53 | 9 | no | |
| Hang Seng | 0.2 | -4.6 | 4.8 | 0.9 | 0.5 | 8/17/4/17/13 | 59 | 10 | no | |
| Nifty India Defence | -3.8 | -4.9 | -2.5 | 20.9 | 12.4 | 21/18/15/4/8 | 66 | 14 | yes | SELL: rank 14 > 10 |

The remaining ten instruments ranked 11 to 21 and were neither held nor bought. Defence (26.2%
of the portfolio) was sold; Pharma was already at 35.7%, inside the 35% cap plus its 5-point
band, so it was neither trimmed nor topped up; the proceeds went in four equal 6.4% slices to
Nasdaq 100, Metal, Gold (new) and Smallcap 250. Holdings after: Smallcap 21.0%, Metal 18.9%,
Pharma 36.2%, Nasdaq 15.2%, Gold 6.4%, Capital Markets 2.3%.

## In plain words

**The idea in one paragraph.** Every Friday we look at about 21 things we could own (Indian sector
indexes, gold, silver, the Nasdaq, Hang Seng). We ask: which ones have been going up the most? We
buy the best few. We keep them until they stop being among the best, then swap them out. The bet
is that things that have been rising tend to keep rising for a while. That bet is called momentum.

**The real Friday above, worked like the made-up example** on the
[lookbacks page](../../common/lookbacks.md#a-worked-example-made-up-numbers-worked-by-hand).
Defence was about a quarter of the money. Selling it paid for four equal slices of 6.4% each:
Nasdaq, Metal and Smallcap were topped up and Gold was bought for the first time. Pharma, ranked
2nd, got nothing because it already held 35.7% of the money. Capital Markets was kept: 8th is
still inside the top 10. Notice Silver: best of all this week and over a year, but 15th over one
and six months, so its total of 40 kept it out. That is the "one hot week is not enough" rule
doing its job.

## Related

- [Broad](../broad/README.md), [Custom Index](../custom-index/README.md),
  [Stock](../stock/README.md), [index](../../README.md).
