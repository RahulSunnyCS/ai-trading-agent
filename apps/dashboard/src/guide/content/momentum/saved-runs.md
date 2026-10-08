## What it is for

Every finished backtest is saved here, one list per dataset. Use it to come back to a run,
compare several, and choose which strategies the Friday signal follows.

## The controls

| Control | What it does |
|---|---|
| Dataset switch | ETF Rotation or Broad Momentum: each has its own list. |
| Search, sort | Find a run by name; sort by name, period, saved date or a result. |
| All · Favourites · Invested · Paper · Watching | Show every run, or only favourites, or one [status](glossary:favourite-status). Each label carries its count. |
| Paper + Invested n of 8 | How many of the eight places for followed favourites are used, across every dataset. |
| Overlay | Draw the run's equity curve on the Backtest screen's chart, next to the run on screen. |
| Favourite | The run's status: Not a favourite, Watching, Paper or Invested. |
| Make headline | Make this favourite the [headline](glossary:headline): the one sent to Telegram (asks to confirm). |
| Group as one favourite | With two or more runs of this dataset ticked, make them one [group](glossary:favourite-group). |

## Favourites, their status and the headline

- **Every favourite** is re-run every Friday with that week's data, and each one's signal is
  written to the [Journal](guide:momentum/journal). This is how a strategy builds an honest
  forward record.
- Each favourite has a **status**: **Watching** (journalled, nothing more), **Paper** (tracked
  against your live-money rules as if it had money) or **Invested** (real money follows it).
  Watching has no limit; **Paper and Invested together are limited to 8**. A ninth is refused
  until you set one to Watching.
- Exactly **one** followed favourite is the **headline**. Its signal is the message that goes
  out on Friday, and it comes first on This week. It stays on top of this list whatever the sort.
  Making a Watching favourite the headline makes it Paper.
- A **readiness** badge shows whether a favourite could produce a signal right now (for
  example, whether its data has been refreshed through the target week). A blocked headline is
  visible here before Friday instead of being discovered from a missing message.

## Groups

Several runs of one dataset can be **one favourite**: the Phase 6 ensemble is four configs that
each trade on their own weeks. Tick them, choose **Group as one favourite** and name it.

- The group has one status and takes **one** of the eight places. Its runs show "In <group>"
  and follow its status.
- Each run is still evaluated and journalled every Friday on its own. When the group is the
  headline, Telegram gets **one** message: which runs (sleeves) trade this week, the combined
  buys and sells, and the holds. A week when none of them rebalances says so, and when the next
  one does.
- The combined portfolio weights each run by its value since the last reset in April, the way
  the ensemble's backtest does, not a flat share each.
- **Remove group** deletes the group only; its runs stay, as Watching favourites.

> [!NOTE]
> A stock-based headline (Broad, Stock, Custom Index) gets its signal from the 19:30 run, after
> the day's stock data is in. The 14:40 and 16:45 runs say nothing about it rather than report it
> as blocked every Friday.

## Common questions

**What is "Unsaved 3" on the Backtest screen?** A run that has not finished saving yet. Once
it is saved it takes the server's name, "Run N", and appears here.

**Can I rename a run?** Yes, give runs names that say what changed ("ETF, top 3, tax on").

## What it does not tell you

A saved run is a backtest. The favourites' real-time record is in the Journal.
