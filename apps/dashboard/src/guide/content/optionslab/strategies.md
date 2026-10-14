## What it is for

Everything you can trade, in one place: the **baskets** (the rotation lists) and the **strategies**
the evening run tests every trading day, each with its latest result. You star the ones you care
about; starred items are what [Correlation](guide:optionslab/correlation) opens on. Editing,
backtesting and saving happen in the [Builder](guide:optionslab/builder-form).

## Baskets

A basket is a rotation list: every morning at 09:16 it picks three strategies and a Buy from the
rotation variants, before the market opens. Each card shows the list's name and what it leans on,
its forward result since the first scored day (gross, two lots per strategy, without a portfolio
stop), its largest drawdown, and its weights (own results, weekday, days to expiry, VIX, family).

| Basket | What it leans on |
|---|---|
| Steady | The safest weighting. |
| Calendar | The calendar: weekday and days to expiry. |
| Adaptive | Its own recent results the most. |

Below them, **Baseline** (the old live rotation) and the **fixed base** (two Widesl and one Dir)
are comparators. They can be starred too, but they are not baskets you trade.

A dash instead of a figure means the list has no scored forward day yet, not a zero.

**Open in Today** goes to the [rotation page](guide:optionslab/rotation). **Correlate** compares the
basket with your other starred items.

## Strategies

| Column | Meaning |
|---|---|
| Star | Mark it as a favourite. Saved on the server, so it follows you to any device. Starring waits until your stars have loaded. |
| Strategy | The strategy file's name, its index, and its id when that differs. Hover for the version. |
| Legs | How many legs, what they are, and the entry and exit times. |
| Last result | Net ₹ per lot over every saved day of this version, after costs ([net vs gross](glossary:net-gross)), with the number of up days and the last day. |
| Actions | **Open in builder** loads it to edit or re-test; **Correlate** compares it with your other starred items (not offered while it has no saved result for its current version); **View results** opens [Runs](guide:optionslab/runs) filtered to this strategy. |

**Starred only** narrows both the baskets and the strategies to your favourites.

## Common questions

**How do I add a strategy here?** Choose **New strategy**, build it in the
[Builder](app:/optionslab/builder) and press **Save**. From the next evening run it is tested every
day.

**I edited a strategy and its old results vanished from the totals.** They are kept, but marked
[stale](glossary:stale-version) because they were produced by the old version. A re-run fills in
the new version's results for every collected day.

**Why can't I create a basket?** The rotation lists are registered rules, fixed before the forward
test began. Their weights are shown on the cards, and they are not edited here.
