## What it is for

A day-by-day record of the rotation: what the Adaptive list picked at 09:16, and what those picks
then did on that day's data. Read it to answer "what did the rule say on Tuesday, what happened to
it, and did I put it on AlgoTest?". It records and shows; it never changes a pick, a list or a
result.

> [!NOTE]
> The journal records four lists every morning: Steady, Calendar, Adaptive and Baseline. Only
> Adaptive is followed, so only Adaptive is shown here. Steady, Calendar and Baseline are still
> recorded in the journal but no longer shown: not as columns, not in the drawer, the counters or
> the placement history.

Three things are kept apart on this screen, and the words keep them apart:

| Word | What it is | Where it comes from |
|---|---|---|
| Scheduled | What the rule picked, written down before 09:17 | The journal, a chain that cannot be edited afterwards |
| Simulated | What each pick did on the day's data | The nightly results, one lot per strategy, gross |
| Executed | What actually traded | The 15:40 live capture (the *Live − paper* column), or your own mark in the drawer |

Passing an entry time does not prove a trade happened. Only the third line says so, and only
because you wrote it.

From Monday 19 October 2026, on a day when exactly one of NIFTY and SENSEX expires, Adaptive takes
only that index's strategies (the expiry rule); the journal also keeps what it would have picked
without the rule, and Reconstructed days are always re-scored without it.

## Which journal

The page's **Show** selector decides whose days these are. **Adaptive Tuned** (the default) reads
the T1 track's own journal: its recorded days from 19 Oct 2026, under Adaptive Tuned's portfolio
stop, with the live column comparing the T1 book. A track has no reconstructed history and no
placement record, so the Recorded / Reconstructed switch is not offered and a day's drawer does not
offer *Marking what you placed*. **Adaptive Classic** reads the live journal as below. The **Fixed
base** has no daily picks, so the log is replaced by a short note.

## The two views

| View | What it shows |
|---|---|
| Recorded | The journal's entries, from the first registered trading day. A trading day with no entry is listed as *Not recorded*, never left out and never shown as zero. |
| Reconstructed | Research-history days from before the journal began, re-scored afterwards with only the results before each day. It says what the rule *would* have picked. The weights were chosen on this history, so these rows describe the rule; they are not evidence that it works. They are never mixed into the forward counters. |

Before the first entry (Monday 12 October, 09:16) the Recorded view says so and names the list
followed with its weights. The Reconstructed view is there to look around in meanwhile.

## The calendar

One cell a trading day, Monday to Friday. The shading is Adaptive's gross per lot-day: green
gained, red lost, scaled to the largest day in view.

| Cell | Meaning |
|---|---|
| Hatched | An exchange holiday |
| Dashed | A trading day still to come |
| Red outline | The record is not the ordinary one: the entry was late or missing, or an input did not come from the primary source (VIX from a hand-typed value, days to expiry from the calendar) |
| "stop" under the figure | An overall stop-loss fired on the list that day |
| "waiting" or "not recorded" | There is no figure, and this says why |

A stop is a result, not a record problem, so it does not get the red outline. Every cell also
says its state in words (late, not recorded, waiting, a stop) for a screen reader and for anyone
who cannot see the outline colour.

## The days table

One 32 px line a day, newest first.

| Column | What it shows |
|---|---|
| VIX open | The 09:15 India VIX open the entry was scored on, and where it was read from: Fyers, Angel One (the fallback when there is no Fyers login that morning), or given (typed by hand) |
| DTE N / S | Weekdays to the nearest listed expiry for NIFTY and SENSEX (Saturdays and Sundays are not counted). The four entries recorded before 16 Oct were scored on calendar days; they are shown converted, and the drawer says what the entry itself holds |
| Recorded | The time the entry was written. After 09:17 it is *late* |
| Adaptive | Gross per lot-day of the list's basket that day. The header carries the journal key (C) in small type. Hover for the list's total in rupees and its lots. **W** marks that the Widesl minimum replaced a top-ranked Dir; **B** that a Buy strategy qualified and was added |
| Flags | Late, VIX from Angel One or by hand, days to expiry from the calendar, a stop, and **PF stop 11:14** when the portfolio stop closed the basket (below) |
| Live − paper | What the live book made minus paper, per lot-day, both after the same estimated costs, from the 15:40 live capture (Adaptive Classic's live book is Core). **+** means live did better. Hover for each platform's live and paper figures and the day's flags. *waiting* means the capture has not read the day yet, *not captured* a gap in the capture; a day before the capture began shows a dash. It replaced the hand-marked *Placed* dots (the drawer still takes a mark) |
| Status | Scored, Waiting, Late or Not recorded |

> [!NOTE]
> The figure is per lot-day because the list holds 3 strategies, or 4 when the Buy add-on was
> taken. Rupee totals are at 1 lot per strategy, as traded (the journal records 2 lots a strategy;
> the per-lot figure is the same either way).

### Status

| Status | What it means |
|---|---|
| Scored | Every pick has a stored result for the day |
| Waiting | At least one pick has none yet. The line says which, or that the nightly update has not run. The list's gross stays blank until all of its picks have one |
| Late | Recorded after 09:17: shown with its results, but not a forward entry and left out of every forward counter |
| Not recorded | A trading day from the first registered day with no entry. The reason is in the tooltip (the VIX open could not be read, the job did not run, or the exchange was shut and the holiday list does not have the day) |

## The portfolio stop

The **Portfolio stop** button on the Adaptive Classic row of the Books table shows the stop this log follows and opens its pop-up.
It is the stop you trade the list under: one level on the *combined* P&L of the basket, on top of
each strategy's own stop. The first minute the basket's mark-to-market reaches the level, every
pick closes at that minute's close and nothing that has not entered yet enters that day.

| Field | What it does |
|---|---|
| Stop loss | Rupees for the whole basket at 1 lot per strategy. **8,000 by default** (Adaptive Classic's stop on the Rotation page; Adaptive Tuned's card has its own, 9,000). Empty, 0 or below means no portfolio stop |
| Trail SL | Every ₹X of profit the basket makes, the stop moves up ₹Y. It never moves down. Needs a stop loss |
| Lock profit | Once profit reaches ₹A, lock ₹B: the basket closes if it falls back to ₹B. Works with no stop loss |
| Lock and trail | Lock ₹B once profit reaches ₹A, then every further ₹X of profit raises the level ₹Y |

With a stop set, the list's figure in the table and the calendar is the stopped one, with the
log's own figure struck through where the stop fired and the minute in the **PF stop** flag. Hover
for both totals. Days the stop never reached are unchanged.

> [!NOTE]
> These are replayed figures: gross, at the minute close (a fast day can end past the level),
> over history the rule and the picks were chosen on. They show what a stop would have done to
> this log, not a better rule. The recorded entries, the stored results and the registered 60-day
> read-out are not changed, and the read-out stays without a portfolio stop. A stop can also cost:
> it closes days that would have recovered.

The first time over the whole history takes a few minutes while the baskets are replayed (`obt rotation portfolio-warm` does it ahead of time); the log's own figures stay on screen until the stopped ones arrive. The setting is in the page's address (`pfstop`, `pftrail`), so a copied link shows the same figures, and this browser remembers the last one you chose.

A day whose bars were repaired after the nightly update (Fyers, after an Angel One day) no longer replays to the figure the log stored. Such a list-day keeps the log's own figure, with no stopped one, and a note says how many there are.

## Browsing filters

*All*, *Losing* (the list lost money) and *Stops* (an overall stop fired on any pick of the list).
These are for finding days to look at. A set chosen by its outcome is biased, so no average or
total is shown for a filtered set, and you should not read one off it.

## The counters

At the foot of the table, over the forward days only (or the reconstructed days, in that view):

| Counter | What it counts |
|---|---|
| Recorded, Scored | Forward entries, and how many have every result |
| Late, Not recorded | Entries after 09:17, and trading days with none |
| Buy qualified | Days a Buy strategy ranked in the overall top 10 and was added |
| Widesl min applied | Days the minimum of two Widesl strategies replaced a top-ranked Dir |
| Stop fired | Days an overall stop-loss fired on any pick of the list |

## One day in full

Click a day to open it. The drawer shows Adaptive's basket with every pick's one-lot gross, worst
mark-to-market, stop reason and score; the VIX and weekdays to expiry the entry was scored on (an entry recorded before 16 Oct shows the calendar days it was scored on, and its re-score is checked on those days); and the
record: when it was written, the chain hash (copyable), the code commit, whether the chain still
verifies, and whether re-scoring today's stored results gives the same picks.

### Replaying one pick

*Replay* beside a pick re-runs that strategy's file on that day and shows it minute by minute: the
mark-to-market against the index, entries, exits and stops, and each leg's premium. It uses the
same strategy file and lot sizing as the nightly update that stored the result, so the figures
match the one in the drawer, and the replay says so under its title ("Matches the stored result").
If it does not, it says "Differs from the stored result" with both figures: the day's data was
repaired after the nightly update, or the strategy file was edited since. It needs the day's
1-minute bars on the machine running the API.

### Marking what you placed

Choose *Placed*, *Changed* or *Not placed* and add a note ("changed" needs one, up to 300
characters). Save writes one new row to its own file. A later mark for the same list
replaces the earlier one in the view; the earlier rows are kept and listed under *History* once
a mark has been corrected. Saving exactly the mark a list already has writes nothing. What the
drawer shows after a save is what the server answered, not what you typed; a refused save says
why in red and the message goes away when you edit the field. If a line of the placement file
cannot be read (a hand edit, a torn write) the log says how many are left out.

A placement can only be marked on a day with a recorded entry, and only for Adaptive Classic.

## What it does not tell you

- Gross, not after charges. The stored results carry no brokerage or statutory charges.
- Not a result of the strategy. Days are few, and a day-by-day log of a handful of entries says
  nothing about whether the rule works. The forward read-out has its own screen and its own
  registered review.
- Not what a pick does inside the basket. *Replay* beside a pick shows one strategy at a time;
  *Replay the list* in the drawer replays the whole basket minute by minute, with the portfolio
  stop.
