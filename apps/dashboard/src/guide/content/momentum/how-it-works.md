## The idea in one paragraph

Every Friday, look at a list of things you could own: sector indices, gold, silver, the Nasdaq,
or individual stocks. Ask which have been rising the most. Buy the best few. Keep them until they
stop being among the best, then swap them for whatever has taken their place. The bet is that
things that have been rising tend to keep rising for a while. That bet is called
[momentum](glossary:momentum).

## Step 1: measure returns over several windows

For each candidate, the return is measured over five [lookbacks](glossary:lookback): 1, 4,
13, 26 and 52 weeks (about a week, a month, a quarter, six months and a year). Using all five
asks "is it strong in the short run *and* the long run?"

## Step 2: rank, and add the ranks

In each window, rank the candidates: best return gets 1. Then add each candidate's five ranks.
The lowest total wins. This is the [rank-sum score](glossary:rank-sum).

A made-up example with four candidates:

| | 1w | 4w | 13w | 26w | 52w | Total | Place |
|---|---|---|---|---|---|---|---|
| A | 2 | 1 | 1 | 2 | 2 | 8 | 1st |
| C | 4 | 3 | 2 | 1 | 1 | 11 | 2nd |
| B | 1 | 2 | 3 | 3 | 3 | 12 | 3rd |
| D | 3 | 4 | 4 | 4 | 4 | 19 | 4th |

B had the best week, but ranks third overall because its longer history is weaker. One hot
week is not enough.

## Step 3: buy the top N, sell only past the exit rank

The strategy buys the [top N](glossary:top-n) (say 5). It does **not** sell a holding the
moment it slips to 6th; it waits until the rank falls past the
[exit rank](glossary:exit-rank) (say 10). The gap between 5 and 10 is a buffer: it stops
the strategy buying and selling the same thing every week, which costs money and tax.

When something is sold, the money is split equally across the current top N, topping up the
ones already held. No single holding may grow past the [position cap](glossary:position-cap).

## Step 4: repeat every Friday

That is the whole loop. Each Friday the ranking is recomputed and the strategy
[rebalances](glossary:rebalance): sells what fell out, buys what came in. The backtest
replays this loop over about ten years of history, charging costs (and tax, if you turn it on)
on every trade.

## The two datasets you can backtest

| | [ETF Rotation](glossary:etf-rotation) | [Broad Momentum](glossary:broad-momentum) |
|---|---|---|
| What is ranked | About two dozen sector, broad-market, commodity, international and debt indices | Individual NSE stocks, plus gold, silver, Nasdaq 100 and Hang Seng |
| What you buy | The ETF that tracks each index | The stocks themselves |
| How it picks | The ranking above, directly | A funnel: strongest ~200 stocks form a pool; the strongest sectors in the pool are chosen; the top 2 stocks of each chosen sector are bought |
| Typical holdings | About 5 | About 8 |
| Signal on Friday at | 14:40 preview, 16:45 final | 19:30 final |

Broad Momentum's funnel uses sectors so that one lucky stock cannot drag in a whole sector: a
sector only counts if enough of its stocks made the pool (the
[coverage floor](glossary:coverage-floor)). It also checks that each stock trades enough to buy
and sell (the [tradability filter](glossary:turnover-filter)) and is not locked at a
[circuit limit](glossary:circuit).

## Why it might work, and why it might not

Momentum is one of the most studied patterns in markets: winners tend to keep winning for
months, because news and money flows take time to be fully priced in. It fails in sharp
reversals, when last quarter's leaders become this quarter's biggest losers, and in choppy
markets where nothing keeps its lead. Expect long stretches of underperformance even if the
long-run result is good. Read [Limits & caveats](guide:start/limits).

Next: [the Backtest settings](guide:momentum/backtest-settings).
