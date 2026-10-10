## What it is for

Your real portfolio never matches the model exactly. This screen compares what you hold with
the model's target and lists the changes that would bring you in line. It never places orders.

## Before you start

Have your current holdings to hand: each instrument and its share of the portfolio (or paste
them). Any percentage you leave unallocated counts as cash.

## The controls

| Control | What it does |
|---|---|
| Strategy | Which saved strategy's target to compare against. A [group](glossary:favourite-group), such as a strategy followed on [all Fridays](glossary:all-fridays), is listed once, as the whole account. |
| Strategy live start date | For a single strategy that rebalances every 2 or 4 weeks: the Friday that counts as week 1. Not asked for a group: each of its sleeves keeps its own Fridays. |
| Current portfolio | Enter holdings one by one, or paste a list. |

## Reading the results

**Indicative changes** lists, for each instrument, what you hold, what the model holds, and the
difference: buy, sell, or leave. During market hours it uses live Fyers prices; otherwise the
latest close in the database.

The live prices are added as a temporary row for this week and the whole ranking is worked out
again with them, so the target is what the strategy would pick at today's prices. That row is
never saved. Broad Momentum quotes every stock in its pool (about 750, the default and the
turnover-ranked universes alike), so a preview takes a little longer; the whole-market universe
is too large to quote and always uses the latest close.

If live prices were expected but could not be used, a yellow note above the table says so and
why: no Fyers token, a stock Fyers returned no price for, or stock history more than ten days
old (the Friday 19:30 sync refreshes it). The table then shows the latest close.

### A group

A group is previewed as **one account**. Each sleeve's own target is worked out, then they are
mixed, each weighted by its value since the last April reset, and that mix is compared with what
you hold. The card above the table names the sleeve that trades this week (one a week for all
Fridays) and shows each sleeve's share of the account and when the others next trade. On a first
allocation every sleeve invests now, with an equal share.

## Common questions

**Should I match the model exactly?** Not necessarily. Tiny differences cost more in brokerage
than they are worth; the strategy itself only trims a holding once it is well past its cap.

## What it does not tell you

Tax consequences of selling your particular lots, or whether a price has moved since the signal.
