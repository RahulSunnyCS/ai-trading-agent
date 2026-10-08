## What it is for

Every finished backtest is saved here, as **one row per strategy**: every run of the same
settings is one [strategy](glossary:saved-strategy), however often you run it. Use it to come
back to a strategy, see whether its result can be trusted and whether it moved, compare several,
and choose which ones the Friday signal follows.

## The list

| Column or control | What it shows |
|---|---|
| Dataset · Status filters | Every dataset in one list; narrow it to one dataset or one [status](glossary:favourite-status). Each label carries its count. |
| Paper + Invested n of 8 | How many of the eight places for followed favourites are used, across every dataset. |
| ☐ | Tick up to four to compare; the bar below says how many settings they differ in. |
| ★ | A star makes it a favourite (Watching). Its status is then set on the right. |
| Strategy | Its name: the one you typed, or one made from what differs from the dataset's defaults ("Broad · Tradability filter Off"). **Headline** marks the one sent to Telegram; **Group** a group of strategies. |
| Runs | How many times these settings were run (×3). Repeats with the same result add no row. |
| CAGR · Edge · Max DD · Sharpe | The latest run's numbers (Edge: CAGR over the benchmark, in points). A group shows its members' CAGR range. |
| Trust | How far the result can be trusted: [Validated, In-sample, Not tradable, Old data](glossary:strategy-trust). **↻** with the CAGR move, in points, when the latest run changed the result. |
| Status | Not a favourite, Watching, Paper or Invested. **Blocked this week** when its data is not ready. |
| Last run | When it was last run. |

**Followed** (Paper and Invested) come first and are never pruned. **Other strategies** keep
the newest 10 per dataset; a star keeps one for good. Click a row to open its drawer.

## The drawer

- **Header:** rename it, set its status, make it the [headline](glossary:headline).
- **Result:** the latest run's numbers and equity curve.
- **Different from the defaults:** only the settings that differ. Settings the dataset never
  reads are not compared, which is why some runs that looked different are one strategy.
- **Run history:** every run of these settings, newest first, with the code and data it ran on
  and, when the result moved, [why it moved](glossary:result-moved). **Re-run now to check**
  runs it again on today's code and data; the toast says what happened.
- **Notes:** a line of your own, saved when you leave the box.
- **Open in Backtest**, **Show on Backtest chart** (an overlay), **Remove** (every run of it).

## What the saved runs say

Below the list (and the compare bar) a card lists up to five findings worked out from the saved
strategies, most pressing first, each with a link to where you act:

- **Moved results to review:** a Not reproducible or Check change nobody has marked reviewed.
- **Your highest CAGR is not tradable as tested:** the top result was run with the tradability
  filter or the circuit rule off. When the same settings with both on are saved, the finding
  names that tradable version and **Compare the two** ticks both; the drawer draws it dashed
  beside the strategy.
- **Same settings, different result:** the latest run moved the result, and why.
- **Not comparable with the rest:** old data, or a different start from most strategies.
- **The validated strategies are lower than the best backtests, by design:** every higher one
  is in-sample.
- **N saved runs are M strategies:** how many repeats were folded together.

**Hide** folds the card away; this browser remembers it until you choose **Show** again.

## Why a result moved

Every run records three things: its settings, the version of the data and the version of the
code. When the same settings give a different result, they say why:

| Label | Means |
|---|---|
| Data revised | Same code, new data: prices or corporate actions were revised. Names what changed. |
| Intended change | The code changed, with an accepted change to this dataset's frozen test results in between. |
| Check | The code changed with no accepted change for this dataset, or code and data both changed. Possibly a bug. |
| Not reproducible | Same settings, code and data, different result: a bug. Sent to Telegram for a favourite. |
| Unknown | Saved before runs recorded their code and data. |

A **Check** or **Not reproducible** change counts on the Saved runs tab until you choose
**Mark reviewed** in the drawer, and also appears as an [alert](guide:start/alerts) in the bell
and pops up once a day on any screen. Every change is also kept in a log on the server.

## Favourites, their status and the headline

- **Every favourite** is re-run every Friday with that week's data, and each one's signal is
  written to the [Journal](guide:momentum/journal).
- Each favourite has a **status**: **Watching** (journalled, nothing more), **Paper** (tracked
  against your live-money rules as if it had money) or **Invested** (real money follows it).
  Watching has no limit; **Paper and Invested together are limited to 8**.
- Exactly **one** followed favourite is the **headline**: its signal goes out on Friday and it
  comes first on This week. Making a Watching favourite the headline makes it Paper.

## Groups

Several strategies of one dataset can be **one favourite**: the Phase 6 ensemble is four configs
that each trade on their own weeks. Tick them and choose **Group as one favourite**.

- The group has one status and takes **one** of the eight places; its members follow it.
  Expand the row (›) to see them.
- Each member is still evaluated and journalled every Friday. When the group is the headline,
  Telegram gets one message with the sleeves that trade this week and the combined orders.
- Removing a group keeps its members, as Watching favourites.

> [!NOTE]
> A stock-based headline (Broad, Stock, Custom Index) gets its signal from the 19:30 run, after
> the day's stock data is in.

## Common questions

**I ran the same settings again and nothing new appeared.** That is a repeat: the run count went
up and the toast said so. Each strategy keeps its last three repeats and every changed result.

**Why is my highest CAGR marked Not tradable?** It was run with the tradability filter or the
circuit rule off, so it holds stocks you could not have bought.

## What it does not tell you

A saved strategy is a backtest. The favourites' real-time record is in the Journal.
