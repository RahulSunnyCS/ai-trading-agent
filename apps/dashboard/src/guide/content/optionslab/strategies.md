## What it is for

The list of saved leg-wise strategies, the ones the evening run tests every trading day, with
each one's latest saved result. It is read-only: you edit a strategy in the
[Builder](guide:optionslab/builder-form).

## Reading the list

| Column | Meaning |
|---|---|
| Name, Underlying | The strategy file's name and its index. |
| Version | A short fingerprint of the strategy file. It changes whenever the strategy is edited. |
| Legs | How many legs, what they are, and the entry and exit times. |
| Last result | Net ₹ per lot over every saved day of this version, after costs ([net vs gross](glossary:net-gross)), with the number of up days and the last day. |
| Actions | **Open in builder** loads it into the Builder to edit or re-test; **View results** opens its days in Daily results. |

## Common questions

**How do I add a strategy here?** Build it in the [Builder](app:/optionslab/builder) and press
**Save**. From the next evening run it is tested every day.

**I edited a strategy and its old results vanished from the totals.** They are kept, but marked
[stale](glossary:stale-version) because they were produced by the old version. A re-run fills in
the new version's results for every collected day.

## What it does not tell you

How the strategy did day by day. That is [Daily results](guide:optionslab/daily-results).
