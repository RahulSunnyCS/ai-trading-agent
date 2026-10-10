## What it is for

A day-by-day record of the rotation: what each of the four lists picked at 09:16, and what those
picks then did on that day's data. Read it to answer "what did the rule say on Tuesday, what
happened to it, and did I put it on AlgoTest?". It records and shows; it never changes a pick, a
list or a result.

Three things are kept apart on this screen, and the words keep them apart:

| Word | What it is | Where it comes from |
|---|---|---|
| Scheduled | What the rule picked, written down before 09:17 | The journal, a chain that cannot be edited afterwards |
| Simulated | What each pick did on the day's data | The nightly results, one lot per strategy, gross |
| Executed | What you actually placed on AlgoTest | Your own mark, entered in the drawer |

Passing an entry time does not prove a trade happened. Only the third line says so, and only
because you wrote it.

## The two views

| View | What it shows |
|---|---|
| Recorded | The journal's entries, from the first registered trading day. A trading day with no entry is listed as *Not recorded*, never left out and never shown as zero. |
| Reconstructed | Research-history days from before the journal began, re-scored afterwards with only the results before each day. It says what the rule *would* have picked. The weights were chosen on this history, so these rows describe the rule; they are not evidence that it works. They are never mixed into the forward counters. |

Before the first entry (Monday 12 October, 09:16) the Recorded view says so and lists the four
registered lists. The Reconstructed view is there to look around in meanwhile.

## The calendar

One cell a trading day, Monday to Friday. The shading is the *shade by list* choice's gross per
lot-day: green gained, red lost, scaled to the largest day in view.

| Cell | Meaning |
|---|---|
| Hatched | An exchange holiday |
| Dashed | A trading day still to come |
| Red outline | The record is not the ordinary one: the entry was late or missing, or an input did not come from the primary source (VIX from a hand-typed value, days to expiry from the calendar) |
| "stop" under the figure | An overall stop-loss fired on the shaded list that day |
| "waiting" or "not recorded" | There is no figure, and this says why |

A stop is a result, not a record problem, so it does not get the red outline.

## The days table

One 32 px line a day, newest first.

| Column | What it shows |
|---|---|
| VIX open | The 09:15 India VIX open the entry was scored on, and where it was read from: Fyers, Angel One (the fallback when there is no Fyers login that morning), or given (typed by hand) |
| DTE N / S | Days to the nearest listed expiry for NIFTY and SENSEX |
| Recorded | The time the entry was written. After 09:17 it is *late* |
| A, B, C, REF | Gross per lot-day of the list's basket that day. Hover for the list's total in rupees and its lots. **W** marks that the Widesl minimum replaced a top-ranked Dir; **B** that a Buy strategy qualified and was added |
| Flags | Late, VIX from Angel One or by hand, days to expiry from the calendar, a stop |
| Placed | Four dots, A to REF: green placed, amber changed, red not placed, hollow not marked |
| Status | Scored, Waiting, Late or Not recorded |

> [!NOTE]
> The four lists are alternative baskets of the same shape, not four positions held together.
> Their figures are never added up, and they are compared per lot-day because a list holds 6 lots,
> or 8 when the Buy add-on was taken.

### Status

| Status | What it means |
|---|---|
| Scored | Every pick has a stored result for the day |
| Waiting | At least one pick has none yet. The line says which, or that the nightly update has not run. The list's gross stays blank until all of its picks have one |
| Late | Recorded after 09:17: shown with its results, but not a forward entry and left out of every forward counter |
| Not recorded | A trading day from the first registered day with no entry. The reason is in the tooltip (the VIX open could not be read, the job did not run, or the exchange was shut and the holiday list does not have the day) |

## Browsing filters

*All*, *Losing* (the shaded list lost money), *Stops* (an overall stop fired on any pick of any
list) and *Lists disagree*. These are for finding days to look at. A set chosen by its outcome is
biased, so no average or total is shown for a filtered set, and you should not read one off it.

## The counters

At the foot of the table, over the forward days only (or the reconstructed days, in that view):

| Counter | What it counts |
|---|---|
| Recorded, Scored | Forward entries, and how many have every result |
| Late, Not recorded | Entries after 09:17, and trading days with none |
| Buy qualified | Days a Buy strategy ranked in the overall top 10 and was added, per list |
| Widesl min applied | Days the minimum of two Widesl strategies replaced a top-ranked Dir, per list |
| All four identical | Days the four lists picked the same strategies |
| Stop fired | Days an overall stop-loss fired on any pick of any list |

## One day in full

Click a day to open it. The drawer shows each list's basket with every pick's one-lot gross, worst
mark-to-market, stop reason and score; the VIX and days to expiry the entry was scored on; and the
record: when it was written, the chain hash (copyable), the code commit, whether the chain still
verifies, and whether re-scoring today's stored results gives the same picks.

### Replaying one pick

*Replay* beside a pick re-runs that strategy's file on that day and shows it minute by minute: the
mark-to-market against the index, entries, exits and stops, and each leg's premium. It uses the
same strategy file and lot sizing as the nightly update that stored the result, so the figures
match the one in the drawer. It needs the day's 1-minute bars on the machine running the API.

### Marking what you placed

For each list choose *Placed*, *Changed* or *Not placed* and add a note ("changed" needs one, up
to 300 characters). Save writes one new row to its own file. A later mark for the same list
replaces the earlier one in the view; the earlier rows are kept. What the drawer shows after a
save is what the server read back, not what you typed.

A placement can only be marked on a day with a recorded entry.

## What it does not tell you

- Gross, not after charges. The stored results carry no brokerage or statutory charges.
- Not a result of the strategy. Days are few, and a day-by-day log of a handful of entries says
  nothing about whether the rule works. The forward read-out has its own screen and its own
  registered review.
- Not the whole basket's day. Replay shows one strategy at a time; the four lists' baskets are
  not replayed together.
