# Rotation: the Family pulse

A card on the Rotation page that answers one question: is morning short-premium working right now?
It lays out the twelve cells the ranking's family-band criterion pools, so you can see in one place
what each kind of strategy has been doing lately, what the ranking makes of it, and where the lists'
picks fall.

It changes nothing. It does not touch a list, a weight, the journal or a stored result.

## The twelve cells

A cell is a strategy kind in a start band, across both indices and every strike:

| Kind | What is in it |
|---|---|
| Widesl | Widesl, closest-premium Widesl included |
| Dir | Dir ATM and Dir ITM1 |
| Buy | Buy |

| Band | Start times |
|---|---|
| 09:17–10:02 | 09:17, 09:32, 09:47, 10:02 |
| 10:17–12:02 | 10:17 to 12:02 |
| 12:17–14:02 | 12:17 to 14:02 |
| 14:17–15:17 | 14:17 to 15:17 (Buy has no 15:17) |

These are exactly the groups the ranking averages for its family-band criterion. The page checks
that on every request and refuses to answer if the two ever disagree.

## The columns

| Column | What it says |
|---|---|
| Last 5, 21, 63 | The mean gross per lot-day of the cell's strategies over the last 5, 21 and 63 sessions. Beside it: sessions · variants. |
| P1, P2 | The same mean over the two reference periods the research used, so a recent number has something to be read against. |
| Rolling 21 | The 21-session mean, drawn over up to the last 126 sessions. The dashed line is the P1 mean. Hover a point for its day. |
| Ranking sees | The cell's rank, 1 to 12, on the family-band criterion for the next 09:16 pick. |
| Picks | Chips for the lists whose latest picks fall in the cell (A, B, C, REF). A count shows when a list picked twice there. |
| Share of A | How often the focus list picked in the cell over its last 21 sessions. |

Click a row to open the Strategy Matrix's pulse view, filtered to that kind and start band.

### Reading the numbers

- **Sessions are the sample.** Many variants on the same date move together, so a cell with 16
  variants over 21 sessions is 21 observations, not 336. The count to trust is the first one.
- **Gross, one lot.** Every figure is the mean of the cell's strategy-days, one lot of one strategy
  each, before charges. A list trades two lots a strategy, so these are not a list's rupees. Cells
  are never added together.
- **A dash is a missing figure, not zero.** A window with no stored result shows a dash and says why
  when hovered. A real zero shows as ₹0.
- **A star** next to a count marks a window shorter than its name, because fewer sessions exist.
- **Weekend sessions** (a special Saturday or Sunday session) are left out, as in the Matrix.
- **The index filter** (Both, NIFTY, SENSEX) narrows the means only. It is not what the ranking
  uses: "Ranking sees" is always the pooled cell across both indices.

### Ranking sees

The ranking scores every strategy by its own last ten sessions (the latest five counted double),
then averages that score over the strategy's family band. The family-band criterion is that average,
turned into a percentile among all 298. The card shows the same average ranked among the twelve cells,
so a cell at 1 of 12 is the one the criterion rewards most.

It is the same value Why this pick shows as Family-band recent; a test checks they are equal. The
criterion carries 5% of the composite in A, B and C and none in REF, so a high rank here nudges the
strategies in that cell up and decides nothing alone.

The ranking reads net results, which equal gross while the stored costs are zero. The card says gross
because that is the unit of every other figure here.

### Picks and share

- **Recorded** chips are the journal's entry for the next pick when it exists, otherwise the latest
  entry. An entry recorded after 09:17 is shown with a note and counted nowhere.
- **Reconstructed** chips appear only before any entry exists. They are the picks the rule gives for
  the latest day with attributes, from the results before it: what it would have picked, not a record.
- **Share of A** counts the focus list's core picks (three a day) that landed in the cell, over the
  last 21 recorded on-time sessions. With no entry yet it uses the last 21 reconstructed sessions and
  says so. The two are never mixed. A Buy cell has no core picks by construction, so it shows the days
  the Buy add-on sat there instead.

### The flag

A cell shows Above its P1 range or Below its P1 range when its last-21 mean sits outside the P10 to
P90 of its own rolling 21-session means in P1. It is a description of drift, the same rule
planned for the selection-drift card. It needs at least 20 rolling windows in P1; below that the row
says "no range yet". Nothing changes when a cell is flagged.

## What it is not

A strong cell describes where money was made recently. It is not a reason to change a registered
list, and a short stretch of days cannot confirm or refute a rule that was chosen on two years of
history.

## Where the numbers come from

`GET /legwise/rotation/pulse`, computed in `rotation/pulse.py` over the same cached results the
Strategy Matrix reads. The cell means are the Matrix's own pooling, so a cell equals the Matrix pooled
over the same strategies and days. The rank is computed from the same helpers the 09:16 ranking calls.
