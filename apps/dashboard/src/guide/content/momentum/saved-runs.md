## What it is for

Every finished backtest is saved here, one list per dataset. Use it to come back to a run,
compare several, and choose which strategies the Friday signal follows.

## The controls

| Control | What it does |
|---|---|
| Dataset switch | ETF Rotation or Broad Momentum: each has its own list. |
| Search, sort | Find a run by name; sort by name, period, saved date or a result. |
| Favourites only | Show only favourites. |
| Overlay | Draw the run's equity curve on the Backtest screen's chart, next to the run on screen. |
| Favourite | Mark a run as a [favourite](glossary:favourite). |
| Make Telegram active | Make this favourite the one whose signal is sent to Telegram (asks to confirm). |

## Favourites and the Telegram-active run

- **Favourites** are re-run every Friday with that week's data, and each one's signal is
  written to the [Journal](guide:momentum/journal). This is how a strategy builds an honest
  forward record.
- Exactly **one** favourite is **Telegram-active**. Its signal is the message that goes out on
  Friday. It stays on top of the list whatever the sort.
- A **readiness** badge shows whether a favourite could produce a signal right now (for
  example, whether its data has been refreshed through the target week). A blocked active
  favourite is visible here before Friday instead of being discovered from a missing message.

## Common questions

**What is "Unsaved 3" on the Backtest screen?** A run that has not finished saving yet. Once
it is saved it takes the server's name, "Run N", and appears here.

**Can I rename a run?** Yes, give runs names that say what changed ("ETF, top 3, tax on").

## What it does not tell you

A saved run is a backtest. The favourites' real-time record is in the Journal.
