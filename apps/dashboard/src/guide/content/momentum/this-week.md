## What it is for

Friday's signal for every favourite, on one page: what each one buys and sells this week, the
steps of the day, your live-money rules, and anything that needs a person. The headline
favourite (the one sent to Telegram) comes first.

## Before you start

Nothing. The scheduled jobs do the work: 14:40 ETF preview, 16:45 ETF final, 19:30 stock data
and the stock-based final (Broad, Stock, Custom Index), 21:00 journal check, 21:30 rules check.
Open this page to read the week, to run something by hand, or to classify a possible split.

## The page, top to bottom

| Part | What it shows |
|---|---|
| Friday timeline | Each scheduled step: done (with the time it ran), done late (the laptop was asleep), still to come with a countdown, due now, or missed. **Run by hand** opens a drawer with the manual run, the data status (and **Refresh stock data**) and the schedule. **Week before** / **Week after** step through the weeks the journal holds. |
| Needs attention | Only shown when something needs you: a [possible split](glossary:corporate-action) to classify, a dataset not ready when it should be, or a journal entry still missing after the 21:00 check. The same items also reach you from any screen as [alerts](guide:start/alerts). |
| Live-money rules | The last [rules check](guide:momentum/journal): weeks of paper tracking against the money gate, drawdown against your cut and exit lines, paper against the backtest, and the benchmark. **Check now** re-runs it here without sending anything. |
| Favourites | Every favourite with its [status](glossary:favourite-status): the [headline](glossary:headline) first and larger, then the rest, scrolling sideways. Each shows this week's trades and how many names it shares with the headline. Click one to show its table below. |
| The favourite's table | Sell, Buy and Hold, each by rank: the 1–10 score strip from Scores, the rank and how it moved since last week, the room left before the exit rank (when the strategy has a single exit rank), and the name's share after the trades. A [group](glossary:favourite-group) shows its sleeves first: the ones that trade this week, and when the others next do. Click a scored stock for its drawer. |
| Since the 14:40 preview | ETF favourites: what the final changed against the preview, so you know whether a trade made on the preview still stands. |
| Names at the edge | The weakest names held and the strongest not held, by rank: next rebalance's likely trades. For a group, in the sleeve that trades next. |
| Telegram message | The headline's message for the week, word for word, and whether it was sent. **Re-send…** opens Run by hand, where a final run can be sent again after you confirm. |

## Reading a group

A group's sleeves trade on their own weeks, so most Fridays only some of them rebalance. Rows
show the whole group: **After** is a name's share of the group, each sleeve weighted by its value
since the last reset in April. A week when no sleeve rebalances says so.

A group that follows [all Fridays](glossary:all-fridays) has one sleeve per Friday, so exactly one
trades each week: its card says which (*Friday 2 of 4 trades*), and the other sleeves show when
they next do. The orders are that sleeve's, shown as shares of the whole group.

## Classifying a possible split or bonus

A stock that halves overnight has usually split, not crashed. When the automatic check cannot
match the drop to a filing, it appears under **Needs attention** and as an [alert](guide:start/alerts)
(its **Review ›** button opens this drawer); **Classify…** opens a drawer:

| Classification | When to choose it | What else to enter |
|---|---|---|
| Split | The company split its shares. | The **new shares per old share** (2 for a 2-for-1 split). |
| Bonus | The company issued bonus shares. | The **new shares per old share** (2 for a 1:1 bonus). |
| Genuine price fall | The price really fell. | No factor. |

Give an **evidence URL or note** (the exchange announcement) and save.

> [!WARNING]
> Getting this wrong corrupts every backtest that includes the stock. If unsure, leave it and
> check the NSE announcement first.

## Common questions

**The ensemble shows "Not recorded yet" on a Friday afternoon.** Stock-based strategies get
their signal at 19:30, after the day's stock data is in.

**A step shows "did not run".** The laptop was off or asleep at that time; see
[Jobs](app:/jobs), or use **Run by hand**.

## What it does not tell you

What to trade given what you actually hold. That is [Rebalance](guide:momentum/rebalance) for
now; a **Your orders** section on this page will replace it.
