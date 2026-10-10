## What it is for

Shows how alike your strategies are. Two strategies that rise and fall together are one bet, not
two: a basket of five look-alikes has the drawdown of one. Use this screen to see which ones are
look-alikes, and to build a basket whose parts are not.

## The controls

| Control | What it does |
|---|---|
| Start time | The entry slot to compare. The default, 09:17, is the ten rotation variants that start at the open. "Any start time" compares every slot (capped at 80 strategies at once). |
| Family | Widesl, Dir or Buy, or one closest-premium family. "Widesl" includes the closest-premium variants. |
| Index | NIFTY, SENSEX or both. |
| Kind | Rotation variants (the 248 files the forward journal scores), live strategies (the saved leg-wise strategies `obt daily` runs), or both. |
| From, To | Which days to use. Every strategy compared must have a result on a day for it to count. |
| Also include | Add a strategy by name on top of the filter. |
| Measure | Which matrix the grid shows: daily P&L, the rank of daily P&L, or loss days. |

The filters combine: start time 09:17 and index NIFTY is the NIFTY strategies that start at 09:17.
The address bar holds your choices, so a link opens the same comparison.

New strategies appear on their own. A strategy is listed once it has saved days: a new rotation
variant after the next nightly update, a new live strategy after the next evening run.

## The grid

One cell per pair of strategies. Blue tints mean alike, orange mean opposite, grey means
unrelated. Rows are ordered so strategies that move together sit next to each other, which makes
look-alike groups show up as blocks.

| Measure | What it says |
|---|---|
| Daily P&L | How closely the two strategies' daily profit and loss rise and fall together. 1 is always, 0 is unrelated, −1 is opposite. |
| Rank of daily P&L | The same on ranks, so a few huge days do not decide it. |
| Loss days | The same, using only days either one lost. This is the one that matters for drawdown: do they crash together? |

Point at a cell, or use the arrow keys, to read the pair in words: the three correlations, and of
the days one lost, how often the other lost too. Click or press Enter to keep it.

> [!NOTE]
> Everything here is measured on the chosen days. It describes that window; it does not promise
> the next one looks the same.

## The cards

| Card | What it shows |
|---|---|
| Strategies, Average pair, Most alike pair | How many strategies and days, the mean correlation over every pair, and the pair that moves together most. |
| Basket vs its parts | All the strategies together, one lot each: the basket's biggest drawdown divided by the sum of each strategy's own. Below 1.00 the basket draws down less than its parts added up. |
| Each strategy | Net P&L for one lot, biggest drawdown, worst day, share of loss days and how alike it is to the rest. |
| A basket that is not alike | Picks the best-ranked strategies one at a time, skipping any that is alike to one already kept. Shown beside the best-ranked set with no cap, so you can see what the cap cost or saved. |
| Does it hold over time? | The average pair's correlation in each block of 63 trading days, with the most and least alike pair as the band. |

## What it does not tell you

That a low-correlation basket will draw down less next month. The basket builder ranks and
measures on the same days, so it always looks better than it will. Testing whether a correlation
cap helps the forward lists is a separate, pre-registered study on the forward journal.

Short histories are refused: fewer than 40 days in common says too little. The live leg-wise
strategies have only a few weeks of days, so compare them with rotation variants only once they
have enough.
