## What it is for

Everything you can trade, in one place: the **basket** (the Adaptive rotation list) and the **strategies**
the evening run tests every trading day, each with its latest result. You star the ones you care
about; starred items are what [Correlation](guide:optionslab/correlation) opens on. Editing,
backtesting and saving happen in the [Builder](guide:optionslab/builder-form).

## Baskets

A basket is a rotation list: every morning at 09:16 it picks three strategies and a Buy from the
Core pool of 298 rotation variants, before the market opens. Its row is one line: the star, the
list's name (hover for what it leans on), how many forward days are scored and since when, its
result since then, its largest drawdown, its weights (own results, weekday, days to expiry, VIX,
family), then **Open in Today** and **Correlate**. The figures are the
[Today page](guide:optionslab/rotation)'s own: gross, one lot per strategy, forward days only,
without a portfolio stop.

| Basket | What it leans on |
|---|---|
| Adaptive | Its own recent results the most. |

Below it, the **fixed base** (two Widesl and one Dir) is the comparator. It can be starred too, but
it is not a basket you trade.

> [!NOTE]
> Only Adaptive is followed, so it is the only basket shown. The journal still records Steady,
> Calendar and Baseline every morning; they are no longer shown here, and a star you set on one
> earlier stays saved but opens nothing.

While the figures load the row says so. A dash is never a zero: it comes with its reason (no
forward day scored yet, or the figures could not be read, which a line above the baskets also
says; if a refresh fails after they were read, the last figures stay and that line says so).

**Open in Today** goes to the [rotation page](guide:optionslab/rotation). **Correlate** compares the
basket with your other starred items (with nothing else starred, with the fixed base's Widesl,
N_wide_0917).

## Strategies

| Column | Meaning |
|---|---|
| Star | Mark it as a favourite. Saved on the server, so it follows you to any device. Starring waits until your stars have loaded. |
| Strategy | The strategy file's name, its index, and its id when that differs. Hover for the version. |
| Legs | How many legs, what they are, and the entry and exit times. |
| Last result | Net ₹ per lot over every saved day of this version, after costs ([net vs gross](glossary:net-gross)), with the number of up days and the last day. |
| Actions | **Open in builder** loads it to edit or re-test; **Correlate** compares it with your other starred items (not offered while it has no saved result for its current version); **History** opens its saved days in a drawer. |

**Starred only** narrows both the basket and the strategies to your favourites.

## History

**History** on a strategy's row opens every day the evening run has saved for it, in a drawer:
net per lot, win rate, worst day and largest drawdown, the running total as a line, and one row
per day (newest first) with its trades, net, worst MTM and any stop or note. Click a day for its
trade log. When the strategy has been edited, a **Version** menu (each entry says Daily, the evening
run, or Builder, and saved or older version) picks an older version's days;
those are a total, not per lot, because the older version's lot count is not known. The address
holds the open strategy (`?strategy=<id>`), so a link opens it; old links to the retired Runs page
land here. An old link whose `strategy` names no saved strategy (Runs took any filter text) says so
above the baskets, with **Dismiss**.

## Common questions

**How do I add a strategy here?** Choose **New strategy**, build it in the
[Builder](app:/optionslab/builder) and press **Save**. From the next evening run it is tested every
day.

**I edited a strategy and its old results vanished from the totals.** They are kept, but marked
[stale](glossary:stale-version) because they were produced by the old version. A re-run fills in
the new version's results for every collected day.

**Why can't I create a basket?** The rotation lists are registered rules, fixed before the forward
test began. Their weights are shown on the basket's line, and they are not edited here.
