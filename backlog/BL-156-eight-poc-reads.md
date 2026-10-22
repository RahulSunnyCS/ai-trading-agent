# BL-156 — Eight out-of-the-box POC reads: VRP, skew, PCR, overnight, post-event, condor margin, ratio spread, skip calendar

| | |
|---|---|
| **Priority** | P2 — exploratory reads on stored data and the legwise engine; no verdicts, only leads |
| **Status** | Done: no lead survives (2026-10-23) |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-10-23 |
| **Depends on** | rotation results store (BL-058), derived tables (BL-034 Phase 3), legwise engine, BL-063 charges |
| **TODO.md row** | 3.10.39 |

## Context

Owner (2026-10-23), after the breakout grids (BL-152, BL-153) and the level idea were set aside: "ideas I
haven't looked into, that I might have missed". Every options research item so far has asked *when* to enter
a short straddle or strangle, and the timing ideas (VIX gates, intraday state, pivot triggers, analog days,
breakouts) have died on unseen days. These eight change the question, the data or the structure instead.
The owner asked for a proof of concept of all eight in one overnight run, not a verdict on any.

So this item is **exploratory by design**: one read per idea, each with its measurement and lead bar fixed
here before the run, on the learning period only. A read that clears its bar becomes a **lead** and gets
its own registered item with a confirmation step; nothing here changes any list, file or live trade.

## Goal

For each of the eight ideas, one number the owner can read in the morning: does the idea show anything on
NIFTY 2024-10-09 to 2026-10-08, and is it worth a real item?

## Out of scope

- The confirmation period (NIFTY 2022-01-03 to 2024-10-08) and SENSEX: locked, not read.
- Any variant, threshold, level or strategy not listed below. A second look at a read is a new item.
- Adoption of anything: no list, base or live file changes.

## Common rules (Phase 0, registered)

- **Index and period:** NIFTY, trading days 2024-10-09 to 2026-10-08 (`rotation/days.csv`, the days the
  rotation store has results for; the data_quality verdict already excludes special sessions).
- **Trades for the state reads (1, 2, 3, 5, 8):** the owner's fixed-base strategies as stored by the rotation
  (`rotation/results/N_wide_0917.csv`, the live Widesl OTM1 09:17; `rotation/base/N_dir_atm_0924.csv`, the base
  Dir ATM 09:24), plus `N_dir_1002` for read 5. These are **gross per one lot before charges**, as the store keeps
  them; a within-strategy comparison of day groups is unaffected by charges to first order, and the item says so
  wherever a number is quoted. Nothing is re-simulated for these reads.
- **Engine reads (2b, 4, 6, 7):** `legwise.engine.simulate_day` on `legwise.market.load_day`, `lot_sizing:
  current` with the rotation's sizing date (`rotation.lists.SIZING_DATE`, NIFTY lot 65), BL-063 charges from
  `ruletest.charges.day_charges` on the trades' turnover, no slippage (reported as the same 0.5% / 1% sensitivity
  lines the rule tester uses). Days the engine cannot run are left out and counted.
- **Causality:** every state is known before the trade's entry: previous-session values from `iv_daily`
  (which is built at 15:00 of that session), or the current session's bars before the entry minute. Event
  dates are public calendars fixed in advance (listed in read 5).
- **Statistic:** for a two-group split, D = mean(gross, group A) − mean(gross, group B) in ₹ per lot-day,
  Welch t, and p from 10,000 label shuffles (seed 20261023). For a strategy on its own (reads 4, 6, 7), the mean
  net per day, its t against zero (days independent), hit rate, worst day and max drawdown.
- **Lead bar:** a read is a **lead** when |t| ≥ 2 **and** the sign is the one its hypothesis names (for a
  two-sided read, either sign). Otherwise **no lead**. Holm over all of the item's registered tests (about
  22) is reported beside each p as context; it does not change the lead bar, because this is a screen, not a
  verdict. A lead's next step is a new item with a pre-registered rule and the confirmation period.
- **Will not run:** anything after the result is seen; any re-cut of terciles, wings, times or event lists.

## The eight reads

### 1. Volatility risk premium (VRP)

- **Hypothesis:** selling premium pays more when implied vol is high relative to realised. Both base
  strategies earn more on high-VRP days.
- **State (previous session):** VRP = `front_iv_1500` of the previous trading day (the front weekly's ATM IV at
  15:00, `iv_daily`) − realised vol, the annualised standard deviation of the previous 10 sessions'
  close-to-close log returns (`iv_daily.spot_close`), both in vol points. Terciles over the period.
- **Read-out:** top tercile vs bottom tercile, D and t, for `N_wide_0917` and `N_dir_atm_0924`. Also the
  09:20 ATM straddle's own decay to 15:25 (`straddle_series_5m`, front expiry, in % of the 09:20 straddle)
  by tercile, as the mechanism check. Two tests count toward Holm.

### 2. Skew

- **Hypothesis:** when puts are much dearer than calls (`skew_1500` = IV(put, ATM−5 steps) − IV(call, ATM+5
  steps), previous session), the put side carries the premium: a Widesl that sells the PE one step further out
  (OTM2) and keeps the CE at OTM1 should lose less on high-skew days than the symmetric file, without giving
  up its gain on low-skew days.
- **2a, state read:** `N_wide_0917` top vs bottom skew tercile, D and t (one test).
- **2b, engine read:** two asymmetric Widesl variants, the live file with (PE OTM2, CE OTM1) and (PE OTM1, CE
  OTM2), everything else unchanged, run on every day; D of each against the symmetric file re-run through
  the same engine with charges, within the top skew tercile and within the bottom tercile (four tests).
  **Lead** if the PE-OTM2 variant beats symmetric in the top tercile with t ≥ 2.

### 3. Put/call volume ratio (PCR)

- **Hypothesis (two-sided):** the chain's own traded volume says something the VIX does not.
- **State:** PCR = total PE volume ÷ total CE volume of the previous session, nearest expiry, all strikes,
  from `bars_1m_option`. Terciles.
- **Read-out:** top vs bottom tercile, D and t, both base strategies (two tests).

### 4. Overnight short straddle

- **Hypothesis:** the weekly's overnight theta is worth more than the gap risk, after charges.
- **Trade:** at the 15:25 five-minute bucket of day d (`chain_snapshots_5m`), sell the ATM CE and PE (offset 0)
  of the nearest expiry with dte ≥ 1 (on an expiry day, the next weekly), at that bucket's close; buy them back
  at the close of the 09:20 bucket of the next trading day d+1 (so the fill is about 09:24, the base Dir's
  entry minute). One lot, 4 orders, BL-063 charges, no stop (there is none overnight). A pair is skipped when
  either strike has no bar at either end, and the skips are counted.
- **Read-out:** mean net per pair, t, hit rate, worst five nights, by `dte` at entry and by weekday; the
  overnight spot gap's distribution beside it (one test: the mean against zero).

### 5. Sell after a scheduled event

- **Hypothesis:** implied vol collapses once the news is out, so a straddle sold after the announcement does
  better on event days than the same straddle on other days.
- **Events (fixed in advance; the sources are in the Log):** RBI MPC decision days 2024-10-09, 2024-12-06,
  2025-02-07, 2025-04-09, 2025-06-06, 2025-08-07, 2025-10-01, 2025-12-05, 2026-02-06, 2026-04-08,
  2026-06-05, 2026-08-05, 2026-10-07 (announced about 10:00); Union Budget days 2025-02-01 and 2026-02-01
  (special weekend sessions, the speech from 11:00); the Indian session after a US FOMC decision
  (the decision lands about 00:30 IST): 2024-11-08, 2024-12-19, 2025-01-30, 2025-03-20, 2025-05-08,
  2025-06-19, 2025-07-31, 2025-09-18, 2025-10-30, 2025-12-11, 2026-01-29, 2026-03-19, 2026-04-30,
  2026-06-18, 2026-07-30, 2026-09-17.
- **Read-out:** `N_dir_1002` (the rotation's Dir ATM at 10:02, the stored results) on RBI days vs all other
  days; `N_dir_atm_0924` on Fed-morning days vs others; both base strategies on the two budget days are
  listed, not tested (two days). Two tests. With 13 and 16 events this is a read, never a verdict; the item
  says so in the result.

### 6. Same strategy, less margin (iron condor)

- **Hypothesis:** buying far wings around the live Widesl costs a small part of the premium and cuts the
  margin by more, so the **return on margin** rises even if rupees per lot fall.
- **Trades:** the live Widesl OTM1 09:17 file plus a bought CE and a bought PE, one lot each, no stops on
  the wings, everything else unchanged; wings at **OTM4** (150 points beyond the sold strike at a 50-point
  step) and at **OTM6** (250 points). The symmetric file re-run through the same engine is the control.
- **Margin assumption (stated, not measured):** the naked strangle takes the reference row's ₹1,40,000 a lot
  (`reference/margin.csv`, NIFTY short-straddle, the one row there is); a hedged side takes its maximum loss,
  width × lot, so the condor's margin is 2 × width × 65 × 1.25 (a quarter added for exchange buffers):
  OTM4 ₹24,375, OTM6 ₹40,625. The read says plainly that a real SPAN figure replaces this before anything
  is acted on.
- **Read-out:** mean net per day, t, max drawdown, then net ÷ margin and max drawdown ÷ margin, for the
  three files. **Lead** if a condor's net ÷ margin is above the naked file's by at least 50% with its own mean
  net t ≥ 2 (two tests).

### 7. Ratio spread

- **Hypothesis:** a payoff nobody here has run: long the ATM, short two further out on each side; it keeps
  the premium of a quiet day and the ATM leg pays on a trend until the short strikes.
- **Trades:** buy 1 ATM CE + 1 ATM PE, sell 2 CE + 2 PE at **OTM2** (variant A) or **OTM3** (variant B),
  09:24 entry, 15:28 exit, ₹3,000 overall stop, no leg stops, `square_off: partial`.
- **Read-out:** mean net per day, t, hit rate, max drawdown, worst five days, for A and B; `N_dir_atm_0924`
  re-run through the same engine as the comparator. Two tests (A and B against zero).

### 8. Which days to skip (a calendar, known in advance)

- **Hypothesis:** some day types are bad for short premium and can be skipped without any forecast.
- **Groups (each day may be in several):** the trading day before a holiday; the trading day after a
  holiday (or a weekend plus holiday); Mondays; the monthly-expiry week (the five trading days ending on the
  month's last NIFTY weekly expiry, from the lake's observed expiries); the first trading day of a month;
  the last trading day of a month; event days (the RBI, budget and Fed-morning dates of read 5, one group).
- **Read-out:** for each group and each base strategy, D = mean in group − mean out of group, t, p
  (fourteen tests, seven groups × two strategies). **Lead** if a group's D ≤ −₹500 with t ≤ −2 for both
  strategies (a skip would then be worth a registered item).

## Plan

### Phase 1 — Scripts (`packages/option-backtesting/research/bl156/`)

- `calendar.py`: the event dates and the day groups of read 8 (holidays from `reference/holidays.csv`,
  observed expiries from the lake).
- `states.py`: reads 1, 2a, 3, 5, 8 from the rotation store and the derived tables; writes
  `out/states.csv` (one row per day with every state and group) and `out/state_reads.csv`.
- `overnight.py`: read 4 from `chain_snapshots_5m`; writes `out/overnight.csv` and `out/overnight_read.csv`.
- `engine_runs.py`: reads 2b, 6, 7 — loads each day once, runs the seven strategies on it (symmetric Widesl,
  two asymmetric, two condors, two ratio spreads) plus the base Dir, with charges; writes
  `out/engine_days.csv` (resumable: a day already written is not rerun) and `out/engine_reads.csv`.
- `report.py`: the lead table, `out/report.md`.
- **Done when:** the four outputs exist for every day of the period, with the skipped days counted.

### Phase 2 — Read, record, close

- Fill in Result below, one line per read with its numbers and lead / no lead; `INDEX.md`, `TODO.md`; the
  findings pages (`research/options/common/` for the states, calendar and overnight; a new
  `research/options/strategies/condor/README.md` and `ratio-spread/README.md` for the structures).
- A lead gets a backlog item of its own, status Idea, naming this read as its origin.

## Risks

- **Twenty-two tests on two years:** about one |t| ≥ 2 is expected by chance. That is why a lead here only
  buys a registered item, never a change.
- **Thin events:** 13 RBI days, 16 Fed mornings, 2 budget days. Reads 5 and the event group of 8 are
  descriptive whatever they show.
- **Margin is assumed** in read 6; the ratio of naked to hedged margin is the whole claim, so a wrong
  assumption makes a wrong lead. The follow-up item would start by measuring it on AlgoTest's margin
  calculator.
- **Overnight fills at bucket closes:** the 15:25 bucket's close is the 15:29 bar and the 09:20 bucket's close
  the 09:24 bar; real fills would be at the 15:29 and 09:15 prints. Read 4 reports the 09:15 open as a
  sensitivity line.
- **Stored results are gross:** the state reads compare groups of the same strategy, so charges cancel; the
  engine reads carry charges. A quoted rupee figure says which it is.

## Open questions

- None before the run. The owner may redirect any read in the morning; a changed read is a new dated block.

## Result

**One lead under the registered bar (read 4), and it does not survive its own sensitivity line. Nothing else
clears the bar.** NIFTY, 2024-10-09 to 2026-10-08; 487 state days, 481 overnight pairs, 489 engine days × 8
strategies (no errors; 2 days left out by data_quality). Full table: `research/bl156/out/report.md` (git-ignored;
`report.py` rebuilds it).

| Read | Result | Verdict |
|---|---|---|
| 1 VRP | Widesl high vs low VRP tercile +₹520 gross, t 1.50; Dir −₹47, t −0.15. Mechanism backwards: the 09:20 straddle decays *less* on high-VRP days (mean 3.4% vs 7.0%) | No lead |
| 2a Skew (state) | Widesl high vs low skew +₹377, t 1.05 | No lead |
| 2b Skew (asymmetric Widesl) | PE at OTM2 vs symmetric, high-skew days +₹12 net, t 0.17; low-skew +₹54, t 0.58. CE at OTM2 worse in both (−₹70, −₹85) | No lead |
| 3 PCR | High vs low PCR: Widesl −₹374, t −1.06; Dir −₹411, t −1.28 | No lead |
| 4 Overnight straddle | +₹232 net a night, t 2.15, hit 59%: **lead by the bar**. But exiting at the 09:15 open instead of 09:24 gives −₹6 (t −0.08): the whole gain is the first nine minutes' premium fall (+₹256), which is intraday, not overnight. Worst nights −₹12,327 (gaps of 1.4–2.4%). By days to expiry: dte 1 (into expiry morning) +₹1,153 over 93 nights, dte 3 −₹674, dte 8 −₹2,307 | Lead on paper, explained away |
| 5 Post-event | Dir 10:02 on RBI days +₹119 vs others, t 0.14 (13 days); Dir 09:24 on Fed mornings −₹208, t −0.31 (15 days). Budget days: Dir 10:02 lost both (−₹3,357, −₹3,175) | No lead |
| 6 Condor | Wings lose money: OTM4 condor −₹146 net a day (t −1.62), OTM6 −₹22 (t −0.24), against naked Widesl +₹270 (t 2.00). With the assumed margins the condors' return on margin is negative; their drawdown is 1.3 to 3.8 times their margin | No lead |
| 7 Ratio spread | OTM2 +₹182 a day, t 1.45; OTM3 +₹55, t 0.49; base Dir +₹268, t 2.10 on the same days | No lead |
| 8 Skip calendar | No group is bad for both strategies (bar: D ≤ −₹500, t ≤ −2 for both). The opposite showed: Widesl on **event days** +₹1,774 vs rest, t 1.98, shuffle p 0.002 (Holm 0.044); Dir before a holiday +₹1,175, t 1.87 | No lead (bar is for skips) |

Notes on the two numbers that look interesting:

- **Widesl on event days** (descriptive, not a test): RBI days mean +₹2,408 (8 of 13 positive), Fed mornings
  +₹1,347 (10 of 15), the two budget days +₹4,654. Without the budget days +₹1,587, t 1.81; also without the best
  day (2025-04-09, +₹15,122) +₹1,095, t 1.46. A handful of big days carry it. If the owner wants it followed up,
  it is a new item: "Widesl on scheduled-event days, more lots", registered, tested on NIFTY 2022–24.
- **Overnight into expiry morning (dte 1)**: +₹1,153 a night over 93 nights, but the same nine-minute caveat
  applies and its worst night is −₹12,038. Descriptive.

Ten tests are below |t| 1.5; with about 30 tests one |t| ≥ 2 is expected by chance, and the screen found one
(read 4) that its own sensitivity line removes.

## Log

- 2026-10-23 — Registered (this file, the eight reads, the lead bar) before any run. Event dates from the
  RBI's MPC schedule press releases (FY2025-26 and FY2026-27), the exchanges' Budget-day special-session
  notices (2025-02-01 and 2026-02-01) and the Federal Reserve's tentative FOMC calendar for 2025 and 2026.
- 2026-10-23 — Phase 1 run: `states.py`, `overnight.py`, `engine_runs.py` (486 days × 8 strategies in about 3
  minutes), `report.py`. One deviation from the plan, recorded here: 15 Fed mornings, not 16, are trading days
  in the period (one listed date is outside the store's days). Nothing else was changed after the run.
- 2026-10-23 — **Closed: no lead survives.** See Result. Findings pages to follow in the PR.
