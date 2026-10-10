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

## A day's basket

The switch above the filters, **A day's basket**, asks a narrower question: are the three picks of
one list on one day really three different bets? Choose a list, a day and a window, and the tab
correlates exactly those strategies, with the same maths as the strategy picker.

| Control | What it does |
|---|---|
| List | A, B, C or REF: the picks that list made. **Base** is the owner's fixed reference, 2 × Widesl OTM1 09:17 and 1 × Dir ATM 09:24, traded every day with no ranking. |
| Day | The day whose picks to use. Empty is the latest entry. A day before the journal began is re-scored from the results before it and labelled **Reconstructed**; a day with an entry says **Recorded**. Not used for the base. |
| Window | The days the correlation is measured over: **P1** (3 Dec 2025 to 8 Oct 2026), **P2** (10 Jan to 29 Aug 2025), the **last 63** sessions the picks have in common, or **Forward** (only the on-time recorded days). |
| Open as custom | Moves the same names and dates into the strategy picker for further browsing. Not offered for the base: its Dir leg is not one of the listed strategies. |

The cards are the picker's, narrowed to the picks: how many days they share, the average pair,
how many sessions all of them lost on, and the basket's drawdown against the sum of each alone,
then the heatmap, the pairs' losing days and a one-paragraph reading.

> [!NOTE]
> Picks change every day. The window shows how *these* strategies behaved together over days that
> have already happened. It describes the picks' past; it is not a forecast, and it is not how
> the list as a whole behaved.

Things to know:

- **Recorded or Reconstructed** is always said. A reconstructed pick is what the rule would have
  chosen, scored with the same code as the 09:16 job; the weights were chosen on this history, so
  it is not evidence of an edge.
- **The base lists its Widesl twice**, because two of its three lots are that strategy. Those two
  columns correlate 1.00 by construction.
- **Few days.** Under 20 common days the figures are shown muted with a note; under 5 there are
  none, and the reason says how many days there are. A Forward window starts thin and firms up.
- **A pick with no stored results** is named and left out of every figure, never counted as zero.

## What it does not tell you

That a low-correlation basket will draw down less next month. The basket builder ranks and
measures on the same days, so it always looks better than it will. Testing whether a correlation
cap helps the forward lists is a separate, pre-registered study on the forward journal.

Short histories are refused: fewer than 40 days in common says too little. The live leg-wise
strategies have only a few weeks of days, so compare them with rotation variants only once they
have enough.
