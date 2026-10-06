# BL-009 — Intraday options backtesting platform (verified, multi-strategy, event-triggered)

| | |
|---|---|
| **Priority** | P1 — the measurement layer for every options idea; nothing trades live until it is trusted |
| **Status** | Planned |
| **Type** | feature |
| **Area** | options (+ trading-data, dashboard) |
| **Created** | 2026-10-04 |
| **Depends on** | TODO 3.10.7 (AlgoTest sanity check — becomes Phase 1 here), TODO 3.10.15 (NIFTY pre-Sep-2025 expiry weekday); owner: vendor data purchase, Quantiply documents |
| **TODO.md row** | — (filled in when started) |

## Context

The owner wants a proper intraday options backtesting platform where **correctness of the
result comes first**, then breadth:

1. Everything Quantiply offers (documents to be shared by the owner), on top of the AlgoTest
   settings already built.
2. Entries that are not only time-based: a non-directional strategy when straddle momentum
   peaks, a directional strategy when the index reaches support/resistance.
3. Several strategies run together (09:17, 09:20, 10:00 …) with **combined** max drawdown and
   risk — the gap in every existing platform.
4. Parameter sweeps, as done for momentum.
5. Option sellers first, option buyers second.
6. Years of history from a paid data vendor (sample in `~/Downloads/sample data`).

### What already exists (2026-10-04)

- `packages/option-backtesting/legwise/` — AlgoTest-style minute engine: strike type / closest
  premium, SL / target (points or %), trail SL, RE COST / RE ASAP, range breakout, overall
  SL/target, partial/complete square-off. 30 frozen golden scenarios (TODO 3.10.17).
  **Its intrabar rules are best guesses from AlgoTest's docs, never checked against AlgoTest.**
- Fyers 1-minute data in `~/TradingData`: 6 sessions only (23, 24, 25, 28, 29 Sep and 1 Oct 2026;
  **30 Sep is missing**), 1.75M option bars, 15k contracts, index + futures.
- `engine/` (DSL engine, 5m/15m AlgoTest bars, Jun–Sep 2026) with walk-forward, sweep, CSCV/PBO +
  deflated Sharpe, margin model — the analytics are reusable, the engine is not (one summed
  premium series, one side).
- `apps/server` has the straddle momentum-peak detector (TypeScript, live only).

### Vendor sample — what was found

`options/index/nifty/` — 8 expiries, 454 files, one CSV per contract
(`NIFTY_<strike>_<CE|PE>_<DD>_<MON>_<YY>.csv` under a folder named by expiry). Usable, but not clean:

| Finding | Detail | Consequence |
|---|---|---|
| Three different file layouts | 2014–2017: `date,time,o,h,l,c,volume`; 2020: same with `DD-MM-YYYY` dates, `oi` in 57 of 97 files; 2024: `timestamp` (ISO +05:30)`,o,h,l,c,volume,oi` | Importer must detect layout per file, never assume |
| Sparse vs filled bars | 2014–2020 have a row only for minutes that traded (median 276–352 of 375 on expiry day, as few as 7); 2024 is forward-filled with `volume=0` rows | A 09:17 entry may have no bar. Need an explicit stale-price rule, and every fill must record whether its minute actually traded |
| Duplicate rows | e.g. `06-01-2020 13:08` twice in one file | Dedupe gate |
| Missing expiry day | 2014-10-30 folder ends 2014-10-29 | Coverage gate per contract per day; a day with holes is excluded, not guessed |
| Bars outside the session | up to 16:01 in 2017 | Clip to 09:15–15:29, log what was dropped |
| Thin strike range early | 2014: ~11 strikes, 100-pt steps | Closest-premium and far-OTM legs may be unresolvable in early years — report it, do not substitute |
| No OI before ~2020 | | OI-based features only from 2020 |
| VIX file | 1-minute, 2015-04 → 2023-04, **2019 absent**, 2018/2020 partial, volume always 0 | Ask whether the full product has the gap; Fyers `obt fyers history` can fill VIX |
| **No NIFTY spot or futures in the sample** | only stock equity files | **Blocker to check before buying** — ATM/OTMn selection needs the index 1-minute series |
| No overlap with our data | sample ends Oct 2024, Fyers data starts 23 Sep 2026 | Cannot cross-check vendor vs Fyers until the vendor supplies an overlapping week |
| Bar timestamp convention unknown | start-of-minute or end-of-minute? | One minute of shift changes every fill. Settle from the overlap week |

### Direction on "convert current data to the vendor format"

Recommended the other way round: `trading-data`'s lake (`bars_1m_option` etc.) stays the one
canonical format and the vendor files are **imported into it** with `vendor` recorded per bar.
The engine then reads one format whatever the source, and Fyers-vs-vendor differences become a
query. A vendor-layout exporter is cheap to add if the owner still wants the files.

## Goal

- The leg-wise engine reproduces AlgoTest's trade log for the owner's strategies over the
  collected week — every entry/exit time, strike and price — or each difference is explained
  and recorded.
- The same strategies run over multi-year vendor history with data-quality gates, and give the
  same result on Fyers and vendor data for overlapping days.
- A portfolio of strategies reports combined minute-level MTM, combined max drawdown and peak margin.
- Entries can be triggered by market events (momentum peak, S/R touch), not only the clock.
- Sweeps come with walk-forward and overfitting checks.

## Out of scope

- Live or paper order placement (stays with the AlgoTest execution loop).
- Tick-level or order-book simulation — 1-minute bars only; slippage is modelled, not observed.
- Stock options and indices other than NIFTY (owner, 2026-10-05: NIFTY only first).
- Positional / overnight trades — intraday only at first, positional later.
- Replacing `engine/` (the DSL engine) — it stays as is.

## Plan

### Phase 1 — Prove the engine against AlgoTest (last week)
- **Tasks:** owner runs the four `strategies/legwise/*.yaml` on AlgoTest for 23 Sep–1 Oct 2026 and
  exports the trade logs; build `obt legwise compare <algotest-export>` that diffs trade by trade
  (strike, entry/exit minute, price, reason, P&L); resolve each difference to a rule in
  `legwise/engine.py`'s docstring (entry at open vs close, SL fill price, trail order, RE COST
  timing, overall-SL evaluation point) or to a data difference; recollect 30 Sep if still available.
- **Deliverables:** comparison tool, a difference log in `DECISIONS.md`, golden snapshots re-accepted
  after any rule change, AlgoTest logs committed as fixtures.
- **Done when:** all four strategies match AlgoTest on every day to within a stated tolerance
  (target: same strikes and minutes; price within one tick), or every remaining gap has a written cause.

### Phase 2 — Vendor data layer
**Superseded by [BL-034](BL-034-options-history-lake.md) (2026-10-06):** the vendor's full
history was obtained and is being loaded into the `trading-data` lake there (two-year scope
first, NIFTY + SENSEX derived tables). The tasks below stay as the original checklist; the
"before buying" items no longer apply.
- **Tasks:** before buying — get from the vendor: NIFTY/BANKNIFTY/SENSEX spot + futures 1m, an
  overlap week (23 Sep–1 Oct 2026), the VIX gap answer, coverage list, update frequency;
  `tdata`/`obt vendor import` (layout detection, dedupe, session clip, timezone, `traded` flag
  per minute); quality gates (coverage per contract-day, duplicate, off-session, price sanity vs
  intrinsic value, strike-ladder completeness around ATM); historical reference data — expiry
  calendar (TODO 3.10.15), lot sizes, strike steps, holidays before 2024, special sessions;
  stale-price rule for sparse minutes.
- **Deliverables:** importer, quality report per expiry, extended reference tables, a per-day
  "usable / excluded and why" table.
- **Done when:** the Phase 1 strategies give the same trades on vendor data as on Fyers data for
  the overlap week, and the sample's 8 expiries import with every anomaly above reported.

### Phase 3 — Quantiply feature parity, Stockmock conventions
Source: <https://quantiply.tech/documentation/> (read 2026-10-05). Owner: everything there must be
backtestable "like Stockmock". Quantiply's own docs say which settings make live trading match a
Stockmock backtest — those are our backtest conventions: **trailing checked every 1 minute,
re-entry / re-execute / journey on candle close, premium matching on candle close**.

| Quantiply feature | Today | To build |
|---|---|---|
| Leg SL / target in points or % of premium | Yes | — |
| Leg SL / target on the **underlying** (UL pts / UL %), measured from spot at fill; trailing follows spot too | No | Yes |
| Leg SL / target as **ORB range ± points/%** | No | Yes |
| Leg trailing SL | Yes | confirm 1-minute cadence |
| Square off one leg / all legs | Yes (`square_off`) | — |
| MTM SL / target (₹) | Yes | — |
| MTM trailing SL, lock profit, trail profit, lock + trail | No | Yes |
| Strike: ATM / ITMn / OTMn | Yes | — |
| Strike: ATM ± % (nearest strike to ATM × (1 ± %)) | No | Yes |
| Entry by premium: close to | Yes | — |
| Entry by premium: higher than / lower than; "multiples only" filter (100 for NIFTY) | No | Yes |
| Straddle width, straddle premium, % of underlying, specific strike | No | Yes — their doc pages did not load; rules to be confirmed (owner screenshot or Stockmock's definition) |
| Premium matching across marked legs: max difference %, close to, range, combined premium (lower / higher / either / between) | No | Yes |
| Wait & Trade: points/% up/down from the leg's price at start; underlying variant; "trade only first entry" | No | Yes |
| Range breakout: high/low, instrument/underlying | Yes | separate range start time; "trade only first entry" |
| Move SL to cost (opposite-side legs move to their average entry when a leg's SL hits) | No | Yes |
| RE-ENTRY (same contract, minute close back through the **previous** entry price, enter next minute; with trailing, only after the original SL level was touched) | No | Yes |
| RE-COST (same contract, immediately when price returns to the **first** entry price) | Yes (`mode: cost`) | confirm first- vs previous-entry price |
| RE-EXECUTE (re-run the leg's strike selection) | Yes (`mode: asap`) | rename; candle-close method |
| Re-entry on target as well as SL, separate counts | Yes | — |
| Re-entry timing: only after / only before / between | Partly (`no_reentry_after`) | after + between |
| MTM re-entry (square off all, re-run the strategy) and MTM **reverse** re-entry (flip buy/sell each time); does not use up leg counts | No | Yes |
| Journey: child legs fired when a parent leg hits SL or target — up to 10 children per leg, 5 levels; not with re-entry | No | Yes |
| Signals (external entry/exit, max entries per day) | No | Covered by Phase 5 triggers |
| Next-week / monthly contracts, multiplier | Yes (`expiry`, `lots`) | — |
| Positional / STBT / BTST | No | Later — intraday only for now (owner, 2026-10-05) |
| Order delays, SL-limit orders, limit-price protection, retries | n/a | Live-execution only; at most an optional delay/slippage model |

- **Tasks:** build the "To build" rows in the order sellers need them (MTM trail/lock, move SL to
  cost, RE-ENTRY, MTM re-entry, wait & trade, premium matching, journey, then the strike modes and
  underlying-based exits); each lands with a golden scenario; keep `extra="forbid"` so anything
  unbuilt is rejected, not ignored. The doc pages were read through a summariser — re-read the
  exact page before implementing each rule.
- **Deliverables:** this matrix kept current in the package README, schema + engine additions, goldens.
- **Done when:** every row is "Yes" or explicitly rejected by the schema with a reason, and at
  least one Quantiply sample strategy per feature (their "Sample Strategies" pages) runs.

### Phase 4 — Multi-strategy portfolio
- **Tasks:** portfolio spec (list of strategies with lots/weights and their own entry times);
  combine per-minute MTM curves (already produced as `DayResult.mtm`) into one curve; combined
  intraday and day-level max drawdown, peak concurrent margin, worst day, per-strategy
  contribution and correlation; portfolio-level stop/target/lock that closes all strategies.
- **Deliverables:** `obt portfolio run`, stored results, report.
- **Done when:** a portfolio's P&L equals the sum of its members when no portfolio rule fires,
  and a hand-worked two-strategy day matches to the rupee.

### Phase 5 — Event-triggered entries
- **Tasks:** an entry-condition layer evaluated each minute on point-in-time features only —
  ATM straddle rate-of-change and peak (port of `apps/server`'s detector, same numbers on the
  same bars), support/resistance levels (previous-day high/low/close, opening range, pivots/CPR,
  round numbers, swing points), VIX level/change, time windows; a trigger opens a named strategy
  template (momentum peak → short straddle/strangle; S/R touch → directional spread or buy);
  max triggers per day, cooldown, re-arm rules.
- **Deliverables:** trigger schema, feature modules, lookahead test (features at minute T use
  bars ≤ T-1 close).
- **Done when:** trigger times are reproducible bar by bar and the lookahead test passes for every feature.

### Phase 6 — Sweeps and robustness
- **Tasks:** parameter grid over leg-wise and portfolio specs (entry time, SL %, trail, strike
  distance, trigger thresholds); reuse `analytics/walkforward.py` and `analytics/overfit.py`
  (PBO, deflated Sharpe); results by day type (`legwise/anatomy.py`), DTE and VIX bucket; cost
  realism — brokerage, STT, exchange charges, slippage scaled by premium and volume; seller view
  (return on peak margin, tail loss, worst gap) and buyer view (hit rate, payoff ratio, theta paid).
- **Deliverables:** `obt legwise sweep`, robustness report.
- **Done when:** a sweep over one year runs in acceptable time and reports in-sample vs
  out-of-sample with PBO.

### Phase 7 — Dashboard
- **Tasks:** Options Lab additions — portfolio builder and combined curve, trigger timeline on
  the day view, sweep heatmaps, data-quality page.
- **Done when:** every CLI result above is viewable without the terminal.

## Risks

- **AlgoTest's own results are not ground truth** — its data and rules can differ. Where we
  disagree with a documented cause, we keep our rule and record it.
- **Vendor data quality** — sparse early years and missing days can bias results; excluded days
  must be visible in every report, never silently dropped.
- **No spot series from the vendor** would make the purchase unusable for ATM-based strategies.
- **Overfitting** grows with triggers × sweeps; Phase 6 guards are not optional.
- **1-minute bars hide intrabar order**; conservative rules (SL before target) stay the default.
- **Six days of Fyers data** is too little to conclude anything — Phase 1 proves mechanics only.

## Open questions

1. Vendor: name and price — owner will tell later.
2. AlgoTest trade logs for the four strategies, 23 Sep–1 Oct 2026 — owner will give later.
3. Confirm the four strike modes whose Quantiply pages did not load. Working definitions (the
   usual Stockmock/AlgoTest ones, to be checked on Stockmock before building):
   straddle width = ATM ± multiplier × ATM straddle price, rounded to a strike;
   straddle premium = strike whose premium is closest to X% of the ATM straddle price;
   specific strike = a fixed strike number; % of underlying = not yet understood.

### Answered

- **Scope (2026-10-05):** NIFTY only; intraday only at first, positional later.
- **Quantiply docs (2026-10-05):** the public documentation site; everything in it must be
  backtestable like Stockmock — see the Phase 3 matrix.
- **Stockmock (2026-10-05):** owner has an account — it is the reference for Phase 3 features.
- **Vendor coverage (2026-10-05):** owner says the full product has everything needed (spot,
  futures, complete VIX); still verify on delivery with the Phase 2 quality gates.
- **History depth (2026-10-05):** back to 2019 (start of weekly NIFTY options).
- **30 Sep 2026 missing (2026-10-05):** proceed with the days that exist.

## Log

- 2026-10-04 — created. Sample data profiled; four leg-wise strategies run over the 6 collected
  days to give the owner numbers to compare with AlgoTest.
- 2026-10-05 — owner answered scope (NIFTY, intraday), pointed to Quantiply's docs, AlgoTest logs
  to follow. Quantiply docs read; Phase 3 rewritten as a feature matrix with Stockmock conventions.
  Phase 1 waits on the AlgoTest logs; Phase 3 and the Phase 2 importer (on the sample) do not.
- 2026-10-05 — owner: has Stockmock; vendor data will be complete, details later; test back to 2019.
- 2026-10-06 — vendor data now on the owner's SSD (`/Volumes/RAHUL'S SSD/Stock Market Data`):
  `2014-2024/` (37 GB) and `options/` (32 GB), about 221k CSV files. `2014-2024/spot_data/` has
  1-minute NIFTY, BANKNIFTY and SENSEX spot (`Date,Open,High,Low,Close,Volume`, ISO timestamps
  with +0530; NIFTY from 2015-01-09, 1.06M rows) — this clears the "no NIFTY spot" blocker above.
  India VIX not found in that folder yet. Accuracy, as three checks: (1) data — vendor spot against
  Fyers index history (`obt fyers history`; index history never expires, so the two overlap, which
  also settles the bar-timestamp convention); (2) engine — the four strategies against AlgoTest's
  trade logs (still owed); (3) regression — the 30 golden scenarios plus new ones from (2).
  Realised-vs-backtest for the strategies that trade live is split out as BL-026.
