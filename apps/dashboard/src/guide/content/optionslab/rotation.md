# Rotation

The Rotation page shows how the four registered lists (Steady, Calendar, Adaptive and Baseline)
are doing on days nobody had seen. Each morning at 09:16 the forward journal records the
strategies each list would trade that day, before anything is known. Each evening the day is
scored from the collected data. This page reads that journal; it never changes a list, a weight or
an entry.

## The four lists

Each list ranks the same 298 strategies with a different mix of five criteria. The names are what
this page shows; the **key** is what the journal, the stored results and the API use, so it is
what you will see in a saved link or an exported file. The numbers are the weights in percent.

| Name | Key | Own recent results | Weekday | Days to expiry | VIX | Family band | What it is |
|---|---|---|---|---|---|---|---|
| Steady | A | 5 | 34 | 33 | 23 | 5 | The safest cell of the weightings |
| Calendar | B | 0 | 36 | 35 | 24 | 5 | Leans on the calendar and ignores its own recent results |
| Adaptive | C | 15 | 30 | 30 | 20 | 5 | Lets its own recent results count the most |
| Baseline | REF | 33 | 25 | 25 | 17 | 0 | The old live rotation, kept as the comparator |

Where a screen records a decision (the Daily log, a saved placement) the key is shown beside the
name, as "Steady (A)", so an entry can be matched to the journal.

The screen is split into three modes so the daily workflow stays short:

- **Overview** — forward-test status, today's baskets, headline numbers, verdict and cumulative
  chart. Before the first scored day it shows the next entry instead of reserving a large empty
  chart area.
- **Journal** — the recorded or reconstructed day log, with risk review for drawdowns and selection
  drift.
- **Research** — optional diagnostics: why a pick was selected, family pulse, rank correlation,
  market context and shadow experiments. These open as focused sections rather than appearing in
  one long page.

## What you see

**Data health.** One line of checks: the latest session stored, how many of the 298 strategies have
that day's result, whether today's entry was recorded on time, which source gave the 09:15 VIX open,
and whether the journal's hash chain is intact. A problem names its fix underneath.

**The three lists.** Cards for Steady, Calendar and Adaptive come first on the Overview. Each shows
the list's gross on the latest scored day, its total since the first forward day, its largest
drawdown and its mean daily gap to the fixed base per lot. Before a day is scored every figure is a
dash, not a zero. Clicking a card makes that list the focus for the headline and chart below, and
"Today's picks" opens the strategies it chose this morning. Baseline is not a card: it is a
comparator, chosen in **Compare with**.

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

**Compare with.** The page opens on the fixed base: 2 × Widesl OTM1 at 09:17 plus 1 × Dir ATM at
09:24 every day with no ranking. Does rotating beat the simple rule at all? REF is the old live rule:
did the new weightings beat it? (It is the Baseline list; the picker calls it Baseline.) Random
median is what luck gives. One picker switches every
comparison on the page, and the registered comparisons list the base first.

**Hero chart.** Cumulative gross by the focus list, the fixed base (Baseline and the other lists are toggles), and a shaded band of the random baskets
(10th to 90th percentile). Hover for a day, click to pin it, ← → to step, Esc to close.

**Today's baskets.** The latest entry for all four lists side by side: start time, the strategy, its
composite score, and how many lists hold it. "Widesl min" marks a list where the rule that needs at
least two Widesl strategies replaced a higher-ranked Dir pick. The line under the baskets says what
changed since the entry before, which is the work list for re-setting AlgoTest by hand.

**Family pulse.** In Research › Decision diagnostics: the twelve strategy-kind by start-band cells
the ranking pools, with their recent gross per lot-day, the rank the ranking gives each, and where
the lists' picks fall. See [the Family pulse](guide:optionslab/rotation-pulse).

## The portfolio stop

The **Portfolio stop** button in the run bar applies one stop to the combined P&L of each list's
basket (10,000 rupees by default; empty or 0 is none; optional trailing: Trail SL, Lock profit,
Lock and trail). It changes what the **Daily log**, **Drawdown episodes** and, once there are
forward sessions, the **headline figures and the cumulative chart** show: the baskets are replayed
minute by minute and closed the first minute the stop is reached. See the
[Daily log](guide:optionslab/rotation-daily-log) page for how the stop works.

The registered read-out does not move with it. **Beats random baskets**, the **verdict** and its
intervals always stay on the registered basis, without a portfolio stop, because the pre-registered
test must not change after the fact. A line above the headline says when the figures shown are the
stopped ones.

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
