This walkthrough uses Daily results to understand *why* a strategy loses, not just how much.

## 1. Find the bad days

Open [Daily results](app:/optionslab/results). In **Strategy comparison**, note the strategy's
**Worst day** and **Worst MTM**. In the **Day by day** grid, the strategy's column shades losing
days; find the darkest few.

## 2. Look at the context

For each bad day, read across its row: **DTE** (was it expiry?), **VIX open** (was volatility
low, so premiums were cheap?), **Gap** (did the index jump at the open?), and the **shape**
(was it a trend day?).

## 3. Replay the day

Click the loss figure. The replay shows the minute-by-minute MTM against the index, when each
leg entered and stopped out, and which leg lost the money. Typical patterns for a short
straddle:

- **Steady trend**: one leg is stopped out, the other recovers too little.
- **Whipsaw**: one leg stops out, the market reverses, and the other leg stops out too.
- **Gap**: a large overnight gap means the trouble started before entry.

## 4. Check whether it is a pattern

Open **When does it work?** and choose the strategy. Under **Previous day**, see whether losses
cluster after a particular kind of day. If they do, and there are enough days in that cell,
that is something you could act on (for example, skip the strategy after a trend day). Under
**Same day**, you will usually see trend days hurt sellers; that explains, but cannot be traded.

## 5. Test the idea, carefully

If you change the strategy because of what you found, re-run it over the whole period, not just
the bad days, and remember every tweak found this way risks
[overfitting](glossary:overfitting) to a short history.
