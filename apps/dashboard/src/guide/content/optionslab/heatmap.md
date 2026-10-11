## What it is for

Answers a plain question: if I had sold the at-the-money straddle at this time, with this stop, what
would it have made? It is the same grid as AlgoTest's Heatmap, drawn from the 1-minute option bars
this project collects, for every index and every F&O stock it holds.

Each cell is the profit or loss of selling the at-the-money call and put together at the entry
time. Each leg has its own stop loss at a percentage above its own entry price; a leg that is not
stopped is bought back at the exit time. Green is profit, red is loss, darker is bigger.

## The three tables

| Table configuration | Rows | Columns | You choose |
|---|---|---|---|
| Time vs SL | Entry times (09:16, then every half hour from 09:45 to 14:45) | Stop loss, 10% to 100% | One date, or a date and an end date to sum the days |
| Date vs Time | One row per day | Entry times | A stop loss and a date range |
| Date vs SL | One row per day | Stop loss, 10% to 100% | An entry time and a date range |

The TOTAL row and column add the cells up. In a range, a cell is the sum of the days in it.

## The controls

| Control | What it does |
|---|---|
| Index | NIFTY and SENSEX use the nearest weekly expiry. BANKNIFTY, FINNIFTY and MIDCPNIFTY use the monthly expiry. |
| Stock | Any F&O stock in the lake, monthly expiry only. |
| Exit | 15:30 is the close of the last bar. 15:15 is where AlgoTest squares off; choose it to compare with an AlgoTest grid. |
| P&L / % of premium | Rupees (index, one lot) or points per share (stock), or the P&L as a share of the premium sold, which can be compared across underlyings. |
| Straddle / Split PE / CE | One number per cell, or the put and the call separately. |
| Weeks to expiry | Keep only days that many weeks before the expiry. 0 is the expiry week itself. This is how to look at a stock's expiry week against the weeks before it. |

The address bar holds your choices, so a link opens the same table.

## How to read it

A column that stops changing (for example 70% to 100% all show the same number) means the stop was
never reached at those settings, so the number is the plain hold-to-exit result. A row that is
red at a tight stop and green at a wide one is a time where the straddle usually swings against you
first and then recovers.

> [!NOTE]
> A cell is a few days at one setting. It is a place to look, not a rule. Wider tables have more
> cells, so the best one on screen is partly luck.

## What is in the numbers

- Replay of collected 1-minute bars; no brokerage, taxes or slippage.
- Entry at the price of the minute before the entry time, as AlgoTest reads it. A stop fills at its
  level, or at the bar's open if the price gapped through it.
- Index P&L is for one lot at today's lot size. The lake holds no lot size for most stock
  contracts, so a stock is shown per share.
- A stock has no spot price in the lake, so its at-the-money strike is the strike where the call
  and put cost the same (put-call parity) at the entry minute.
- Against an AlgoTest grid for the same day and exit 15:15, cells agree within about ₹100; the
  differences are the vendor's slightly different bars.
