## What it is for

The day-by-day record of every saved strategy over every collected day: which strategies are
doing well, which days hurt, and a minute-by-minute replay of any single day. This is the
screen to check on a weekday evening.

## Before you start

The evening run fills it automatically. The **Evening run** bar at the top shows the
[Fyers token](glossary:fyers-token) status, the last run and how many days are collected. To
run it by hand, open the bar and choose:

| Control | What it does |
|---|---|
| Day | Which session (blank = the last closed one). |
| Collect data first | Download that day's 1-minute data before running. Needs a valid Fyers login. |
| Send summary to Telegram | Also send the summary message. |

A live log appears while it runs.

## Filters

A **from/to** date range and the **index**.

## Strategy comparison

One row per strategy, sortable by any column:

| Column | Meaning |
|---|---|
| Days | Days with a result for the current version. |
| Net / lot | Total net profit per lot. |
| Up days, [Win rate](glossary:win-rate) | How many days made money, and the share. |
| [Expectancy](glossary:expectancy) | Average net per day. |
| [Profit factor](glossary:profit-factor) | Wins ÷ losses. Above 1 is profitable. |
| Worst day | The single worst day's net. |
| [Worst MTM](glossary:worst-mtm) | The deepest intraday loss on any day, even if it recovered by the close. |
| [Max drawdown](glossary:max-drawdown) | The worst fall of the running total from a peak. |

## Cumulative net P&L

The running total per lot for each strategy. Look at the slope and at the falls: a strategy that
earns slowly and gives it all back in one day is a premium seller's classic risk.

## Day by day

A grid with one row per day:

| Column | Meaning |
|---|---|
| Weekday, [DTE](glossary:dte) | Day of week and trading days to expiry ("Expiry" on expiry day). |
| VIX open | [India VIX](glossary:india-vix) at the open. |
| Gap | The [opening gap](glossary:gap). |
| Index shape | The [day type](glossary:day-type) in each segment of the day (open, mid, close). |
| One column per strategy | That day's net per lot. Greyed figures are [stale](glossary:stale-version). |

**Click any figure** to replay that strategy's day underneath: the intraday MTM against the
index, markers for every entry, exit, stop and target, the best and worst MTM, and how much each
leg contributed.

## When does it work?

Results grouped by the market's day type, in two lenses:

- **Previous day**: grouped by the type of the trading day *before*. This is the only lens you
  could act on in advance ([lag-1](glossary:lag-1)).
- **Same day**: grouped by the day's own type. It explains results but cannot be traded,
  because a day's type is only known after it ends.

A scatter plots each day's result against how far the index actually moved compared with what
India VIX implied ([implied vs realised](glossary:implied-move)). Short-premium strategies
should do well on the left (the index moved less than implied) and badly on the right.

Cells with too few days are greyed: do not read anything into them.

## What it does not tell you

What happens on the kinds of day the collection has not seen yet. A few months of collected days
may not include a crash, a budget day or an election result.
