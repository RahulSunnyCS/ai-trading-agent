## What it is for

A snapshot of momentum **today**: how strongly every stock (or every sector) has been rising
over each lookback, without running a backtest. Use it to see what the strategies are likely to
favour and to sanity-check a signal.

## Before you start

Nothing; it reads the latest prices in the research database. The card's subtitle says the date
of those prices and how many stocks were scored.

## The controls

| Control | What it does |
|---|---|
| Stocks / Sectors | Score individual stocks, or sectors (each sector from its member stocks). |
| Parent group | Narrow the list to one group. |
| Column headers | Sort by name, price, change, member count or any lookback's score. |

## Reading the results

Each lookback column has a **score from 0 to 100**: where that return ranks among all eligible
names for that window. 100 is the strongest, 50 is the middle. The raw return is shown next to
it.

> [!WARNING]
> This score is the opposite way round from the backtest's rank score, where **lower is
> better**. Here **higher is better**.

Names marked **Held** or **Candidate** come from the Telegram-active strategy's latest weekly
run: what it holds, and what it would buy if it had cash.

## Common questions

**Why is a stock with a high score not held?** The strategies combine several windows, apply
the buffer and the tradability filter, and in Broad Momentum pick sectors first. A single
column is not the whole story.

## What it does not tell you

Whether the momentum will last. A score is a description of the past, not a prediction.
