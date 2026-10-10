# Rotation: why a pick, and does rank predict results

Two cards on the Rotation page. The first explains one list's pick on one day, criterion by
criterion. The second asks the question that matters before any pick does: does the morning ranking
order the day's results at all.

Neither card changes a list, a weight or a journal entry. They read what is stored and say what it
means.

## Why this pick?

Each morning a list ranks all 298 strategies by a composite score and takes the top three (at
least two of them Widesl), plus the best Buy when it ranks in the overall top ten. The journal
keeps the picks and their composites. It does not keep the breakdown, so this card rebuilds it from
the stored results before that day, the way the 09:16 ranking computes it, and then checks the
rebuild against the entry.

### The controls

| Control | What it does |
|---|---|
| List | A, B, C or REF. The same switch drives the other card. |
| Day | The day to explain. The arrows step through the days that can be explained; a typed date snaps to the nearest one on or before it. "Latest recorded" jumps to the newest journal entry, or the newest day with enough history when there is no entry yet. |
| A row | Click a strategy to see its criterion table. The picks are listed first by rank, with the best-ranked strategies they beat beneath. |

### The flags

| Flag | Meaning |
|---|---|
| Reconstructed | There is no journal entry for this day. The ranking was rebuilt from the stored results as they stand now. It is what the ranking would have said, not a record of what was written. |
| Recorded 09:16 | The picks and composites are the journal entry's, written before the first entry time. |
| Reconstructed, matches the entry | The rebuilt picks and composites equal the entry's to four decimals. |
| Reconstructed, inputs changed since recording | The stored results for earlier days are no longer what the entry was scored on (a repaired day, say), so the rebuild may not give the recorded picks. The entry stays the record: when the rebuild differs, the card lists what the journal recorded first, with its composite then and now, and labels the rebuilt picks as rebuilt. |
| Journal chain broken / Journal unreadable | The journal's hash chain does not verify, or a line cannot be read. No entry is shown as Recorded or counted as a forward day until it is repaired. |
| Recorded, late | Recorded after 09:17. The entry is shown, but it is not a forward day and no forward figure counts it. |

### The criterion table

The composite is five percentile ranks, each times a weight, added up. A percentile of 90% means
the strategy ranked in the top tenth of all 298 on that criterion.

| Column | What it shows |
|---|---|
| Raw, per lot | The criterion in rupees for one lot: the strategy's recent score, or its average result on the matching days. |
| 5d, 21d, 63d, 126d | How many earlier days that fit rests on in each lookback window. A window with no matching day is left out and the others are re-weighted, so a fit can rest on one old window alone. Point at a figure for the window's average. |
| Percentile | Its rank among all the strategies on that criterion. |
| Weight | The list's weight for the criterion. |
| Points | Weight times percentile. The points add up to the composite. A "!" means fewer than five matching days. Under the table, "Days and averages behind each fit" opens the matching days, the average per lot and what each window adds, as plain text. |

The line above the table says in words which criterion carried the pick and whether it rests on
few days. "Rank 3" says little; "mostly weekday fit, resting on two matching days" says where to
look.

### The lines under the table

- **Widesl minimum.** The ranks in these lines are ranks among the non-Buy variants, the pool the
  core is drawn from; the Buy line quotes the overall rank. When the top three held fewer than two
  Widesl strategies, the lowest-scoring Dir pick is swapped for the best Widesl, until two are in.
  The line names who was displaced and who replaced them, with both ranks.
- **Boundary.** The best strategy left out and how far it trailed the weakest pick. When a Dir pick
  scored above a Widesl pick and still lost its place, the gap is negative and the line says the
  minimum kept it out.
- **Buy.** A Buy strategy is added only if it ranks in the overall top ten. The line says whether it
  did, and how far short the best Buy fell.

## Does rank predict results?

If the ranking has any use, strategies ranked higher in the morning should do better that day. For
each day this card takes the rank correlation between the morning composite across all 298
strategies and that day's realised gross per strategy. +1 means the day paid in exactly the order
of the ranking, 0 means no order, −1 means the reverse.

Every strategy counts every day, so it speaks long before the top three picks can. One value per
day is kept; days are never pooled.

| Part | Meaning |
|---|---|
| Bars | The correlation for each day. Dark bars are forward days, the others research days. |
| Line and band | The running mean, with a 95% band (mean ± the Student t multiple of the standard error over days, which is wide on few days). The band is drawn, and read, only from the tenth day. |
| Dashed line | The research mean for list A over 2025-12-03 to 2026-10-08 (+0.048, the calibration of the pre-registered study), for list A only. |
| Top 30 − bottom 30 | Mean gross per lot of the 30 best-ranked strategies minus the 30 worst, in rupees. The ranking's effect in money. |

### Forward days and research days

**Forward days** are the registered test: days recorded before the first entry time and scored
since. It is empty until the first day is scored. **Research days** apply the same arithmetic to
history so the chart is useful now. They show where the ranking came from; they are not a test of
it, because the weights were chosen on them.

## What it does not tell you

- A positive mean with a band that includes zero is not yet different from chance. With a few
  weeks of days the band is wide, and on fewer than ten days it is shown as a number and not read.
  The card says so in words.
- Neighbouring days share look-back windows, so the band is a little narrower than it should be.
- A research day is scored on the stored results as they stand now. If results were repaired after
  the fact, an old entry and its research rebuild can differ; the flag says when.
- Everything is gross. The stored costs are zero.
- Rank correlation says whether the ordering carried information, not that the top three made money
  on a given day.

See also [Correlation](guide:optionslab/correlation) for whether strategies lose on the same days.
