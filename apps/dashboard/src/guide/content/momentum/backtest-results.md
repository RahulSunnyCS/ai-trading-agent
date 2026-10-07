## What it is for

After a run, this part of the Backtest screen tells you how the rule did, how bumpy the ride
was, and what it actually traded.

## The headline cards

| Card | What it means | What to look for |
|---|---|---|
| ₹1 lakh became | The final value of ₹1 lakh invested at the start. | Compare with the benchmark's figure. |
| [CAGR](glossary:cagr) | The average yearly return, compounded. | Meaningful only next to the benchmark and the drawdown. |
| [Edge vs benchmark](glossary:edge) | Strategy CAGR minus benchmark CAGR. | Positive, and comfortably more than the costs you might have missed. |
| [Max drawdown](glossary:max-drawdown) | The worst fall from a peak. Red when deeper than the benchmark's. | Could you have sat through it without selling? |
| [Sharpe](glossary:sharpe) / [Sortino](glossary:sortino) | Return above cash per unit of risk. | Above 1 is good; above 2 is rare and worth doubting. |
| [Churn](glossary:churn) | Share of the portfolio replaced per year. | High churn means more cost and short-term tax. |
| Exits / year, Avg holding | How often positions are sold, and how long they are held. | Holdings under a year are taxed as short-term gains. |
| [Win rate](glossary:win-rate), Best / worst exit | Share of closed positions that made money; the extremes. | Momentum often wins well under 60% of the time and makes it up with large winners. |
| Largest position | The biggest share any holding reached. | A very large number means concentration risk. |
| Time in cash/debt | Share of weeks not fully invested. | |
| Tax paid | Capital-gains tax deducted, when tax is on. | |

## The equity chart

The portfolio's value week by week against the benchmark. Markers show the weeks it bought,
sold, topped up or trimmed. Look for *when* the edge was earned: steadily, or in one lucky
stretch? A result that comes from one year is fragile.

## The detail tabs

| Tab | What it shows |
|---|---|
| Returns | Each calendar year against the benchmark, and a month-by-month heatmap. Count the losing years. |
| This week | The latest ranking: every candidate's rank score and which are held. |
| Trades | Open positions, every closed trade, and which instruments made or lost the money. |
| Timeline & holdings | What was held, when, and in what share. |
| Risk | The benchmark's worst falls and how the strategy did in the same weeks; for stocks, circuit situations. |
| Compare | Put this run next to saved runs: CAGR, edge, drawdown, Sharpe, turnover, holdings. |

## Reading a result honestly

1. **Compare with the benchmark, not with zero.** 15% a year is poor if the index made 14%
   with less pain.
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
