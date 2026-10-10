## What it is for

The forward test's read-out depends on a question the lists cannot answer by themselves: what kind
of market did the window test? Their weights were chosen on one period and confirmed on another,
and several of the research results read differently by period because the periods are different
markets. This card puts the forward days beside P1, P2 and P3 so that, at the read-out, "the rule
did badly" can be told apart from "the market was not like the one it was built on".

It describes markets and tests nothing. It never changes a list, a weight or the journal.

## The columns

| Column | What it is |
|---|---|
| P1 | 3 Dec 2025 to 8 Oct 2026, the sessions the weights were chosen on. |
| P2 | 10 Jan to 29 Aug 2025, the earlier slice used to confirm them. |
| P3 | 2022 to 8 Oct 2024, NIFTY only. Not in the rotation store yet, so its column is drawn empty and says so; nothing is filled in. |
| Forward | The on-time entries the journal has recorded since 12 Oct 2026, each with the attributes it recorded at 09:16. A late entry is not a forward day. |

## The rows

| Row | What it shows |
|---|---|
| Opening VIX band | The share of sessions in each band of the 09:15 VIX open, light (low VIX) to dark (high). |
| NIFTY and SENSEX days to expiry | The share of sessions 0, 1, 2, 3 and 4 or more days from the index's nearest expiry. |
| Weekday | The share of sessions on each weekday. |
| VIX open | The 10th percentile, the median and the 90th percentile of the open. |
| NIFTY and SENSEX day range | The same three percentiles of (high − low) ÷ open, from the session's 1-minute index bars. Read from the data when the card loads; never stored. |

A number appears on a segment of 9% or more; the tooltip gives every count.

## How near

For each row the card compares the forward mix with each research period using half the summed
difference of the shares. 0 means the same mix and 1 means they share nothing. The nearer period
is named per row and, on average, overall; two distances within 0.05 of each other are called
"neither" rather than a difference.

## Things to know

- **With few forward sessions the forward mix is itself noisy.** Under 20 sessions the badge says
  how many there are and the reading says this is a description of the window so far.
- **The days-to-expiry rows can differ across periods without the market being different.** When
  the expiry calendar changes, a days-to-expiry fit learnt in one period describes a different
  weekday in another.
- **A distance is not a test.** It says how the window looked, not whether the lists worked in it.
- **Sessions with no bar file are absent from the range rows**, never counted as a zero range.
