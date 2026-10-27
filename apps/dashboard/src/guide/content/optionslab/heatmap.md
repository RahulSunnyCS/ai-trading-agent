## What it is for

Answers a plain question: if I had sold the at-the-money straddle at this time, with this stop, what
would it have made? It is the same grid as AlgoTest's Heatmap, drawn from the 1-minute option bars
this project collects, for every index and every F&O stock it holds.

Each cell is the profit or loss of selling the at-the-money call and put together at the entry
time. Each leg has its own stop loss at a percentage above its own entry price; a leg that is not
stopped is bought back at the exit time. The last stop-loss setting, **No SL**, has no stop at all: both legs are held to the exit time. Green is profit, red is loss, darker is bigger.

## The three tables

| Table configuration | Rows | Columns | You choose |
|---|---|---|---|
| Time vs SL | Entry times (09:16, then every half hour from 09:45 to 14:45) | Stop loss, 10% to 100%, then No SL | One date, or a date and an end date to sum the days |
| Date vs Time | One row per day | Entry times | A stop loss (10% to 100%, or No SL) and a date range |
| Date vs SL | One row per day | Stop loss, 10% to 100%, then No SL | An entry time and a date range |

The TOTAL row and column add the cells up. In a range, a cell is the sum of the days in it. The
No SL column has its own total at the bottom but is not added into the TOTAL column or the headline
Total: it is the same trades with no stop, not one more stop to add.

## The controls

The row above the table shows the settings in force as chips: the index or stock, the table, the
day or range, the entry or stop, the exit and the unit. **Change** opens the settings in a panel on
the right; the table updates as you change them, and the address holds them, so a link opens the same
table.

| Control | What it does |
|---|---|
| Index | NIFTY and SENSEX use the nearest weekly expiry. BANKNIFTY, FINNIFTY and MIDCPNIFTY use the monthly expiry. |
| Stock | Any F&O stock in the lake, monthly expiry only, or **All F&O stocks**, which pools every stock's straddles and is always shown as % of premium (points per share cannot be added across stocks). |
| Exit | 15:30 is the close of the last bar. 15:15 is where AlgoTest squares off; choose it to compare with an AlgoTest grid. |
| P&L / % of premium | Rupees (index, one lot) or points per share (stock), or the P&L as a share of the premium sold, which can be compared across underlyings. |
| Straddle / Split PE / CE | One number per cell, or the put and the call separately. |
| Weeks to expiry | Keep only days that many weeks before the expiry. 0 is the expiry week itself. This is how to look at a stock's expiry week against the weeks before it. |

The **CSV** button downloads the table as shown (straddle or split). The address bar holds your choices, so a link opens the same table.

Above the table, one slim line gives the **Total** and the **Best cell** (with its time and stop; the
(i) says it is a place to look, not a rule), then a muted note of the basis: the exit time, the
metric, "no costs or slippage" and, for a stock, that only the monthly expiry is used. Hover the
note for the expiry and lot-size wording.

## Strategy types by entry time

This page used to carry a second card, "Entry time by strategy type". It was the same table as the
[Matrix](guide:optionslab/rotation-matrix)'s Family × start view, cell for cell, so it was removed.
The line under the straddle table opens the [Matrix](app:/optionslab/matrix) on that view for the
same day (or range) the heatmap shows.

## How to read it

A column that stops changing (for example 70% to 100% all show the same number) means the stop was
never reached at those settings, so the number is the plain hold-to-exit result. A row that is
red at a tight stop and green at a wide one is a time where the straddle usually swings against you
first and then recovers.

The **No SL** column, set apart at the right, is the plain hold-to-exit result: no stop on either
leg. Compare it with the 100% column to see what a very wide stop adds, and with the tight columns
to see what stops cost or save. In "Best cell", No SL can win like any other setting. If the column
is dashed, the stored days have not been rebuilt with it yet (`obt heatmap build`).

> [!NOTE]
> A cell is a few days at one setting. It is a place to look, not a rule. Wider tables have more
> cells, so the best one on screen is partly luck.

## What is in the numbers

- Replay of collected 1-minute bars; no brokerage, taxes or slippage.
- Entry at the price of the minute before the entry time, as AlgoTest reads it. A stop fills at its
  level, or at the bar's open if the price gapped through it. With No SL nothing is stopped; each
  leg is bought back at the exit time's price.
- Index P&L is for one lot at today's lot size. The lake holds no lot size for most stock
  contracts, so a stock is shown per share.
- A stock has no spot price in the lake, so its at-the-money strike is the strike where the call
  and put cost the same (put-call parity) at the entry minute.
- Against an AlgoTest grid for the same day and exit 15:15, cells agree within about ₹100; the
  differences are the vendor's slightly different bars.
