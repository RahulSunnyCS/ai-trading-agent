# BL-237 — Expiry-eve straddle pair: sell the expiring index's ATM straddle, buy the other index's

| | |
|---|---|
| **Priority** | P2 — the owner's own idea, a new overnight shape the repo has not tested (every other strategy here closes the same day) |
| **Status** | Done — killed on the registered rule: pooled net −₹455 a trade (fit, 89 trades) and −₹541 (test, 105), lower bounds below zero, both streams negative in both windows |
| **Type** | research |
| **Area** | options |
| **Created** | 2026-11-20 |
| **Depends on** | the legwise market loader and reference data (`legwise/market.py`, `data/reference`); BL-009's bar conventions; BL-159 / BL-160 (the earlier overnight short-straddle reads) |
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
- **Tasks:** `research/bl237/sim.py` (every eve, both streams, with and without slippage; `check` writes `results/`) and `analyse.py` (windows,
  bootstrap, drawdown, descriptive cuts).
- **Deliverables:** `research/bl237/results/` (git-ignored) and the result in this item; `research/options/strategies/`
  findings page for the pair.
- **Done when:** the pass or kill is stated against the rule above, with the intervals.

## Result (2026-11-20; run once, `research/bl237/sim.py check` then `analyse.py`; 194 eve trades, 396 non-eve placebo)

Net per trade in rupees after ₹23.6 an order (8 orders) and 0.5% slippage on every fill, one lot each, exit 09:17 on the
expiry day (amendment 1). The simulator was checked on three trades against the raw bars (entry = the 15:29 close, exit =
the 09:16 close, the arithmetic redone longhand to the paisa) before anything was read.

| Window | Trades | Pooled mean, 90% interval | NIFTY-eve (sell NIFTY, buy SENSEX) | SENSEX-eve (sell SENSEX, buy NIFTY) | Max drawdown |
|---|---|---|---|---|---|
| Fit 2024-10-09 → 2025-10-08 | 89 | **−₹455 [−650, −263]** | −₹283 [−473, −67] (49) | −₹665 [−966, −354] (40) | ₹40,485 |
| Test 2025-10-09 → 2026-11-18 | 105 | **−₹541 [−780, −325]** | −₹511 [−841, −179] (56) | −₹576 [−1,088, −173] (49) | ₹63,701 |

**Rule: killed.** Neither window's lower bound is above zero and neither stream is positive in either window; the interval
sits wholly below zero in both. Worst trade −₹9,176 (SENSEX eve 2026-03-18, gap −2.01%), 36% of trades won.

Descriptive (not rules; all 194 eves unless stated):
- **The pair is a zero before costs.** Gross with no slippage and no brokerage: −₹16 a trade (+₹13 fit, −₹41 test). The
  ₹189 brokerage and about ₹300 of slippage on ~₹30,000 of premium (₹10,800 sold + ₹19,200 bought) make up the −₹502.
- **The sold leg alone is positive, the bought leg pays for it.** Sold straddle alone: +₹121 a trade net (NIFTY +₹349, 77%
  winners; SENSEX −₹149). Bought straddle alone: −₹622 (NIFTY-eve's bought SENSEX −₹754; 14% winners). The other index's
  straddle bleeds more theta and spread than the gap pays back, and is no hedge on the big-gap nights.
- **Big gaps decide it.** By the sold index's overnight gap: under 0.25% (105 trades) −₹81 a trade; 0.25–0.5% (47) −₹365;
  over 0.5% (42) −₹1,707. The five worst are all gaps of 0.7% to 2.8% against the short.
- **No eve effect.** The same structure on non-eve sessions (the sold index's weekly more than one session away) loses a
  similar amount: −₹441 to −₹601 a trade in each window and stream.
- **Weekday:** Monday eves 85 trades −₹558; Wednesday eves 97 trades −₹447; ten Friday and two Tuesday eves, too few to read.

Skipped and flagged, as registered (nothing zero-filled): 27 eve trades could not be built: 21 are eves where the BOUGHT
index's own weekly expires on the eve itself (its contracts do not exist the next morning): 10 are Thursday eves between
2024-10 and 2025-01 (NIFTY's then Thursday expiry) and 11 are holiday-shifted expiries; 15 fall in the fit year and 6 in the
test year. The other 6 are a contract missing from the eve's file. 2 SESSIONS (not eves) are excluded by data_quality
(2024-11-01 Muhurat, 2025-10-21 short session). No eve leg was stale (last real bar before 15:20).

Clarifications added after the run (2026-11-20, from the Opus review on the PR; no rule changed, no number re-run):
- **The registration is ambiguous on the bought straddle's expiry.** Phase 0 says both "nearest weekly expiry on or after D"
  and "its own next weekly, 1 to 6 sessions away". The code took the first reading (`>= D`), which picks a bought contract that
  settles at the eve's close on the 21 trades above, so they were skipped as the registration says (never zero-filled). The
  second reading would run them on the next weekly; that was not run. It cannot flip the kill: the 15 fit skips would need
  about +₹2,700 each just to bring the fit mean to zero, and the 6 test skips about +₹9,500 each (the review's arithmetic).
  `long_only.py` takes the other reading (strictly after D) because it has no eve.
- **E is the holiday calendar's next trading day** with bars for both indexes (`sim.next_trading_day`), not "the next day both
  indexes have collected bars". No eve trade differs between the two; only 4 placebo trades (Budget weekend sessions) do.
- The 21 skips are logged as "no price at 09:17 on the expiry day"; the real cause is that the bought contract expired on the eve.
- There is no `run.py`: `sim.py check` writes `results/` and `analyse.py` reads it.

### Disclosure added after the run (2026-11-20)
Phase 0 did not cite BL-159 / BL-160, which read NIFTY's short overnight straddle into expiry morning (unhedged and with OTM6
wings) over this same 2024-10 → 2026-10 learning period and found the unhedged sold leg positive there; BL-160's registered
test (the hedged OTM6 cell) failed on 2022–24, and the unhedged cell reported beside it was +₹168, t 0.90. This item's sold-NIFTY-alone figure (+₹349, +₹374 fit, +₹328 test) is consistent with that finding, not new
evidence, and its fit and test windows are not unseen for the sold leg. It does not touch the verdict: the registered
quantity here is the pair, and the pair is killed. Found by reading `research/options/strategies/overnight-straddle/` after
the run; it should have been read before Phase 0 was written.

Phase 2's extra deliverable is the findings page: the BL-237 rows added to
`research/options/strategies/overnight-straddle/README.md`.

### Follow-ups after the verdict (2026-11-20, descriptive, not registered; owner's questions in chat)
Both read the same trades or the same two years, so they are leads at most, never findings.
- **Sell the straddle alone** (the pair's sold leg, 194 eves): +₹121 a trade net, intervals include zero in both windows and
  both indexes (NIFTY +₹349, SENSEX −₹149); under 0.5% gaps +₹1,000 a trade, over 0.5% −₹3,058; the worst night −₹31,954.
  Same lead BL-160 found for NIFTY and failed on 2022–24.
- **Buy every session, 15:30 → 09:17, `research/bl237/long_only.py`** (NIFTY and SENSEX, 2024-10 → 2026-11, ~510 nights an
  index, one lot, net of 0.5% slippage and 4 orders): ATM straddle −₹285 (NIFTY) and −₹256 (SENSEX) a night; OTM1 strangle
  −₹260 and −₹273; OTM2 strangle −₹251 and −₹230; 26–30% winners. Gross of costs about zero (−₹39 to +₹16), so the loss is
  the ₹94-a-night brokerage (4 orders) plus slippage on ₹13,000–17,500 of premium. Nights with a gap under 0.5% lose about
  ₹800–1,100 and gaps above 1% (70 nights) win about ₹6,400, so the strategy is a bet on the gap; a straddle that expires the
  next morning loses more (−₹554 against −₹194).

## Risks

- Cross-index margin: the exchanges give no offset between a NIFTY short and a SENSEX long, so the real capital is the
  naked straddle's margin plus the bought premium. Descriptive only here.
- The simulator is new and unvalidated against a live fill; a fill at 15:30 on SENSEX options may differ from the bar close.

## Open questions

None for the run (the exit, sizing and risk were answered 2026-11-20). If it passes: a paper journal, and whether to hold
the bought straddle to its own expiry instead.

## Log

- 2026-11-20 — ran once and closed: KILLED (pooled −₹455 fit, −₹541 test); skip list and the BL-159/160 disclosure recorded in Result.
- 2026-11-20 — Phase 0 amendment 1, before any run: exit moved from 09:20 to 09:17 on the expiry day (owner).
- 2026-11-20 — created from the owner's message; design questions answered in chat (exit 09:20 on E, 1 lot each, no
  stops); Phase 0 written before any run.
