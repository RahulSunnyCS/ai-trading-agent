## What it is for

A snapshot of momentum **today**: how strongly the market, every stock and every sector has been
rising over each lookback, without running a backtest. Use it to see what the strategies are
likely to favour, to spot what changed this week, and to sanity-check a signal.

## Before you start

Nothing; it reads the latest prices in the research database. The card's subtitle says the date
of those prices and how many stocks were scored.

## The market strip

Five tiles above the list say how healthy momentum is right now:

| Tile | What it tells you |
|---|---|
| Above 40-week average | The share of stocks trading above their own 40-week average, and how that moved against last week and four weeks ago. Momentum works best when most of the market is trending. See [market breadth](glossary:market-breadth). |
| Up over 13 weeks | The share with a positive 13-week return. |
| Median 26-week return | The middle stock's return over 26 weeks, and where the strongest tenth begins. |
| Leaders | How many stocks are strong on every horizon (see the [trend tag](glossary:trend-tag)). |
| Strongest sub-sector | The sub-sector with the highest average 26-week score, among those with at least five scored stocks. |

## What changed this week

Three short lists, built from the ranking below: the **biggest climbers** (places gained since
last week), the stocks that **entered the top N** (the hold zone, up to the exit rank) and those
that **fell out of it**. A stock you hold is marked **Held**.

## The stocks list

Strongest first. The **Rank** is [Broad Momentum](glossary:broad-momentum)'s own ranking (the
[rank-sum](glossary:rank-sum) of the 1, 4, 13, 26 and 52-week returns) among the stocks scored
here; **Δ wk** is the places gained or lost since last week. A stock needs 52 weeks of prices to
have a rank. A blue edge marks the **buy zone** (rank 1 to top N) and a paler one the **hold
zone** (up to the exit rank); the numbers come from your Telegram-active favourite, or are Broad
Momentum's defaults (10 and 20) when there is none, and the footer says which.

| Control | What it does |
|---|---|
| Search | Symbol, company or sector. Press `/` anywhere to jump to it. |
| Quick views | All, Leaders, Emerging, Fading, Near 52-week high (within 5%), Held and Candidates, each with its count. |
| Sector group | Narrow the list to one group. |
| Columns | Switch optional columns off; the choice is kept in this browser. |
| Column headers | Sort by rank, name, a lookback's score (click its `4w`, `13w`… label in the strip header), 13 or 26-week return, distance from the 52-week high or price. |
| Stocks / Sectors | Switch between the stock list and the sector table. |

The list shows 100 rows at a time: **Show more** adds the next 100.

## Reading the results

Each stock has a strip of small coloured cells, one per lookback (1, 2, 4, 8, 13, 26 and 52
weeks). The number is the [1–10 score](glossary:score-decile): 10 means the return over that
window is in the strongest tenth of all scored stocks, 1 in the weakest. Hover a cell for the
percentile and the raw return. The **shape** is what matters:

- Green all the way along: a **Leader**, an established trend.
- Green on the left only (1 to 8 weeks): **Emerging**, a new trend, earlier and riskier.
- Green on the right only (26 and 52 weeks): **Fading**, a trend losing steam.
- Red all the way along: a **Laggard**.

The **26 weeks** line is the price over the last half year, and **From 52w high** is how far the
last weekly close is below the highest weekly close of the year.

> [!WARNING]
> The 0–100 percentile and 1–10 score are the opposite way round from the backtest's rank
> score, where **lower is better**. Here **higher is better**; the rank column is the one where 1
> is best.

Names marked **Held** or **Candidate** come from the Telegram-active strategy's latest weekly
run: what it holds, and what it would buy if it had cash.

## The sector table

Each sub-sector shows a strip of its stocks' average score per lookback; open a row to see the
stocks in it. A stock tagged to a sector and to a theme basket appears under both.

## Common questions

**Why is a stock with a high score not held?** The strategies combine several windows, apply
the buffer and the tradability filter, and in Broad Momentum pick sectors first. A single
column is not the whole story.

**Is the rank the strategy's pick?** No. It is the strategy's ranking formula applied to the
stocks scored here. The strategy also applies a pool and category step over a wider set of
prices, so its exact picks can differ.

## What it does not tell you

Whether the momentum will last. A score is a description of the past, not a prediction.
