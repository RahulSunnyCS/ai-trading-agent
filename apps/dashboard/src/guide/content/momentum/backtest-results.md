## What it is for

After a run, this part of the Backtest screen tells you how the rule did, how bumpy the ride
was, and what it actually traded. The first screen answers "is this good?" without scrolling;
everything else sits in sections below the chart.

## The run bar

The line at the top: the dataset, every setting the next run tests as a chip (click a chip to
open that setting), and the actions: reload prices, copy a shareable link, **Settings** (the
settings open in a drawer from the right) and **Run momentum backtest**. The round arrow beside
Run re-runs from scratch, dropping the server's caches.

## The benchmark picker

The headline card compares everything with one [benchmark](glossary:benchmark), picked on the
card itself: **Nifty 200 Momentum 30** (the default), **Nifty 50**, **Nifty Next 50**,
**Nifty Midcap 150** or **Nifty Smallcap 250**. All five include dividends, so they compare
like for like, and each shows its own CAGR over the run's period in the menu. Switching
re-compares the whole page (the headline, the chart, the yearly bars, the drawdowns) without
running the backtest again; the strategy's own numbers do not change.

Nifty 200 Momentum 30 is the default because it is a momentum index you can buy as an ETF:
beating it is what makes running this strategy worth the effort.

> [!NOTE]
> Nifty 200 Momentum 30 before August 2020 is NSE's back-calculation, not live history. An
> index without data for the run's period shows *no data* in the menu, and hovering it says why
> (it starts after the run's first week, it ends early, or it has a gap of more than a week). If
> your last pick has no data for a run, the page shows the run's own benchmark and says so under
> the headline numbers instead of switching quietly.

## The headline numbers

| Number | What it means | What to look for |
|---|---|---|
| [CAGR](glossary:cagr) | The average yearly return, compounded. The badge is the [edge](glossary:edge) over the benchmark. | Positive edge, comfortably more than costs you might have missed. |
| [Max drawdown](glossary:max-drawdown) | The worst fall from a peak, with the benchmark's and how much shallower or deeper. | Could you have sat through it without selling? |
| [Sharpe](glossary:sharpe) | Return above cash per unit of risk, for the strategy and the benchmark. | Above 1 is good; above 2 is rare and worth doubting. |
| ₹1 lakh became | The final value of ₹1 lakh, and how many times the benchmark's. | |
| Last 12 months | The return over the last 52 weeks, and since the end of last year. | |

The line under them carries the rest at a glance: [Sortino](glossary:sortino), volatility,
how many calendar years it beat the benchmark, exits per year, average holding, win rate and
time in cash. **All metrics** opens the full set, the assumptions behind the run, any data
notes and a one-sentence summary. Hover the (i) by a number for what it means and how it
changed from your previous run.

## The equity chart

The portfolio's value week by week against the benchmark, about two-thirds of the first
screen. Markers show the weeks it bought, sold, topped up or trimmed.

- **Hover** a week: a short tooltip sits about a centimetre below the cursor (above it near the
  bottom edge), so the line to either side stays clear and you can slide straight to the next
  week. It shows the strategy's and benchmark's value that week and what was sold and bought.
- **Click** a week to pin its full detail in the chart's corner: everything sold (with how long
  it was held, its return and why), everything bought, and the holdings after. **← →** step to
  the previous or next rebalance; **Esc** or × unpins.
- The legend under the plot toggles each line; **+ Nifty 50** and the like add the other
  indices. **Drawdown pane** adds the drawdown and 52-week-edge panes under the curve.

Look for *when* the edge was earned: steadily, or in one lucky stretch? A result that comes
from one year is fragile.

## The sections below the chart

They load in the background once the chart has drawn, and any section you scroll to loads
straight away. Circuit exposure (Broad Momentum only) costs a second run of the engine, so it
loads only when you scroll to it. Compare runs shows each saved run's edge against *its own*
benchmark, not the one picked on the headline.

| Section | What it shows |
|---|---|
| This week | The run's last week: each candidate's rank, score and action, beside the open positions. On a slower cadence a week the strategy does not trade says "Not a rebalance week" and names the next trading Friday. For Broad the actions are the engine's own, so a stock above "Max price to buy ₹" is never shown as a buy: one that ranks high enough to be bought shows **SKIP (above max price)** with its price, and the next-best stock takes its slot. |
| Yearly returns | Each calendar year against the benchmark. Count the losing years. |
| Rolling 1-year return | The return over every trailing 52 weeks, and how often the strategy was ahead. |
| Drawdowns | The deepest falls: when, how deep, how long, and what the benchmark did then. |
| Monthly returns | A month-by-month heatmap with each year's total. |
| Trades | Every closed trade, newest first, filterable. |
| Benchmark's worst falls | The benchmark's deepest falls and what the strategy did in the same weeks. |
| Compare runs | This run next to saved runs: CAGR, edge, drawdown, Sharpe, turnover, holdings. |
| Holdings timeline | What was held, when, and in what share. |
| Circuit exposure | Broad Momentum only: the circuit-lock situations the strategy ran into. |
| Instrument attribution | How each instrument made or lost the money. |

## Reading a result honestly

1. **Compare with the benchmark, not with zero.** 15% a year is poor if the index made 14%
   with less pain. Try the other indices in the picker too.
2. **Look at the drawdown before the return.** A strategy you abandon in its worst year earns
   nothing.
3. **Check the years.** Several losing years in a row is normal for momentum; know how many.
4. **Turn tax on** for a realistic number if you would hold this in a taxable account.
5. **Distrust a small improvement** found by changing settings. See
   [Limits & caveats](guide:start/limits).

## What it does not tell you

Whether this will continue. And for Broad Momentum, results before the stock data's history
starts are not available; the benchmark and the strategy are compared over the same window
only.
