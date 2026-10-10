## What it is for

Friday's signal for every favourite, on one page: what each one buys and sells this week, the
steps of the day, your live-money rules, and anything that needs a person. The headline
favourite (the one sent to Telegram) comes first.

## Before you start

Nothing. The scheduled jobs do the work: 14:15 your orders (a Broad headline, from last Friday's
ranks), 14:40 preview (ETF favourites, and a Broad headline on live Fyers prices), 16:45 ETF final, 19:30 stock data and the stock-based final (Broad, Stock,
Custom Index), 21:00 journal check, 21:30 rules check.
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
| Your orders | The headline's trades in whole shares, against your paper portfolio (until money goes in) or your holdings read from Fyers. See below. |

## Your orders

At **14:15** on Friday a job works out the headline's orders and sends a short summary to
Telegram, so they can be placed before the 15:30 close; **Make orders now** does the same at any
time. Nothing here places an order: you place them in Fyers yourself.

- **Exact before the close.** A strategy with a one-week signal delay (the Phase 6 sleeves)
  decides this Friday's trades from last Friday's ranks, which are already stored at 14:15. Which
  names are bought and sold is therefore exact; only the share counts and a few checks that read
  Friday's own prices (the price ceiling, circuit limits, cap trims) use the latest prices.
- **Paper portfolio** (the default until money goes in): the model's portfolio at your paper
  capital (₹1,00,000, changeable in **Settings**). **Holdings from Fyers**: what your account
  holds, read-only, at 14:15 or when you press **Sync from Fyers**; any holding can be left out
  or counted as cash, and holdings can be pasted when Fyers cannot be read.
- **What is traded.** A name the model drops is sold in full and a new name is bought, whatever
  the amount. Top-ups and trims smaller than the **minimum trade** (₹10,000 by default) are shown
  as SKIP with what they would have cost. Whole shares, rounded down; sells first. A name with a
  possible split still to classify is held, never traded.
- **Charges** are estimated with the backtest's rates: STT, stamp duty, exchange fees and the DP
  charge per sale. Fyers charges no brokerage on delivery.

## Reading a group

A group's sleeves trade on their own weeks, so most Fridays only some of them rebalance. Rows
show the whole group: **After** is a name's share of the group, each sleeve weighted by its value
since the last reset in April. A week when no sleeve rebalances says so.

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

Tax on what you sell, or whether a price has moved since the orders were made. For a strategy
that is not the headline, [Rebalance](guide:momentum/rebalance) still compares any holdings with
its target.
