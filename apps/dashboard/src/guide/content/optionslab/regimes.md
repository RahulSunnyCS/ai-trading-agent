## What it is for

Labels each trading day by how the index moved, and tests whether those labels are useful: do
they last from one day to the next, and which style of strategy suited each period?

## The labels

Each stretch of the day gets one [day type](glossary:day-type), judged against the move India
VIX implied:

| Label | Meaning |
|---|---|
| Quiet ○ | The index moved well under what VIX implied. Good for option sellers. |
| Chop ≈ | It covered the implied range, but back and forth. |
| Trend up ↑ / Trend down ↓ | It covered the implied range in a clean direction. Bad for naked sellers. |
| No VIX ? | No VIX reading, so no label. |

## The controls

| Control | What it does |
|---|---|
| Cut times | Where the session is split into segments (for example open / mid / close). |
| Range, Days | Which period to study. |

## The cards

| Card | What it shows |
|---|---|
| Calendar | One cell per trading day, coloured by label. Runs of one colour are the periods. |
| Label mix | The share of days in each label, per segment. If one label dominates, the threshold is wrong, not the market. |
| Do regimes persist? | For each label today, how often tomorrow had each label, against a shuffled baseline. If tomorrow looks like the baseline, today's label tells you nothing. |
| Rolling share | Over a recent window, the share of trend days and of days that moved less than implied. The second above 50% is roughly a premium-selling climate. |
| Which style suited the period? | Stand-in measures (not real P&L) of how short premium and directional styles fared over time. |
| Comparison with the live regime tagger | How these labels line up with the paused live engine's tags. Expect partial agreement. |
| Within the day | Whether one part of the day predicts another, such as a trending open followed by a quiet close. |

> [!NOTE]
> A label is only known once its day (or segment) is over. A pattern here is only usable when
> read one day late: yesterday's label against today's outcome.

## What it does not tell you

That a label will continue. Regimes change without warning; "persistence" here is a measured
tendency over the chosen period, not a rule.
