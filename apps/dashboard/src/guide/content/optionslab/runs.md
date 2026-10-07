## What it is for

Every backtest run, from the Builder, the YAML mode and the evening run, in one list, and a side-by-side
comparison of any two.

## The controls

| Control | What it does |
|---|---|
| Strategy filter | Show only one strategy's runs. |
| Compare | Tick two runs to open **Compare two runs**. |

Each row shows when it ran, its kind (Builder, YAML, or Daily for the evening run), the strategy, the period, net and the number of days. Click a run for its own summary and day-by-day table.

## Reading the comparison

Net, [win rate](glossary:win-rate), [max drawdown](glossary:max-drawdown) and worst day for each
run, with the better value in each row marked. Money rows are compared only when both runs use
the same unit (per lot vs total), so a comparison is never apples to oranges.

## Common questions

**Two runs of the same strategy differ.** Check their date ranges and costs first; then whether
the strategy was edited in between (its version).

## What it does not tell you

Whether the difference is more than noise. Over a few dozen days, a few thousand rupees per lot
can easily be luck.
