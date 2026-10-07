## What it is for

Build a strategy leg by leg, backtest it over a date range, and save it so the evening run
tracks it every day.

## Before you start

Pick a starting point: **load a saved strategy**, or start from a **template** (Short straddle,
Short strangle, Iron condor). Templates are the quickest way in.

## The controls

### The strategy

| Control | What it does |
|---|---|
| File name, Strategy id | How it is saved and shown. |
| Index | NIFTY, BANKNIFTY, SENSEX and the others with collected data. |
| Entry time, Exit time | When legs enter, and when anything still open is closed. |
| No re-entry after | After this time a stopped-out leg is not re-entered, even with re-entries left. |
| Square off | [Partial or Complete](glossary:square-off). |

### Each leg

| Control | What it does |
|---|---|
| Lots | How many lots. |
| Position | Buy or sell. |
| Option type | [CE or PE](glossary:ce-pe). |
| Expiry | Weekly or monthly. |
| Strike | [ITM3…ATM…OTM10](glossary:atm), or [closest premium](glossary:closest-premium). |
| Stop loss, Target | Off, or in points, or in % of the entry premium. |
| Trailing SL | "Every X, move the SL by Y". Needs a stop loss. |
| Re-entry on SL / on target | Off, [RE COST or RE ASAP](glossary:re-entry), and how many times. |
| Range breakout | [Range until, break of high/low, range on](glossary:range-breakout) the option or the index. |

Legs can be added, copied and removed.

### Overall and execution

| Control | What it does |
|---|---|
| Overall max loss / max profit (₹) | Close everything when the whole position loses or makes this much. |
| Slippage % | Charged against you on every fill. Try 0.5–1% for liquid ATM options; more for far strikes. |
| Cost per order (₹) | A flat charge per entry and per exit (brokerage, taxes). |

> [!WARNING]
> Both costs default to 0. A short-premium strategy with many re-entries can look profitable at
> zero cost and lose money at realistic cost. Always set them.

## Running

Choose the **from** and **to** dates and press **Backtest**. The form is checked as you type;
errors appear next to the field. **Save** writes the strategy file.

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
