# Rotation

The Rotation page shows how the **Adaptive** list is doing on days nobody had seen. Each morning
at 09:16 the forward journal records the strategies the list would trade that day, before anything
is known. Each evening the day is scored from the collected data. This page reads that journal; it
never changes a list, a weight or an entry.

## Adaptive and what it ranks

Adaptive ranks the **Core** pool: the 298 rotation strategies (Widesl OTM and closest-premium,
Dir ATM, Dir ITM1 and Buy at each start time, on NIFTY and SENSEX). The top of the page names both: "Adaptive · Core (298
variants)". It mixes five criteria; the numbers are the weights in percent. From Monday 19 October
2026, on a day when exactly one of NIFTY and SENSEX expires, Adaptive takes only that index's
strategies: the same ranking with the other index left out, and a Buy add-on kept only when it is
on the expiring index (the expiry rule; the 09:16 message says so in one line).
The 09:16 Telegram message lists Adaptive's strategies with their settings, then the T1 testing track (not traded);
the 16:00 message gives the day's result for both and tomorrow's strategies in full.

| Name | Key | Own recent results | Weekday | Days to expiry | VIX | Family band |
|---|---|---|---|---|---|---|
| Adaptive | C | 15 | 30 | 30 | 20 | 5 |

The name is what this page shows; the **key** is what the journal, the stored results and the API
use, so it is what you will see in a saved link or an exported file. Where a screen records a
decision (the Daily log, a saved placement) the key is shown beside the name, as "Adaptive (C)", so
an entry can be matched to the journal.

> [!NOTE]
> The journal registered four lists before the first entry, and it still records all four every
> morning: Steady (A), Calendar (B), Adaptive (C) and Baseline (REF, the old live rotation). Since
> 16 October 2026 only Adaptive is followed, so the dashboard shows only Adaptive. Steady, Calendar
> and Baseline are still recorded in the journal and scored, but no longer shown. The fixed base is
> not a list and is still shown wherever it was.

The screen is one page, in the order you read it:

- **The evening run bar** — at the top. It shows whether a Fyers login is valid (the run uses Angel
  One when it is not), when the run last finished, a *Run* button, and under *Options & log*
  the Day field, *Collect data first* and *Send summary to Telegram*. The run is also scheduled at
  15:45 on trading days; this bar is for running it by hand or seeing how the last one went.
- **The list and the headline** — forward-test status, the two Adaptive cards (Classic and
  Tuned), the headline numbers, the verdict, the cumulative chart and today's basket. Before the first scored day it shows the
  next entry instead of reserving a large empty chart area.
- **What happened** — the recorded or reconstructed day log. Below it, *Drawdowns and selection
  drift* opens the risk review for the list.
- **Lot plans** — the same morning picks traded three ways (As picked, Dir Boost, Duo), followed
  from 19 Oct 2026 for Core and T1. See [Rotation: lot plans](guide:optionslab/rotation-lot-plans).
- **Is the rule still working?** — optional diagnostics, each closed until you open it: why a pick
  was selected, the family pulse, rank correlation, and what market the forward days tested.
- **Experiments** — *Ideas being watched*: the unregistered candidates and trigger studies, each
  against what it replaced.

A link with the old `?rotationView=` in it still opens this page; the setting no longer does
anything.

## What you see

**Data health.** One line of checks: the latest session stored, how many of the 298 strategies have
that day's result, whether today's entry was recorded on time, which source gave the 09:15 VIX open,
and whether the journal's hash chain is intact. A problem names its fix underneath.

**One lot a strategy.** The owner trades one lot of each pick, so every rupee figure on this page
(the cards, the cumulative gross, the chart, the Daily log, the portfolio stop replays) is at
**1 lot per strategy**. This is display only: the journal records 2 lots a strategy and keeps that
fact; ₹ per lot-day, beats random baskets, the verdict and the 60-day read-out are the same at any
number of lots, so none of them moves.

**The two Adaptive cards.** They come first on the page, side by side:

- **Adaptive Classic** — Adaptive as the journal records it: the 298 tested variants (Core), list C
  of the live journal.
- **Adaptive Tuned** — the same picker with the 223 tuned-settings variants of the T1 track added,
  read from the T1 track's own journal (recorded at 09:16 like the live list, from 19 Oct 2026).

These two names are the cards' only: the 09:16 and 16:00 Telegram messages and the rest of the page
still say Adaptive and T1. Each card shows the gross on the latest scored day, the total since the
first forward day, the largest drawdown and the mean daily gap to the fixed base per lot (on the
same basis as the headline, so it follows that card's portfolio stop). Forward days only: a late
entry or a day not yet scored is left out. Before a day is scored every figure is a dash, not a
zero, and Adaptive Tuned says why it is waiting. The picks line opens the strategies the list
chose; it says "Today's" only when the latest entry is today's, and otherwise names the day it was
recorded for. The headline, the verdict and the chart below are Adaptive Classic's.

**Read-out banner.** "Day 18 of 60" counts scored forward sessions. The review is at 60. Until then
every figure is descriptive and changes nothing.

**Headline.** Five numbers for Adaptive, each next to the benchmark you picked and the gap:

| Number | What it is |
|---|---|
| Cumulative gross | The list's total over the scored sessions, 1 lot per strategy |
| Max drawdown | The largest fall from the running peak, the peak starting at zero |
| ₹ per lot-day | Average gross per lot per day. The fair way to compare with the base, because the list holds 3 strategies, or 4 on a day its Buy add-on fires |
| Beats random baskets | Share of 1,000 random baskets of the same shape that the list's cumulative is above |
| Sessions scored | Forward sessions counted so far, against the 60 of the read-out |

**Compare with.** The page opens on the fixed base: 2 × Widesl OTM1 at 09:17 plus 1 × Dir ATM at
09:24 every day with no ranking. Does rotating beat the simple rule at all? Random median is what
luck gives. One picker switches every comparison on the page, and the registered comparison is the
one against the base.

**Hero chart.** Cumulative gross of Adaptive and of the fixed base (a toggle), with a shaded band of
the random baskets (10th to 90th percentile). Hover for a day, click to pin it, ← → to step, Esc to
close.

**Today's basket.** The latest entry for Adaptive: start time, the strategy and its composite
score. "Widesl min" marks a day where the rule that needs at least two Widesl strategies replaced a
higher-ranked Dir pick. The line under the basket says what changed since the entry before, which
is the work list for re-setting AlgoTest by hand.

**Family pulse.** Under *Is the rule still working?* › *Why these picks…*: the twelve strategy-kind by start-band cells
the ranking pools, with their recent gross per lot-day, the rank the ranking gives each, and where
Adaptive's picks fall. See [the Family pulse](guide:optionslab/rotation-pulse).

## The portfolio stop

Each card has its own **Portfolio stop** button. It applies one stop to the combined P&L of that
card's basket at 1 lot per strategy (empty or 0 is none; optional trailing: Trail SL, Lock profit,
Lock and trail):

| Card | Default stop | Kept in the link as |
|---|---|---|
| Adaptive Classic | **8,000 rupees** | `pfstop`, `pftrail` |
| Adaptive Tuned | **9,000 rupees** | `pfstop_t1`, `pftrail_t1` |

Adaptive Classic's stop also drives the **Daily log**, **Drawdown episodes** and, once there are
forward sessions, the **headline figures and the cumulative chart**; Adaptive Tuned's changes only
its own card. The basket is replayed minute by minute and closed the first minute the stop is
reached. See the [Daily log](guide:optionslab/rotation-daily-log) page for how the stop works. Your
last setting is kept in this browser for each card separately (a stop kept from before 19 Oct 2026,
when the default was 10,000 at 2 lots, is not carried over).

The registered read-out does not move with it. **Beats random baskets**, the **verdict** and its
intervals always stay on the registered basis, without a portfolio stop, because the pre-registered
test must not change after the fact. A line under each card's button says when its figures are the
stopped ones.

## How to read it

- **Gross only.** The stored costs are zero. Net figures need the charge model applied first.
- **Missing is never zero.** A day not recorded, recorded late, or not yet scored is named, and
  left out of every figure.
- **The rule that decides.** The list beats the base when the 5-day block-bootstrap 90% interval of
  its difference per lot-day is above zero and its drawdown per lot is no worse. Sixty days is
  short: the interval is wide, so only a clear edge passes. A "no" at day 60 mostly means "not
  enough days".
- **Research reference.** On 2025-01 to 2026-10 the lists were level with the base per lot-day, with
  a smaller drawdown. That is the range the forward days are measured against, not a promise.
