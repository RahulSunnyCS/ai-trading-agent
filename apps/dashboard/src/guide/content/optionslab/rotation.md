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
the 16:00 message gives the day's result for both and tomorrow's strategies in full. Your copy (never the
friends' group) also says how the real trades did against paper, per platform and list, per lot: "AlgoTest ·
Shoonya T1  +₹910 vs +₹790 · slip +₹120 (+0.6%)" means live made ₹120 a lot more than paper, 0.6% of the
premium at entry ([slippage](glossary:slippage)). A copy deployed at another time than its entry minute is listed
as off-slot, and strategies you added by hand as [discretionary](glossary:discretionary-trade). A copy that did not trade, or whose legs were still open when read, is
named on its own line and left out, as is a copy of the tool's whose name the capture could not read (❓). "1x
assumed" means the platform no longer showed its multiplier (a day read late). "Live · not captured" means the 15:40 read did not happen; the next evening reads
that day, and `obt rotation live-compare --day` shows it (the 16:00 message is not sent again).

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

- **The run bar** — at the top: the list followed, *Compare with*, the read-out's day count
  ("Day 10 of 60 · 12 Oct → 27 Oct") and the evening run. The evening run shows how the last run
  went (the scheduled 15:45 run, or one started here) and a *Run* button; *Evening run* opens the
  Fyers token state, the days collected, the Day field, *Collect data first*, *Send summary to
  Telegram* and the log. The scheduler runs it at 15:45 on trading days; this is for running it by
  hand.
- **The books** — the data health line, the Books table (Adaptive Classic, Adaptive Tuned and the
  Fixed base, one row each) with the registered verdict under it, the cumulative chart, and the
  latest baskets of both Adaptive books. Before the first scored day it shows a short note instead
  of reserving a large empty chart area.
- **What happened** — the recorded or reconstructed day log. Below it, *Drawdowns and selection
  drift* opens the risk review for the list.
- **Lot plans** — the same morning picks traded three ways (As picked, Dir Boost, Duo), followed
  from 19 Oct 2026 for Core and T1. See [Rotation: lot plans](guide:optionslab/rotation-lot-plans).
- **Live vs paper** — what AlgoTest and Quantiply actually made on each captured day against the
  backtest for the same picks, the gap running day by day, and by shape. See
  [Rotation: live vs paper](guide:optionslab/rotation-live).
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
(the Books table, the cumulative gross, the chart, the Daily log, the portfolio stop replays) is at
**1 lot per strategy**. This is display only: the journal records 2 lots a strategy and keeps that
fact; ₹ per lot-day, beats random baskets, the verdict and the 60-day read-out are the same at any
number of lots, so none of them moves.

**The Books table.** It comes first on the page, one row a book:

- **Adaptive Classic** — Adaptive as the journal records it: the 298 tested variants (Core), list C
  of the live journal. It is the *focus*: the chart and every widget below follow it.
- **Adaptive Tuned** — the same picker with the 223 tuned-settings variants of the T1 track added,
  read from the T1 track's own journal (recorded at 09:16 like the live list, from 19 Oct 2026). Its
  figures start on its own first day, which the row says.
- **Fixed base** — the registered base, unchanged: 2 × NIFTY Widesl OTM1 09:17 + 1 × NIFTY Dir ATM
  09:24 every day, no ranking, over the same scored sessions as Adaptive Classic, at 1 lot per
  strategy (3 lots a day). Its gap column says "the base". Its own stop changes only its row; every
  comparison with the base uses the base without a stop.

| Column | What it is |
|---|---|
| Latest day | The book's gross on the latest scored day (hover for the day) |
| Since … | The total since the first scored forward day, 1 lot per strategy |
| ₹ / lot-day | Average gross per lot per day. The fair way to compare books, because a list holds 3 strategies, or 4 on a day its Buy add-on fires |
| Max DD / lot | The largest fall of the running total per lot from its peak, the peak starting at zero: the unit the registered rule compares (hover for the basket's drawdown in rupees) |
| vs base / lot-day | The book's ₹ per lot-day minus the benchmark's, over the same days. Follows *Compare with* |
| Beats random | Share of 1,000 random baskets of the same shape that the book's cumulative gross is above. Always on the registered basis, without a portfolio stop |
| Portfolio stop | The book's own stop (below) and, once its replay is in, how often it fired |

The Adaptive names are the table's only: the 09:16 and 16:00 Telegram messages and the rest of the page
still say Adaptive and T1. Forward days only: a late entry or a day not yet scored is left out.
Before a day is scored every figure is a dash, not a zero, and Adaptive Tuned says why it is
waiting.

**The registered comparisons.** Under the table, in words: Adaptive minus the fixed base per
lot-day with its 90% interval, whether its drawdown per lot is worse, and whether it beats the base
on the registered rule. It is never moved by a portfolio stop.

**Read-out chip.** "Day 10 of 60" on the run bar counts scored forward sessions. The review is at
60. Until then every figure is descriptive and changes nothing.

**Compare with.** The page opens on the fixed base: 2 × Widesl OTM1 at 09:17 plus 1 × Dir ATM at
09:24 every day with no ranking. Does rotating beat the simple rule at all? Random median is what
luck gives. The picker switches the table's gap column; the registered comparison is always the
one against the base.

**Hero chart.** Cumulative gross of Adaptive and of the fixed base (a toggle), with a shaded band of
the random baskets (10th to 90th percentile). Hover for a day, click to pin it, ← → to step, Esc to
close.

**Today's baskets.** The latest entry of each Adaptive book, Classic and Tuned side by side: start
time, the strategy and its composite score. "Widesl min" marks a day where the rule that needs at least two Widesl strategies replaced a
higher-ranked Dir pick. The line under the basket says what changed since the entry before, which
is the work list for re-setting AlgoTest by hand.

**Family pulse.** Under *Is the rule still working?* › *Why these picks…*: the twelve strategy-kind by start-band cells
the ranking pools, with their recent gross per lot-day, the rank the ranking gives each, and where
Adaptive's picks fall. See [the Family pulse](guide:optionslab/rotation-pulse).

## The portfolio stop

Each row of the Books table has its own **Portfolio stop** button, showing its level. It applies
one stop to the combined P&L of that book's basket at 1 lot per strategy (empty or 0 is none; optional trailing: Trail SL, Lock profit,
Lock and trail):

| Book | Default stop | Kept in the link as |
|---|---|---|
| Adaptive Classic | **8,000 rupees** | `pfstop`, `pftrail` |
| Adaptive Tuned | **9,000 rupees** | `pfstop_t1`, `pftrail_t1` |
| Fixed base | **8,000 rupees** | `pfstop_base`, `pftrail_base` |

Adaptive Classic's stop also drives the **Daily log**, **Drawdown episodes** and, once there are
forward sessions, its **row of the Books table and the cumulative chart**; Adaptive Tuned's and the
Fixed base's change only their own row. The basket is replayed minute by minute and closed the first minute the stop is
reached. See the [Daily log](guide:optionslab/rotation-daily-log) page for how the stop works. Your
last setting is kept in this browser for each book separately (a stop kept from before 19 Oct 2026,
when the default was 10,000 at 2 lots, is not carried over).

The registered read-out does not move with it. **Beats random baskets**, the **verdict** and its
intervals always stay on the registered basis, without a portfolio stop, because the pre-registered
test must not change after the fact. While a replay is running the row says *replaying…* and shows
the registered figures; what the stop does is also explained in its pop-up.

**Without the portfolio stop.** Once a book's replay is in, its stop cell says how often the stop
fired ("fired 1 of 10 days", and the change in rupees when there was one). Click it to open what
the stop changed under the row, over that book's own scored days:

| Line | What it says |
|---|---|
| Latest day | The latest scored day's gross with the stop and without it |
| That day | "stop reached at 11:14" and what that changed in rupees, or "stop not reached" |
| Since the first day | The total with the stop, without it, and the difference |
| Max drawdown | The largest fall of the running total, with and without the stop |
| Stop fired | On how many of the days the stop closed the basket, and its net effect on those days (with minus without) |
| Not counted | Days whose replay no longer matches the stored result (bars repaired since), left out |

Some traders call this stop an MTM SL; it is the same thing.

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
