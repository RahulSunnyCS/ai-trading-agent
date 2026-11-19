# BL-237 — Expiry-eve straddle pair: sell the expiring index's ATM straddle, buy the other index's

| | |
|---|---|
| **Priority** | P2 — the owner's own idea, a new overnight shape the repo has not tested (every other strategy here closes the same day) |
| **Status** | In progress — Phase 0 pre-registered, nothing run |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-20 |
| **Depends on** | the legwise market loader and reference data (`legwise/market.py`, `data/reference`); BL-009's bar conventions |
| **TODO.md row** | 3.11.37 |

## Context

Owner (2026-11-20): "I need you to run one strategy. A STBT strategy. On the day before expiry (DT1), at 15:30, if it is
the NIFTY DT1 we sell the ATM NIFTY straddle and buy the SENSEX ATM straddle; do the same vice versa for SENSEX. On the
previous day of expiry we sell that instrument's ATM straddle but buy the other instrument's ATM straddle."

Answers to the design questions (same day, asked in chat): both legs close at **09:20 on the expiry day**; **1 lot each**
(a NIFTY lot and a SENSEX lot, today's sizes 65 and 20, close to equal notional); **no stops, no hedges** beyond the
bought straddle.

What exists: the legwise engine is intraday only (`legwise/schema.py` lists BTST / positional as absent), so this item
adds its own two-day simulator under `research/bl237/`. Both indexes have 1-minute option bars since 2024-10-09 in the
lake. Nothing here trades or changes a live setting.

## Goal

Say, on the registered rule below, whether the pair earns a positive amount per trade after charges and slippage in a
fit year and a test year, with neither index's side carrying the other. Nothing live changes.

## Out of scope

Other exit times, stops, lot ratios, other entry times, other pairs (BANKNIFTY and the others), the monthly expiry's
own eve, margin optimisation, and any live or paper order.

## Plan

### Phase 0 — Pre-register (committed before any run)

- **Hypothesis:** the ATM straddle of the index that expires tomorrow loses premium faster overnight and at the open than
  the other index's ATM straddle, so selling the expiring one and buying the other earns a positive amount per trade
  after charges and 0.5% slippage, with the bought straddle cushioning a gap.
- **Trades.** Two streams, one trade per expiry eve each:
  - **N-eve:** the last session before a NIFTY weekly expiry. Sell the NIFTY ATM straddle, buy the SENSEX ATM straddle.
  - **S-eve:** the last session before a SENSEX weekly expiry. Sell the SENSEX ATM straddle, buy the NIFTY ATM straddle.
  - **Eve day:** a session D with the expiring index's nearest listed weekly expiry (`pick_expiry`, the day's own symbol
    master) falling on the next session E, E being the next day both indexes have collected option bars. A calendar
    file is not used: the weekly expiry days moved in 2025 (the daily symbol master is point-in-time).
  - **Entry:** 15:30 = the close of the 15:29 bar (`price_at` convention: the price at T is the close of the bar ending
    at T; the grid's last bar is 15:29). ATM = `resolve_strike(ATM)` on that index's spot at that price (strike step 50
    NIFTY, 100 SENSEX). Both legs of each straddle on that index's **nearest weekly expiry on or after D** (for the
    expiring index this is E; for the other index it is its own next weekly, 1 to 6 sessions away).
  - **Exit:** E at 09:20 = the close of the 09:19 bar, all four contracts.
  - **Size:** 1 lot per leg at today's lot (`reference.lot_size(u, 2026-10-12)` = `rotation.lists.SIZING_DATE`).
  - **Orders:** 8 per trade (4 in, 4 out). Net = gross − ₹20 × 1.18 per order; 0.5% adverse slippage on every fill
    (sold legs fill 0.5% lower, bought legs 0.5% higher, on entry and on exit). STT, exchange and stamp charges are not
    modelled (the project's rotation net is brokerage only too).
- **Days:** every eve D in 2024-10-09 → the last collected session at the run for which both indexes have option and
  index bars on D and E and `data_quality` does not exclude either index on D or E. A trade needs all four contracts to
  exist in the chain on both days; any day that fails is **skipped and listed with its reason**, never zero-filled.
  Staleness (a leg whose last real bar is before 15:20) is counted, not skipped.
- **Primary statistic:** net per trade in rupees (at 0.5% slippage), the two streams pooled and ordered by eve date. Per
  window: the mean with a two-sided 90% circular block bootstrap (blocks of 5 trades, 2,000 resamples, **seed
  20261120**), and the maximum drawdown of the cumulative net (peak starting at zero, `readout.max_drawdown`).
- **Windows:** fit 2024-10-09 → 2025-10-08; test 2025-10-09 → the last eve. Nothing is fitted; the windows are two
  independent-in-time looks.
- **Pass / kill rule:** **pass** only if (a) the pooled mean's interval lower bound is above zero in BOTH windows, and
  (b) each stream's mean net is above zero in both windows (neither index's side carries the other). Anything else is
  **killed**. One trial, no variants. A pass allows a forward paper journal and a margin study, nothing more.
- **Descriptive only, never a rule:** gross and net with and without slippage; the sold straddle alone and the bought
  straddle alone, per stream (to see what the pairing does); the same structure on every non-eve session (the expiring
  index's nearest weekly more than one session away: the placebo, same stream names); by weekday; by size of the
  overnight gap in the sold index (bands of 0 to 0.25%, 0.25 to 0.5%, above 0.5%); mean premium sold and bought; the worst
  trade and the worst five; the count of skipped days and stale legs; a margin note (no cross-index margin offset is
  assumed: the sold straddle needs its full margin and the bought one costs its premium).
- **Look-ahead check:** the eve day and the expiry are read from the symbol master of day D (data known on D), the strikes
  from the 15:29 close on D, the exit prices from the 09:19 bar of E; no input from after the entry is used to choose
  anything; the two windows are cut by eve date and nothing is fitted. The simulator is checked on three hand-picked
  trades against the raw bars (printed, not scored) before the run.
- **Known weaknesses:** two years of weekly expiries (about 100 trades per stream) across an expiry-calendar change in
  2025; the 15:29 bar and the 09:19 bar of a deep or far option can be thin or stale (counted); the bid-ask spread of
  SENSEX options at the close is not modelled apart from the 0.5% slippage; the overnight gap includes the pre-open call
  auction, which the first 09:15 bar absorbs; a naked short straddle overnight has gap risk that two years of bars may not
  contain; the idea came from the owner before any look at the data, the test year is not unseen to the repo for other
  questions but this shape has never been tested.
- **Will not run:** another exit time, stops, lot ratios, another entry time, a single-stream version after seeing which
  stream is better, and any threshold chosen from the descriptive cuts; a run for either needs `override: <reason>`.

### Phase 0 amendment 1 — 2026-11-20, before any run (supersedes the exit time above)
The owner (2026-11-20, while the simulator was being written): "End time be 9:17." The exit is **09:17 on the expiry day**
(the close of the 09:16 bar, the engine's price at 09:17; the same print as 09:16:59), not 09:20. Everything else in
Phase 0 stands: entry 15:30, 1 lot each, no stops, the same windows, statistic, seed and pass / kill rule. No trade or
result had been computed when this was written; the original 09:20 line stays above as the first registration. Still one
trial.

### Phase 1 — Simulator and check
- **Tasks:** `research/bl237/sim.py` (the two-day loader and the pair simulation, reusing `legwise.market.load_day`,
  `data.resolver.resolve_strike`, `ReferenceData`); three hand-checked trades; skip list.
- **Deliverables:** the script and its printed hand-check.
- **Done when:** the three trades match the raw bars to the paisa and the skip list prints.

### Phase 2 — The run
- **Tasks:** `research/bl237/run.py` (every eve, both streams, with and without slippage) and `analyse.py` (windows,
  bootstrap, drawdown, descriptive cuts).
- **Deliverables:** `research/bl237/results/` (git-ignored) and the result in this item; `research/options/strategies/`
  findings page for the pair.
- **Done when:** the pass or kill is stated against the rule above, with the intervals.

## Risks

- Cross-index margin: the exchanges give no offset between a NIFTY short and a SENSEX long, so the real capital is the
  naked straddle's margin plus the bought premium. Descriptive only here.
- The simulator is new and unvalidated against a live fill; a fill at 15:30 on SENSEX options may differ from the bar close.

## Open questions

None for the run (the exit, sizing and risk were answered 2026-11-20). If it passes: a paper journal, and whether to hold
the bought straddle to its own expiry instead.

## Log

- 2026-11-20 — Phase 0 amendment 1, before any run: exit moved from 09:20 to 09:17 on the expiry day (owner).
- 2026-11-20 — created from the owner's message; design questions answered in chat (exit 09:20 on E, 1 lot each, no
  stops); Phase 0 written before any run.
