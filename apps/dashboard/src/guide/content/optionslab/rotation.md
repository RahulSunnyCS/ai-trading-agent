# Rotation

The Rotation page shows how the four registered lists (A, B, C and REF) are doing on days nobody
had seen. Each morning at 09:16 the forward journal records the strategies each list would trade
that day, before anything is known. Each evening the day is scored from the collected data. This
page reads that journal; it never changes a list, a weight or an entry.

## What you see

**Data health.** One line of checks: the latest session stored, how many of the 298 strategies have
that day's result, whether today's entry was recorded on time, which source gave the 09:15 VIX open,
and whether the journal's hash chain is intact. A problem names its fix underneath.

**Read-out banner.** "Day 18 of 60" counts scored forward sessions. The review is at 60. Until then
every figure is descriptive and changes nothing.

**Headline.** Five numbers for the focus list, each next to the benchmark you picked and the gap:

| Number | What it is |
|---|---|
| Cumulative gross | The list's total over the scored sessions, 2 lots per strategy |
| Max drawdown | The largest fall from the running peak, the peak starting at zero |
| ₹ per lot-day | Average gross per lot per day. The fair way to compare lists, because a list holds 6 lots, or 8 on a day its Buy add-on fires |
| Beats random baskets | Share of 1,000 random baskets of the same shape that the list's cumulative is above |
| Sessions scored | Forward sessions counted so far, against the 60 of the read-out |

**Compare with.** REF is the old live rule: did the new weightings beat it? Fixed base is
2 × Widesl OTM1 at 09:17 plus 1 × Dir ATM at 09:24 every day with no ranking: does rotating beat the
simple rule at all? Random median is what luck gives. One picker switches every comparison on the
page.

**Hero chart.** Cumulative gross by list, the fixed base, and a shaded band of the random baskets
(10th to 90th percentile). Hover for a day, click to pin it, ← → to step, Esc to close.

**Today's baskets.** The latest entry for all four lists side by side: start time, the strategy, its
composite score, and how many lists hold it. "Widesl min" marks a list where the rule that needs at
least two Widesl strategies replaced a higher-ranked Dir pick. The line under the baskets says what
changed since the entry before, which is the work list for re-setting AlgoTest by hand.

**Family pulse.** Below the baskets: the twelve strategy-kind by start-band cells the ranking pools,
with their recent gross per lot-day, the rank the ranking gives each, and where the lists' picks
fall. See [the Family pulse](guide:optionslab/rotation-pulse).

## How to read it

- **Gross only.** The stored costs are zero. Net figures need the charge model applied first.
- **Lists are alternatives.** They are never added together; they are four ways to trade the same day.
- **Missing is never zero.** A day not recorded, recorded late, or not yet scored is named, and
  left out of every figure.
- **The rule that decides.** A list beats the base when the 5-day block-bootstrap 90% interval of its
  difference per lot-day is above zero and its drawdown per lot is no worse. Sixty days is short: the
  interval is wide, so only a clear edge passes. A "no" at day 60 mostly means "not enough days".
- **Research reference.** On 2025-01 to 2026-10 the lists were level with the base per lot-day, with
  a smaller drawdown. That is the range the forward days are measured against, not a promise.
