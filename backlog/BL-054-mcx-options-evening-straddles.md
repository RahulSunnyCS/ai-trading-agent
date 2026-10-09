# BL-054 — MCX commodity options: collect the data, then test straddles and strangles in the 17:00–23:00 session

| | |
|---|---|
| **Priority** | P0 — set by the owner (2026-10-09). Time-critical: an expired contract's 1-minute history cannot be downloaded from Fyers again, so every expiry not collected is lost for good. Phases 0–1 (survey, collector, backfill) come first; the strategy research follows once enough days are collected |
| **Status** | Planned |
| **Type** | feature (Phases 0–3), research (Phase 4) |
| **Area** | options / trading-data (+ infra for the schedule) |
| **Created** | 2026-10-09 |
| **Depends on** | [BL-034](BL-034-options-history-lake.md) (lake, quality table); [BL-012](BL-012-scheduler-service.md) (a late-night job); a Fyers login on the laptop; [BL-015](BL-015-research-gate.md) before Phase 4 runs |
| **TODO.md row** | — (filled in when started) |

## Context

**The owner's idea (2026-10-09):** go through the MCX market, ingest its data, and test
straddles and strangles on the liquid MCX options, focusing on **17:00–23:00** but testing the
whole session too.

Why the evening is interesting: the NSE/BSE strategies stop at 15:30, while MCX trades into the
night, through the US cash open and the US data releases. That is a separate window, with
separate drivers, that the owner can trade after work.

**Nothing for MCX exists yet.** What the repo has, and what each piece assumes:

| Piece | Where | MCX gap |
|---|---|---|
| Daily Fyers collector (`obt daily`, `obt fyers fetch`) | `option_backtesting/fyers/daily.py`: `UnderlyingSpec(name, index_symbol, segment, cadence)`, five NSE/BSE indices | Assumes a **spot index** to centre strikes on. MCX options are options **on a futures contract**; the strike centre is that future's price |
| Symbol master | `fyers/symbols.py` (`public.fyers.in/sym_details/<SEG>.csv`) | Generic per segment; MCX is `MCX_COM` (to confirm in Phase 0) |
| History backfill | `fyers/history.py` (≤ 95-day chunks, `minute_candles_range`) | `MIN_BARS` / "375 bars a day" is an NSE constant |
| Lake | `trading_data/lake.py`: `bars_1m/asset=option|future/underlying=…/date=…` | Layout is session-agnostic, so it works as is. `instruments.asset_class` already has `commodity` |
| Leg-wise engine | `legwise/market.py`: a fixed **375-minute grid from 09:15**; `legwise/schema.py` rejects any time outside 09:15–15:29 | MCX trades about **09:00–23:30, or 23:55 while the US is on standard time** (to confirm), i.e. ~870–895 minutes, with the close moving twice a year |
| Derived tables, anatomy, data quality | `trading_data/derived.py` (75 five-minute windows), `legwise/anatomy.py` (`252 × 375` minutes a year), `trading_data/quality.py` | All sized to the NSE session |
| Reference data | `lot_sizes.csv`, `strike_step.csv`, `expiries`, holidays, costs | NSE/BSE only. MCX lots are in units (barrels, mmBtu, grams/kg), and it has its own holidays, including days with **an evening session only** (to confirm) |

**The data-history constraint decides the timeline.** Fyers serves 1-minute history only for
contracts that are **still listed**: an expired contract drops out of the symbol master and its
history goes with it (BL-038 found the same for stock options). It does serve a live contract's
**whole life**, in ≤ 100-day chunks. So:

- **Today's backfill:** every live MCX future and option, back to its listing. That gives a few
  months, but for past days most of it is the *next*-month contract, which is thinner than the
  near month that day.
- **From now on:** collect every night (or at least on every options expiry). Each expiry missed
  is lost for good.
- **Longer history** needs another source (the BL-034 vendor, if it carries MCX, or AlgoTest).
  Without one, a fair straddle verdict needs roughly **6–12 months of collection** first. MCX
  options expire monthly (to confirm), so a year is only about 12 expiry cycles.

**Contracts likely worth a look** (to confirm with Phase 0's liquidity numbers, not assumed):
CRUDEOIL and CRUDEOILM options, NATURALGAS and NATGASMINI options (the most active); GOLD, GOLDM,
SILVER and SILVERM options (probably thinner, especially away from the money).

**Evening events to tag, not trade blindly** (times to confirm; they shift by an hour with US
daylight saving): the US cash open (19:00 IST in the US summer, 20:00 in winter), the weekly EIA
crude inventory report (Wednesdays), the EIA natural gas storage report (Thursdays), US CPI and
payrolls, and OPEC meetings. A short straddle across one of these is a different trade from one
on a quiet night.

**Sandbox note (2026-10-09):** the cloud session that wrote this item could not reach
`public.fyers.in` (network policy), so no MCX data was surveyed or ingested. Every phase that
talks to Fyers runs on the laptop.

## Goal

1. A measured list of liquid MCX option underlyings (Phase 0), chosen by the owner.
2. Every night from the start date, the chosen MCX options and futures land in the lake with a
   `data_quality` verdict, and every currently listed contract's history is backfilled once.
3. MCX reference data (lots, strike steps, expiries, sessions, holidays, costs) in the catalog,
   checked against the exchange's contract specifications.
4. The leg-wise engine runs a strategy on any exchange's session, with **every NSE golden result
   unchanged**.
5. A pre-registered verdict on short straddles/strangles in the 17:00–23:00 window (and the
   whole-session grid), once enough days are collected.

## Out of scope

- Live trading or AlgoTest deployment (the repo places no orders).
- Agricultural commodities and MCX index options.
- Futures-only strategies (the futures are collected as the strike centre and for later use).
- A long backfill that Fyers cannot serve. That depends on a vendor answer (open question 2).

## Plan

### Phase 0 — Survey (laptop, about an hour; no lake writes)
- **Tasks:**
  - Download the `MCX_COM` master. List every underlying with options: expiries listed, strikes
    per expiry, lot size, and the underlying future each option series refers to.
  - For each candidate, pull 5 recent sessions of 1-minute bars for the near-month future and
    ATM ±5 strikes. Measure **per hour of the session**: minutes with at least one trade, median
    volume per minute, and the high–low range per minute as a spread proxy. 17:00–23:00 is
    reported separately.
  - Confirm from Fyers: how far back a live contract's 1-minute history goes; the session times
    in the bars (09:00 start; 23:30 or 23:55 end); and, on the next options expiry, how soon after
    the close the expired contract disappears from the master and the history API.
- **Deliverables:** a liquidity table in the Log and the confirmed facts.
- **Done when:** the owner has picked the underlyings, and the collector's run time is set from
  the measured disappearance time.

### Phase 1 — Collector and one-off backfill (time-critical)
- **Tasks:**
  - Generalise `UnderlyingSpec`: the strike centre can be a futures contract (the option series'
    own underlying future, read from the master), not only an index. Add the chosen MCX
    underlyings with segment `MCX_COM`.
  - Strike walk as today (premium floor, stop after cheap strikes, caps), for the near and next
    option expiries; the near and next futures kept.
  - Register instruments with exchange `MCX` and asset class `commodity` / `option` / `future`;
    write to the existing lake paths (`underlying=CRUDEOIL`, …).
  - `trading_data.quality`: per-exchange session length, so an MCX day is judged against its own
    minutes and a US-winter day is not flagged as short.
  - A scheduler job after the MCX close, at the time Phase 0 measured, with a morning catch-up
    and a Telegram alert when an expiry day was missed (BL-012 pattern). It must not clash with
    the evening `obt daily` (BL-047 job locks).
  - The one-off backfill of every live contract of the chosen underlyings.
  - Tests: the futures-centred strike selection, the MCX master parsing, the session-aware
    quality check; the NSE collector's tests unchanged.
- **Deliverables:** `obt fyers fetch --exchange mcx` (or a flag on `obt daily`), the scheduled
  job, the backfill in the lake, `tdata status` showing MCX rows.
- **Done when:** five consecutive nightly runs have landed with quality verdicts, and the
  backfill is complete.

### Phase 2 — MCX reference data
- **Tasks:**
  - Lot size and unit per contract (effective-dated, like `lot_sizes.csv`), strike steps, and the
    expiry list derived from the lake (`tdata reference derive-expiries` extended).
  - A **session calendar**: start and end for every day, the US daylight-saving switch of the
    close, MCX holidays, and evening-only sessions.
  - Costs: brokerage, exchange transaction charges, CTT on option sales (MCX's equivalent of STT),
    stamp duty and GST, each checked against the current rate cards. Margin for short options
    (SPAN plus exposure), from the exchange files if Fyers does not give it.
  - What happens at options expiry (MCX options devolve into futures, to confirm) and what that
    means for a position still open at expiry.
- **Done when:** every value has a cited source in the CSV comments, and a hand check of one
  CRUDEOIL day's lot, cost and session matches the broker's contract note or calculator.

### Phase 3 — Engine on any session
- **Tasks:**
  - `legwise/market.py`: the grid length and start from the day's session (calendar), not
    constants; `legwise/schema.py` validates times against the strategy's exchange; `anatomy`,
    `derived` and `forensics` take the session length from the same place.
  - The strike reference for MCX is the underlying future's price at the minute (ATM, OTMn and
    ITMn resolved against it).
  - Strategy YAML gains `exchange: MCX` (default NSE, so every existing file is unchanged).
- **Deliverables:** MCX strategies run in `obt legwise run`; the Options Lab Builder offers the
  MCX underlyings and session times.
- **Done when:** the 30 leg-wise goldens and the engine goldens are **byte-identical**, and three
  hand-computed MCX scenarios (an entry at 17:00, a stop hit in the evening, an exit at the
  close on a US-winter day) match to the rupee.

### Phase 4 — Straddles and strangles (research; after enough days)
#### Phase 4.0 — Pre-register (committed before any run)
- **Hypothesis:** a short ATM straddle or a 1–2-strike OTM strangle on the chosen underlyings,
  entered in the evening and closed by 23:00, earns a positive return after costs, because the
  option premium over the evening is larger than the move the evening delivers.
- **Grid (fixed; the whole session is tested, as the owner asked, with the evening as the focus):**
  entry {09:15, 12:00, 15:30, 17:00, 18:00, 19:00}; exit {15:30, 19:00, 23:00, 15 minutes
  before the close}; structure {ATM straddle, 1-strike strangle, 2-strike strangle}; stop
  {none, 30%, 50% of the combined premium received}; per underlying. Only entry-before-exit
  pairs. The **17:00 → 23:00** cells are the primary test; the rest is descriptive and counted
  as trials.
- **Event days:** EIA, US CPI and payroll days and OPEC dates tagged from a calendar committed
  before the run; results reported with and without them. A strategy that only works by skipping
  events is judged on its event-day losses too.
- **Universe and look-ahead:** only contracts collected that day; strike chosen from the future's
  price at the entry minute; fills at the bar close plus slippage, with zero-volume minutes
  refused (no fill on a minute without a trade).
- **Pass / kill rule:** the primary cell's mean daily P&L after costs above zero with a 90%
  bootstrap interval above zero; PBO < 0.5 over the whole grid (the existing CSCV guard); a
  worst day no larger than an agreed multiple of the median daily premium; at least 60 collected
  days before any verdict.
- **Hold-out:** the last third of the collected days, read once.
- **Will not run:** grid cells outside the list above, re-entries, or adjustments, without
  `override: <reason>` in the Log.

#### Phase 4.1 — Run and report
- Run the grid with `obt legwise run` and `obt sweep --overfit`, then the hold-out once. Report
  per underlying, per hour bucket, and event versus quiet days.
- **Done when:** a pass/kill verdict is recorded with run ids.

### Phase 5 — Screens and Guide
- Data › Coverage lists MCX days and their quality; Options Lab runs MCX strategies with their
  session; the Guide pages for both are updated in the same commits.

## Risks

- **Short history.** Fyers alone gives months, not years, and monthly expiries make each year
  about 12 cycles. A verdict before ~60 days would be noise. A vendor source changes this; ask
  first (open question 2).
- **A missed night is permanent.** The laptop asleep at the close of an expiry day loses that
  contract. Mitigations: the morning catch-up if the master still lists it (Phase 0 measures how
  long), the Telegram alert, and the BL-012 catch-up-after-sleep logic.
- **Thin strikes give fantasy fills.** Away from the money, many minutes have no trade. Fills only
  on minutes with volume, and a slippage assumption checked against the high–low range.
- **The close moves with US daylight saving.** A fixed "23:30" exit would leave positions open on
  winter nights or exit early in summer; times relative to the close are part of the grid.
- **Event gaps.** Crude and natural gas can move several percent in a minute on an EIA print or an
  OPEC headline; a short straddle without a stop can lose many days' premium in one night.
- **Expiry mechanics.** If options devolve into futures, a position left open at expiry becomes a
  futures position with a large margin call. The engine exits before that unless a strategy says
  otherwise.
- **Engine regression.** Generalising the 375-minute grid touches every NSE result; the goldens
  must stay byte-identical, and that is Phase 3's exit check.
- **Request volume.** ~890 bars a day × strikes × underlyings is about 2.4× an NSE day per strike;
  check the run fits Fyers' throttle in the nightly window.

## Open questions

1. **Underlyings:** CRUDEOIL and NATURALGAS (and their minis) first, or include gold and silver?
   Phase 0's numbers will inform this.
2. **Longer history:** does the BL-034 vendor sell MCX options 1-minute data? Does AlgoTest
   backtest MCX? Either would replace months of waiting.
3. **Run time:** a job right after the MCX close (~23:35/00:00, the laptop must be awake), or the
   next morning if Phase 0 shows the expired contracts are still served then?
4. **Strike range:** the same premium-floor walk as NSE, or a fixed ATM ±N?
5. **Broker:** which account would trade MCX (Fyers, Angel One, Finvasia), so the cost model and
   margin match it?
6. **Order with BL-038:** both are time-critical collectors on the same laptop. Run both from
   October, or MCX first?

## Log

- 2026-10-09 — created from the owner's idea. The repo has no MCX code; the collector, engine,
  quality checks and reference data all assume the NSE 09:15–15:29 session. The cloud session
  could not reach `public.fyers.in`, so the survey (Phase 0) runs on the laptop.
- 2026-10-09 — priority raised P1 → P0 by the owner.
