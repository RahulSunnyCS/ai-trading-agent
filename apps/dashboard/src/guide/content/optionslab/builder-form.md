## What it is for

Build a strategy leg by leg, backtest it over a date range, and save it so the evening run
tracks it every day.

## Before you start

Pick a starting point with **New**, which opens *Start a strategy*, or **load a saved strategy**
from the list. Nothing is saved until you press **Save**.

| Start | What you get |
|---|---|
| Short strangle | Sell the call and put one strike out of the money at 09:17, each stopped at 115% and trailed, ₹2,500 overall loss, out at 15:28. The shape of the Widesl strategy. |
| Buy range breakout | Buy the call and put priced near ₹50 when one breaks its own 09:35 to 09:45 high, each stopped at 25% and trailed, ₹2,000 overall loss, out at 15:14. |
| Short strangle at a premium | Sell the call and put whose premium is closest to a price you type, at 09:17, each stopped at 115% and trailed, ₹2,500 overall loss, out at 15:25. |
| Copy a saved strategy | One you already have, saved under a new name (`…_copy`). Starred strategies are listed first. |
| Blank | A short straddle skeleton: sell the ATM call and put, 25% stop on each, 09:20 to 15:15. |

The templates are modelled on the strategies the evening run tests, so you can change one detail
and see what it does.

## The page

From the top: the strategy's **name** (written for you from what it does, such as "Short strangle
OTM1 · 09:17") with the **file** it is saved as; a row of **settings tokens**; the **leg grid**; the
strategy **in plain words** with whether it is ready to run; and the **Run** panel.

Click any value in the tokens or the grid to edit it where it stands. **Enter** keeps it, **Esc**
gives the change up, and a value that cannot be used stays open and says why. An empty value turns
an optional setting off.

### The file name

Until you type one, the file name follows what the strategy does, and it is the strategy's id as
well. Type your own and it stays yours. A strategy you opened from the list keeps its own name.

### The settings tokens

| Token | What it does |
|---|---|
| Index | NIFTY, BANKNIFTY, SENSEX and the others with collected data. |
| Enter, Exit | When legs enter, and when anything still open is closed. Times are inside the 09:15 to 15:29 session. |
| Max loss, Target | Close everything when the whole position loses or makes this much (₹). Empty is off. |
| Leg stops | What a leg that stops out does to the rest: *exit that leg* or *exit all legs* ([partial or complete](glossary:square-off) square-off). |
| More | **No new entry after** (a stopped-out leg is not re-entered after this time), **Slippage %** and **Cost per order (₹)**. They appear once you set them. |

### The leg grid

One row per leg. Click a cell to edit it.

| Column | What you type |
|---|---|
| Side | Click to switch between sell and buy. |
| Lots | A whole number, 1 or more. |
| Type, Expiry | Choose [CE or PE](glossary:ce-pe); weekly, next weekly or monthly. |
| Strike | `ATM`, `OTM1` to `OTM99`, `ITM1` to `ITM99`, or a premium such as `₹65` ([closest premium](glossary:closest-premium)). |
| Stop, Target | `25%` of the entry premium, or `10 pts`. A stop on a sold leg triggers when its price **rises** by that much; a target when it **falls**. The reverse for a bought leg. Empty is off. |
| Trail | `15/10%` or `1/1 pts`: every 15 the price moves in your favour, move the stop by 10. Needs a stop. |
| Re-entry | `now ×2` ([at once](glossary:re-entry), up to 2 times) or `at cost ×1`, after a stop. Empty is off. |

A CE and a PE that match in everything else are a **pair**, marked with a link. While **Edit both
legs together** is on, a change to one goes to the other (never its type or id). Turn it off to edit
one leg alone. **Add CE + PE pair** adds two matching legs; **Add leg**, copy and remove work on one.

The sliders button on a row, **All settings**, opens everything the grid does not show: the
[range breakout](glossary:range-breakout) (range until, break of high or low, on the option or the
index, gap, valid until), re-entry on target, and the leg's id.

> [!WARNING]
> Slippage and cost per order default to 0. A short-premium strategy with many re-entries can look
> profitable at zero cost and lose money at realistic cost. Always set them.

## In plain words

Under the grid the strategy is read back as a few sentences, built from the form itself, so it
cannot describe something the strategy does not do. Beside it: **Ready to run**, or what to fix.

## Running

In **Run**, choose a period (**3 months**, **1 year** or **All data**, counted back from the last
collected day) or type **from** and **to**, and press **Backtest**. The form is checked as you
type, and **Save** writes the strategy file.

**Test settings** hold two options that change the test, not the strategy:

| Setting | What it does |
|---|---|
| Bars | 1 minute (default), or 5 minutes: the same engine on the 5-minute chain snapshots. Every time must be on a 5-minute mark (09:20, not 09:17) and closest-premium strikes are not available; otherwise the run is refused with the reason. |
| Include days with bad data | Also run the days the data-quality check judged unusable. They are off by default because their results are not trustworthy. |

## Reading the results

| Figure | Meaning |
|---|---|
| Net / Gross / Costs per lot | Profit after costs, before costs, and the costs. |
| Up days | Days that made money. |
| [Expectancy](glossary:expectancy) | Average net per day. |
| [Profit factor](glossary:profit-factor) | Winning days' total ÷ losing days' total. |
| Worst day, [Max drawdown](glossary:max-drawdown) | The single worst day, and the worst peak-to-trough fall of the running total. |

A sparkline shows the running total, and the previous run is shown alongside so you can see
what your last change did.

## What it does not tell you

Whether the strategy suits the kind of market coming next. Use
[Daily results](guide:optionslab/daily-results) and [Regimes](guide:optionslab/regimes) to see
*which* days it made and lost money on.
