## What it is for

Friday's buy and sell list, and everything needed to trust it: is this week's data in, did
the scheduled runs happen, and which strategy is being sent to Telegram.

## Before you start

The scheduled jobs normally do all of this (14:40 preview, 16:45 final, 19:30 for stock-based
strategies). You only need this screen to check, to run something by hand, or to review a
stock split.

## The cards

| Card | What it shows |
|---|---|
| This week's readiness | The target week, the latest final signal, the Telegram-active strategy, and whether each dataset's data runs through that week. |
| Run the weekly signal | Run the signal yourself: choose the target week ending and **preview** or **final**. |
| Send to Telegram | Re-send the latest final signal. It asks you to confirm first. |
| Schedule & saved signals | The scheduled runs and the signals they saved. |
| Possible stock splits and bonuses | One-day drops of more than about 20% that did not match an exchange filing. Each needs a person to classify it. |

## Preview vs final

The [preview](glossary:preview-final) at 14:40 ranks on live prices so you can trade before the
close. The **final** at 16:45 uses the official close and is what the Journal records. The
two usually agree; when a name sits right at the edge of the top N, they can differ.

## Reviewing a possible split or bonus

A stock that halves overnight has usually split, not crashed. When the automatic check cannot
match the drop to a filing, it appears here and needs a person to **classify** it:

| Classification | When to choose it | What else to enter |
|---|---|---|
| Split | The company split its shares. | The **new shares per old share** (2 for a 2-for-1 split). |
| Bonus | The company issued bonus shares. | The **new shares per old share** (2 for a 1:1 bonus, which doubles the count). |
| Genuine price fall | The price really fell; nothing happened to the share count. | No factor. |

For a split or bonus, also give an **evidence URL or note** (the exchange announcement) and
save. Until a move is classified, no share adjustment is applied.

> [!WARNING]
> Getting this wrong corrupts every backtest that includes the stock. If unsure, leave it and
> check the NSE announcement first.

## Common questions

**The readiness card says a dataset is not ready.** Its data has not been refreshed through
the target week; the Friday jobs will normally fix it. Check [Jobs](app:/jobs) if it persists.

## What it does not tell you

What to actually trade given what you already hold. Use the
[Rebalance preview](guide:momentum/rebalance) for that.
