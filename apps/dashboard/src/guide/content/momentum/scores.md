## What it is for

A snapshot of momentum **today**: how strongly the market, every stock and every sector has been
rising over each lookback, without running a backtest. Use it to see what the strategies are
likely to favour, to spot what changed this week, and to sanity-check a signal.

## Before you start

Nothing; it reads the latest prices in the research database. The card's subtitle says the date
of those prices and how many stocks were scored.

## Two views: Sectors and Stocks

The switch under the header picks the view; **Sectors** is the default. The address follows
the view (`/momentum/scores/sectors`, `/sectors/<group>`, `/stocks`), so Back, a bookmark and a
shared link all land where you were.

- **Sectors** answers "where is money moving?": the [rotation map](glossary:rotation-map) and
  its table, what changed this week, and the ten strongest stocks. Click a group to open its page.
- **Stocks** answers "which stocks?": the full list below.

## Live scores on Fridays

On a Friday between 09:15 and 15:30 IST a second switch appears: **Last close | Live
(provisional)**. Live adds this Friday as if it had closed at the current Fyers prices and
recomputes every score, rank and sector from it, so you can see where the week is heading before
the close. It needs a valid Fyers login.

- It is **provisional**: nothing is saved, and once this evening's closes are stored the normal
  scores replace it. The subtitle shows the time the prices were read; they are re-read every
  five minutes.
- A stock with no live price keeps last week's close, and so does one that fell more than 40% or
  rose more than 67% (usually an unadjusted split or bonus, or a bad tick); the card says how many and names the second kind.
- Membership and the liquidity gate stay as of last week: a day's turnover is not complete until
  the close.
- A stock's drawer still shows its closing history.

## The market strip

Five tiles above the list say how healthy momentum is right now:

| Tile | What it tells you |
|---|---|
| Above 40-week average | The share of stocks trading above their own 40-week average, and how that moved against last week and four weeks ago. Momentum works best when most of the market is trending. See [market breadth](glossary:market-breadth). |
| Up over 13 weeks | The share with a positive 13-week return. |
| Median 26-week return | The middle stock's return over 26 weeks, and where the strongest tenth begins. |
| Leaders | How many stocks are strong on every horizon (see the [trend tag](glossary:trend-tag)). |
| Strongest sub-sector | The sub-sector with the highest average 26-week score, among those with at least five scored stocks. Theme baskets are not counted. |

## What changed this week

Three short lists, built from the ranking below: the **biggest climbers** (places gained since
last week), the stocks that **entered the top N** (the hold zone, up to the exit rank) and those
that **fell out of it**. A stock you hold is marked **Held**.

## The stocks list

Strongest first. The **Rank** is [Broad Momentum](glossary:broad-momentum)'s own ranking (the
[rank-sum](glossary:rank-sum) of the 1, 4, 13, 26 and 52-week returns) among the stocks scored
here; **Δ wk** is the places gained or lost since last week. A stock needs 52 weeks of prices to
have a rank. A blue edge marks the **buy zone** (rank 1 to top N) and a paler one the **hold
zone** (up to the exit rank); the numbers come from your [headline](glossary:headline) favourite, or are Broad
Momentum's defaults (10 and 20) when there is none, and the footer says which.

| Control | What it does |
|---|---|
| Search | Symbol, company or sector. Press `/` anywhere to jump to it. |
| Quick views | All, Leaders, Emerging, Fading, Near 52-week high (within 5%), Held and Candidates, each with its count. |
| Sector group | Narrow the list to one group. |
| Columns | Switch optional columns off; the choice is kept in this browser. |
| Column headers | Sort by rank, name, a lookback's score (click its `4w`, `13w`… label in the strip header), 13 or 26-week return, distance from the 52-week high or price. |
| Views | Saved views of this list (below). |
| Click a row | Opens the stock's drawer. |

The list shows 100 rows at a time: **Show more** adds the next 100.

### Saved views

Found a combination you come back to, say Leaders in Financials sorted by the 13-week score?
Set it up, open **Views** and choose **Save current view…**, type a name and press Save. A [saved
view](glossary:saved-view) keeps the quick view, the sector, the search text and the sort.

- Pick a view in the menu to apply it; **All stocks** returns to the default. The view that
  matches what you are looking at is ticked.
- Saving under a name you already use replaces that view. You can keep 12; **Delete a view** in
  the menu removes one.
- Views live in this browser only, like the column choice, so they do not follow you to another
  browser or device.
- The list **always opens on All**. A saved view is applied only when you pick it, never
  automatically. If a view names a sector or lookback that no longer exists, it opens with all
  sectors or the rank order rather than an empty list.

## Reading the results

The **How to read the strip** card under the header explains this in place, with an example of
each shape. It starts open; **Got it** folds it to a single line, and clicking that line opens it
again. The choice is kept in this browser.

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

Names marked **Held** or **Candidate** come from the headline favourite's latest weekly
run: what it holds, and what it would buy if it had cash.

## The rotation map

Each dot is one of the 24 sector groups. Left to right is how strong the group has been over 26
weeks (its average [score](glossary:score-decile) percentile, 0–100); bottom to top is whether its
4-week strength has been **rising or falling** over the last four weeks. The four corners:

| Corner | Meaning |
|---|---|
| **Leading** (top right) | Strong over 26 weeks and still improving. |
| **Weakening** (bottom right) | Strong over 26 weeks, but the recent weeks are fading. |
| **Lagging** (bottom left) | Weak over 26 weeks and not improving. |
| **Improving** (top left) | Weak over 26 weeks, but the recent weeks are picking up. |

Hover a dot for the group's stocks, strip, where it is now against four weeks ago, how many of
its stocks are above their 40-week average and its leaders; a faint tail shows where it came
from. Click a dot or a table row to open the group. Both are linked: hovering a row lights its
dot.

| Control | What it does |
|---|---|
| Search | Narrow the map and table by group name. |
| Changed quadrant only | Keep the groups that moved to another corner over the last four weeks, the ones worth a look. |
| Min stocks | A group needs this many scored stocks to get a dot (default 5; 1, 3, 5 or 10). Smaller groups stay in the table, marked "fewer than 5 scored stocks", because a score from two stocks is noise. The choice is kept in this browser. |
| Tails | How far back each tail reaches: 4, 8 or 13 weeks. |

**Cross-Sector Themes** are baskets that cut across sectors, so they are listed in the table
only and never get a dot.

## A sector page

Click a group to open it. The page shows the group's own rotation map (one dot per sub-sector,
same corners), the sub-sector table and the stocks in it. Pick a sub-sector, on the map or in its
table, to narrow the stock list to it; pick it again to clear. **← All sectors** returns to the overview.

## A stock's drawer

Click any stock, in any list, to slide its page in from the right. It shows the price and week
change, the score strip, the figures used elsewhere (rank and change, distance from the 52-week
high, % above the 40-week average, volatility, up-weeks), and three charts:

- **Price**: weekly closes over the last year with the 40-week average.
- **Scores**: the 1–10 score of each lookback over the last 12 weeks, so you see a trend forming.
- **Rank**: the composite rank over the last 26 weeks (up the page is better).

Below the figures, **Circuit locks** lists every [circuit lock](glossary:circuit-lock) of the last
52 weeks, newest first: a run of three or more sessions closing on the same price-band edge (2, 5,
10 or 20%). **Lower** means the stock fell to its limit and holders could not have sold; **Upper**,
that it rose to its limit and a buyer could not have bought. Each row gives the dates, the number
of sessions, the band and the stock's move across the lock, and **Ongoing** marks one that has not
ended yet. At most the latest 12 are listed, with the total beside them. The band is inferred from
the daily closes, so treat it as a strong hint rather than an exchange record; the definition is
the one Broad Momentum's circuit-exposure card uses on a backtest. It loads after the charts; if
it fails, the rest of the drawer is unaffected and it has its own Retry.

**← Prev** and **Next →** walk the list you opened it from, in its order.
**Open its sector** goes to the stock's group page and **Open in backtest** opens the Backtest
tab on Broad Momentum. Esc, the close button or Back closes it; the address carries
`?stock=SYMBOL`, so a drawer can be shared.

## Common questions

**Why is a stock with a high score not held?** The strategies combine several windows, apply
the buffer and the tradability filter, and in Broad Momentum pick sectors first. A single
column is not the whole story.

**Is the rank the strategy's pick?** No. It is the strategy's ranking formula applied to the
stocks scored here. The strategy also applies a pool and category step over a wider set of
prices, so its exact picks can differ.

## What it does not tell you

Whether the momentum will last. A score is a description of the past, not a prediction.
