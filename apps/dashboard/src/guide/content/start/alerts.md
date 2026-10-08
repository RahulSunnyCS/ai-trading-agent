Some things need a person: a stock that may have split, data that did not arrive, a journal
entry that went missing. The workbench tells you in two places, on whatever screen you are on.

## The bell

The bell in the top bar lists every open alert, most severe first. The number on it is how many
are open, and its colour is the worst one: red for something broken, amber for something to
look at, blue for good news that needs a decision. Each row says what is wrong, how long it has
been open, and opens the screen where you fix it.

An alert leaves the bell on its own once the check behind it passes again. Nothing to dismiss.
The last few that cleared are listed dimmed under the open ones.

## The pop-up

When an alert is new to you, a card also appears in the top right of the page you are on, with
two buttons:

- **Review ›** opens the screen where you act on it.
- **Remind me tomorrow** closes the card. Closing it with the cross does the same.

An alert pops up **at most once a day**, however you close the card. If it is still open
tomorrow it pops up again. The bell keeps listing it in between. If several alerts are open,
the most severe comes first and the next follows when you close it. What has already popped up
is remembered in this browser only, so a second browser or device shows the cards again.

## What can raise an alert

| Alert | Opens when | Where it takes you | Clears when |
|---|---|---|---|
| A stock may have split | A stock fell sharply overnight and no [split or bonus](glossary:corporate-action) filing matches it. | [This week](app:/momentum/week), with the classify drawer open. | You classify it. |
| Data not ready | The data the [headline favourite](glossary:headline) needs has not reached this week, after the Friday run that should have brought it (16:45 for ETF prices, 19:30 for stock data). | [This week](app:/momentum/week), Run by hand. | The data arrives. |
| Journal entry missing | After the Friday 21:00 check, a favourite (or the benchmark) has no [journal](guide:momentum/journal) entry for the week, or the journal's chain fails its check. | [Journal](app:/momentum/journal). | The entry is recorded. |
| A saved result moved | A saved strategy gave a different result for the same settings and the change is labelled **Check** (amber) or **Not reproducible** (red). | [Saved runs](app:/momentum/saved), with that strategy open. | You choose **Mark reviewed** in its drawer. |
| A live-money rule | The latest rules check says a rule needs you: a drawdown line crossed, a check that cannot protect the money, the money gate ready, or numbers that stop short of this week. | [This week](app:/momentum/week), the rules strip. | The next rules check passes. |

> [!NOTE]
> The alerts are worked out from the same checks that send the Telegram messages, so the bell
> and Telegram agree. If a check cannot run for a moment (the database is busy), its earlier
> alerts stay and the bell says which check it could not run, instead of looking all clear.
