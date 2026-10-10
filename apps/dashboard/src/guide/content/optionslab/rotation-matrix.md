## What it is for

Shows where the rotation's strategy variants make or lose money: by start time, by date, and by
market condition (days to expiry, opening VIX band, weekday). Then it lays over that picture what
the forward journal's lists actually picked.

It answers four questions. Are the profitable areas broad or isolated? Does the same pattern show
up in different periods? Is a good cell a lot of days or a few? And did a list pick the good
areas on the days it chose?

It describes. A strong cell is something that happened, not a rule to change a registered list.

## What a number is

Every cell is **gross profit and loss per one-lot strategy-day**: one lot of one strategy file, on
one day, before brokerage and charges. The lists trade two lots per strategy; their figures are
not these.

| Word | Meaning |
|---|---|
| Strategy-day | One variant on one trading day. Several variants on the same day are not independent: they are the same market. |
| Session | One trading day. A cell's **n** is distinct sessions, not strategy-days. |
| Pooled | A cell that covers several variants shows their mean (or rate, or worst value). Nothing is ever summed: alternative settings are not a portfolio. |
| Thin | Fewer sessions than the minimum (20 by default). Thin cells are muted, never hidden. |
| Sessions in a cell | Only days the pooled strategies have a result for. On a day only one index was collected, the other index's cells have one session fewer than the header says. |

> [!NOTE]
> The "Row mean" column and "Column mean" row are pooled averages of the strategy-days in that
> row or column. They are not a return you could earn: you cannot trade all of a row at once.

## The views

| View | Rows | Columns | Each cell is |
|---|---|---|---|
| Family × start | The 12 strategy kinds (NIFTY and SENSEX: Widesl, closest-premium Widesl, Dir ATM, Dir ITM1, Buy) | The 25 start times, 09:17 to 15:17 | One variant over the period |
| Date × start | Each session | The 25 start times | One variant on one date. Pick one strategy kind first |
| DTE × start | Days to the index's own nearest expiry (0 to 7+) | Start time | The chosen kind, pooled over days with that DTE |
| VIX × family | Opening India VIX band | Strategy kinds | A kind pooled over its 25 start times, on days in that band |
| Weekday × family | Monday to Friday | Strategy kinds | A kind pooled over its 25 start times, on that weekday |
| Pulse | Strategy kinds | The last 5, 21 and 63 sessions, and all stored days | A kind pooled over its 25 start times in that window |

DTE is each strategy's **own** index's days to expiry: a SENSEX variant uses SENSEX's.

## The controls

| Control | What it does |
|---|---|
| Metric | Average ₹, win rate, stop-hit rate, worst strategy-day, or selection frequency. |
| Period | P1 (Dec 2025 – Oct 2026), P2 (Jan – Aug 2025), P3, Forward (recorded days), or a custom range. "P1 and P2" shows both on one colour scale, with a Difference view. |
| Index, Family | Which strategies. "Widesl (all)" includes the closest-premium variants. |
| Start time, Weekday, Days to expiry, Opening VIX band | Keep only those days or start times. |
| Minimum sessions | Below this a cell is thin. |
| Recorded picks of list | Marks the cells list A, B, C or REF picked, as the journal recorded them. |
| Cells show | **All opportunities** uses every day. **Selected only** keeps just the strategy-days the list picked. Both denominators are shown; they cover different days. |

The metrics:

| Metric | Definition |
|---|---|
| Average ₹ | Mean gross of the pooled strategy-days. |
| Win rate | Share of them above zero. |
| Stop-hit | Share that ended on the overall stop-loss. |
| Worst day | The single lowest strategy-day pooled into the cell. It is not a drawdown. |
| Selected | Picks divided by selection opportunities: recorded on-time entry days times the variants pooled. A one-variant cell is the share of recorded days the list picked it. |

## Reading the grid

Green is profit and red is loss on a scale centred on zero; rates are a single tint from zero. The
printed number is signed whole rupees (or whole percent), so colour is never the only signal. The
legend shows the scale's end values. With "P1 and P2" both grids use the **same** scale, so a
colour means the same rupees in each.

| Look | Meaning |
|---|---|
| Muted number | Thin: under the minimum sessions. |
| Dashed outline, "—" | No result stored for those days, or every day was removed by a filter. Never zero. |
| Blank | The strategy does not exist there (there is no Buy at 15:17). |
| A genuine "0" | A real zero P&L. |

Point at a cell for its numbers (sessions, strategy-days, average, win rate, stop-hit rate, worst,
and who picked it). Click, or press Enter, for the drawer: the daily values, their running total,
the spread, and the strategies pooled with their settings.

## Recorded picks

The overlay is only what the journal wrote at 09:16. Before the first entry (Monday 12 October
2026) there is none, and the page says so: nothing is reconstructed. A late entry (after 09:17) is
not forward, so it is shown on the Date view but left out of every selection figure. An entry
whose day has no results yet is listed as waiting.

> [!WARNING]
> "All opportunities versus Selected only" is a description, not proof the selection added value:
> the two sets cover different days and nothing here controls for that.

## What it does not tell you

That a cell will repeat. P1 and P2 disagree on which family leads, and that is the point of the
period comparison. A single bright cell is not an optimum: look at its neighbours before reading
anything into it.

That the numbers are after costs. They are gross. A net figure needs the stored charge model
confirmed, and until then it is not shown.

P3 (April 2022 to October 2024, NIFTY only) is not in the store yet, so it reads "not available"
with the reason rather than an empty grid.
