# BL-218 — MCX commodity options sweep: Dir, Widesl (evening) and Buy (morning, evening) on four minis, expiry week vs the week before

| | |
|---|---|
| **Priority** | P2 — the owner asked for it; a new market for the workbench, not on the month's Momentum path |
| **Status** | In progress |
| **Type** | research |
| **Area** | options / trading-data |
| **Created** | 2026-11-11 |
| **Depends on** | BL-148 (the MCX option history in the lake) |
| **TODO.md row** | 3.11.28 |

## Context

BL-148 put two years of MCX option bars in the lake (2024-10-21 → 2026-10-30). The owner asked
(2026-11-11) whether our NSE families work on commodities: Dir and Widesl in the evening session,
a Buy (range breakout, and a timed buy) morning and evening, on the most liquid contract of crude
oil, natural gas, gold and silver, in the expiry week and the week before; crude first, then the
other three; "a sweep for the last 2 years to find out which work".

The engine was NSE-shaped (a 09:15–15:29 grid, spot from an index file, no MCX reference data).
Phase 1 made it session-aware and gave MCX days the future each option settles on as spot.

## Goal

For each root × family × week, a fit-year verdict (killed, or a finalist) and, for finalists, a
test-year verdict against the pass rules below; findings pages for every variable tested.

## Out of scope

Live trading, the AlgoTest / Quantiply export of an MCX strategy, standard (non-mini)
contracts, COPPER / ZINC, any change to the NSE rotation.

## Plan

### Phase 0 — Pre-register (committed before the full run)

- **Hypothesis:** no family has a positive edge on any of the four minis after MCX charges and
  1% slippage on every fill; the default if nothing passes is "do not trade MCX options with
  these families".
- **Universe:** CRUDEOILM, NATGASMINI, GOLDM, SILVERM (owner, 2026-11-11: the minis carried more
  volume than the standard contracts over the last 12 months). Every option expiry from
  2024-11-01 to 2026-10-31 (24–25 a root; GOLDM's 2024-10-22 and NATGASMINI's 2024-10-24 are
  out: the history starts inside their two weeks), and for each the last 10 sessions up to and
  including expiry day: **expiry week** = sessions E-4..E0, **week before** = E-9..E-5. A
  session is a day the lake holds an option file for the root; a day `data_quality` excludes is
  counted as due and not run. Every trade is the nearest expiry (the expiring contract), 1 lot,
  lot sized at today's lot (CRUDEOILM ₹10 a point, NATGASMINI ₹250, GOLDM ₹10, SILVERM ₹5).
- **Execution:** the legwise engine (stops on bar high/low, fills at the level, AlgoTest's
  price-at-T rule) on the MCX grid 09:00–23:54; underlying = the future the option expiry
  settles on (first futures expiry on or after the option's); ticks 0.05 (crude, gas) and 0.50
  (gold, silver); strike steps from the chains (crude 50, gas 5, gold 100 then 500 from the
  2026-04-28 expiry, silver 250 then 1000 from the 2026-06-19 expiry); **1% slippage** on every
  fill; MCX charges per trade (`research/common/mcx_charges.py`: ₹20 an order, CTT 0.05% sell
  side, MCX 0.0418%, SEBI ₹10/crore, stamp 0.003% buy side, GST 18%) at today's rates for the
  whole window. Morning = 09:00–17:00 (out at 16:55); evening = 17:00–close (out at 23:15 on a
  23:30-close day, 23:40 on a 23:55-close day; the close follows US daylight saving and is
  published in advance).
- **Grid:** `research/bl218/grid.py`, version `bl218-2026-11-11`, SHA `88bc794621b0ee32`
  (`tests/unit/test_bl218_grid.py` holds counts and SHA), 1,380 cells a root:

  | Family | Session | Axes | Cells |
  |---|---|---|---|
  | Dir (sell CE + PE) | evening | entry 17:05/18:00/19:00/20:00 × strike ITM1/ATM × leg SL 15/21/30% × re-entry none/cost×1 × exit 22:00/close | 96 |
  | Widesl (sell CE + PE) | evening | entry 17:05/18:00/19:00/20:00 × strike OTM1/OTM2 × leg SL 80/115/150% × trail none/15-10% × exit 22:00/close | 96 |
  | Buy range breakout (CE + PE) | morning; evening | strike ATM/OTM1 × range start 09:15/10:30/12:00 (evening 17:00/18:30/20:00) × range 10/15/30 min × source instrument/underlying (underlying: CE on a break above, PE below) × SL 25/40% × target none/100% × trail none/20-10% | 288 each |
  | Timed Buy | morning; evening | entry every 30 min 09:15–12:45 (evening 17:00–21:00) × strike ATM/OTM1 × legs CE+PE/CE/PE × SL 25/40% × target none/50/100% | 288; 324 |

- **Halves:** fit = expiries 2024-11-01 → 2025-10-31; test = expiries 2025-11-01 → 2026-10-31.
  No earlier item has read any MCX data, so both halves are unseen; only the fit half is scored
  until a finalists file is committed (`score.py --half test` refuses otherwise).
- **Scorecard** (per root × family × week, per half; `research/bl218/score.py`): net ₹ (one
  lot), ₹ a session, profit factor, entry rate, coverage, largest share of net from one expiry,
  **LB** = 5th percentile of ₹ a session over 2,000 resamples of whole expiries (seed 20261111).
  **Gates:** coverage ≥ 90%, entry ≥ 30%, net > 0, PF ≥ 1.05, no expiry > 50% of net.
  **Robust** = min(own LB, median LB of one-step neighbours) for a gated cell with at least half
  its neighbours gated. PBO by CSCV over the cohort's cells (6 blocks) is reported.
- **Kill / finalists (fit half):** a cohort with no positive robust cell is killed. Otherwise its
  best robust cell is its finalist; the owner confirms the list, which is committed as
  `research/bl218/finalists_<date>.json` before the test half is read.
- **Pass (test half, each finalist):** (1) LB > 0; (2) net > 0 in the fit half too (sign agrees);
  (3) the fit-half PBO of its cohort ≤ 0.5; (4) no expiry > 50% of the test net; (5) net > 0 at
  0.5% slippage and the sign shown at 0%. A finalist passing all five is a "works" verdict for
  that root × family × week; anything else is "does not work".
- **Look-ahead check:** strike and range decisions read only bars that end by the decision
  minute (the engine's price-at-T rule, unchanged from NSE); the settling future is a contract
  calendar fact known in advance; the evening exit uses the published close, not the day's
  bars; quality verdicts are per day and not tuned on results; `data_quality` exclusions and
  load failures are counted against coverage.
- **Survivorship:** every contract Fyers lists for an expiry is in the frozen BL-148 manifest; a
  strike with no price at entry is a no-trade (counted in the entry rate), never dropped.
- **Multiplicity:** 5,520 cells × 2 weeks × 2 sessions read on the fit half: the robust-score
  plateau, the untouched test year and PBO are the guard. ~60 fit sessions a cohort (12 expiries
  × 5) make the LB wide: the sweep can say "not this" far more often than a confident "yes".
- **Will not run:** standard contracts; COPPER, ZINC; next-month options; sessions before E-9;
  an overall MTM stop axis (leg stops only); morning Dir or Widesl; a decision at 0% or 0.5%
  slippage; any grid change after the SHA — each needs `override: <reason>` in the Log.

### Phase 1 — Data and engine (done 2026-11-11)

- **Tasks:** MCX futures for the four roots (`obt fyers mcx-futures`); lot sizes and strike
  steps in reference data; the engine's session grid, MCX spot from the settling future, per-root
  tick, per-underlying time checks; MCX charge model.
- **Done when:** the NSE goldens reproduce unchanged; an MCX fixture test and a hand-checked
  CRUDEOILM evening (fills against the raw chain and the future).

### Phase 2 — Run and score the fit half (crude first)

- **Tasks:** `run_grid.py --roots CRUDEOILM`, score, owner reads; then the other three roots.
- **Done when:** `scores_fit.md` for all four roots and `finalists_proposed.json`.

### Phase 3 — Test half and verdict

- **Tasks:** owner confirms finalists → commit; `score.py --half test --only …`; sensitivity
  runs at 0% / 0.5%; findings pages under `research/commodities/`; verdict in the Log.
- **Done when:** every cohort has a verdict and the pages are written.

## Risks

- Small samples (~60 sessions a cohort a half) — stated in the scorecard; a finalist that passes
  on one year is a lead for a forward test, not a strategy.
- MCX charges at today's rates for 2024–25 — rates were not looked up back to 2024.
- Gold and silver strike steps changed in 2026 (fewer, wider strikes): ATM/OTM1 mean different
  distances across the two halves for GOLDM and SILVERM.

## Open questions

None open: the owner's answers are in the Log.

## Log

- 2026-11-11 — created from the owner's request; answers: the minis (CRUDEOILM, NATGASMINI,
  GOLDM, SILVERM); expiry week = last 5 sessions to expiry day, week before = the 5 before;
  morning 09:00–17:00, evening 17:00–close; 1% slippage with 0% / 0.5% beside; fit = year 1,
  test = year 2, finalists committed before the test half is read.
- 2026-11-11 — Phase 1 done. Fyers' expired API serves MCX futures (probe: 4 requests); 92
  settling futures pulled for the four roots, plus SILVERM's Nov 2026 future (not expired; its
  Sep/Oct 2026 options settle on it) through the history endpoint; futures bars in the
  lake (~4.9M). Lot sizes and ticks from Angel One's public scrip master; strike steps from the chains;
  MCX charges from zerodha.com/charges. The 33 NSE golden scenarios reproduce unchanged (the
  reference-file hashes re-pinned for the MCX rows only); unit suite 2,031 passed. Hand check:
  CRUDEOILM 2025-10-14 Dir sold the 5100 CE at the 17:59 close 135.00 with the Oct future at
  5,164, stopped at 163.35 on the 22:56 bar (high 163.8).
- 2026-11-11 — smoke run before the SHA was recorded: 12 cells (2 a family) on CRUDEOILM, to test
  the runner and scorer; only row counts and two Dir rows of the fit table were looked at. Not a
  result.
- 2026-11-11 — **CRUDEOILM fit half** (grid SHA 88bc794621b0ee32, tag `main`; 240 sessions, all
  run; `results/main/scores_fit.md`): **no cohort has a positive robust cell — all 12 crude cohorts
  are killed** on the registered rule. Only 2 cells pass the gates (Dir, expiry week). Best cells
  by net (one lot, after 1% slippage and charges, 60 sessions): Dir expiry week 18:00 ITM1 SL21
  to close ₹3,108 (₹52/session, PF 1.68, LB −₹25); Dir week before 20:00 ITM1 SL15 cost×1 ₹3,493
  (LB −₹60); Widesl expiry week ₹742; every Buy cohort's best cell negative except the morning
  timed CE at 12:45 in expiry week (₹420, PF 1.07). What drives it: **before charges the sellers
  make money** — Dir averages +₹40 a session gross (91 of 96 cells gross-positive), Widesl +₹28
  (83 of 96) — but the MCX charges on one mini lot average ₹96–106 a session (four orders at
  ₹20 brokerage + GST is ~₹94 of it), so the flat per-order brokerage on a ₹10-a-point lot turns
  them negative. The Buys lose before charges too (evening breakout and timed: all 612 cells
  gross-negative). Not run yet: NATGASMINI, GOLDM, SILVERM (the plan waits for the owner's read of
  crude). A charge basis other than one lot per order (more lots per order, or the standard
  100-barrel CRUDEOIL) is outside this pre-registration and would need `override:`.
- 2026-11-11 — **Review fixes and a re-run (supersedes the CRUDEOILM entry above; grid SHA
  unchanged).** The code review on PR #447 found that the nearest expiry was taken from the day's
  chain (a contract first traded after the entry minute counted: look-ahead) and the settling
  future from the futures' last lake day (fragile). Both now come from a contract calendar
  written by `obt fyers mcx-futures` (`TRADING_DATA_ROOT/mcx/calendar-<ROOT>.json`: every
  manifest option expiry and its future, known before the contracts trade). Also fixed: the LB
  now divides by sessions run (as the mean does), the test-half lock resolves the finalists
  path, the ranking of a robust 0.0. All four roots re-run on tag `main` (CRUDEOILM's figures
  unchanged by the fixes). Deviation from Phase 2: the other three roots' fit half was run
  without waiting for the owner's read of crude; crude's sanity check was the hand-checked
  fills. Only the fit half has been read.
- 2026-11-11 — **Fit half, all four roots** (`results/main/scores_fit.md`; one lot, after 1%
  slippage and MCX charges; NATGASMINI, GOLDM, SILVERM each have one session not run — no
  settling-future bars that day — SILVERM has 20 expiries, 40 sessions a week-type):

  | Root | Dir gross / charges a session | Widesl gross / charges | Buy families | Cohorts with a positive robust cell |
  |---|---|---|---|---|
  | CRUDEOILM | +₹40 / ₹106 | +₹28 / ₹96 | all negative after charges; evening Buys lose before charges | none: **all 12 killed** |
  | NATGASMINI | +₹82 / ₹112 | +₹50 / ₹100 | all negative | Dir expiry week only |
  | GOLDM | +₹596 / ₹83 (96 of 96 cells gross-positive) | +₹463 / ₹73 | evening breakout, expiry week | Dir both weeks, Widesl both weeks, evening breakout expiry week |
  | SILVERM | +₹457 / ₹91 (96 of 96) | +₹397 / ₹78 (no robust cell) | none | Dir both weeks |

  **Proposed finalists** (the best robust cell of each surviving cohort; `finalists_proposed.json`):

  | Cohort | Cell | Net ₹ (fit) | ₹/session | PF | Entry | LB | Robust | Cohort PBO |
  |---|---|---|---|---|---|---|---|---|
  | NATGASMINI Dir expiry | 18:00 ATM SL30 no re-entry, to close | 7,630 | 129 | 1.80 | 100% | 50 | 25 | 0.30 |
  | GOLDM Dir expiry | 18:00 ITM1 SL21 cost×1, to close | 60,979 | 1,016 | 4.13 | 90% | 501 | 385 | 0.40 |
  | GOLDM Dir before | 19:00 ATM SL21 no re-entry, to close | 91,659 | 1,554 | 9.87 | 86% | 453 | 352 | 0.55 |
  | GOLDM Widesl expiry | 17:05 OTM1 SL115 trail 15/10, to close | 92,266 | 1,538 | 8.11 | 80% | 935 | 677 | 0.55 |
  | GOLDM Widesl before | 17:05 OTM1 SL115 no trail, out 22:00 | 70,339 | 1,192 | 2.65 | 81% | 330 | 203 | 0.30 |
  | GOLDM evening breakout expiry | OTM1, range 18:30 +15 min on the option, SL25 target 100 trail 20/10 | 31,657 | 528 | 6.85 | 55% | 330 | 207 | 0.00 |
  | SILVERM Dir expiry | 17:05 ITM1 SL30 cost×1, to close | 36,037 | 901 | 10.00 | 78% | 562 | 406 | 0.15 |
  | SILVERM Dir before | 17:05 ATM SL21 no re-entry, to close | 45,862 | 1,176 | 3.61 | 90% | 414 | 187 | 0.50 |

  Read with care: GOLDM and SILVERM's fit year is one long bull run (gold 75k → 127k, silver 89k
  → 160k), and profit factors of 4–10 on short premium are far above anything seen on NIFTY.
  A check that the fills are not stale prices: at 18:00 in fit-year expiry weeks the ATM CE and
  PE of all four roots last traded a median 1 minute earlier (none over 15 minutes) and trade in
  every minute to 23:00, so the entries are live prices. 1% slippage may still understate gold
  and silver mini option spreads (not measured). GOLDM Dir before and GOLDM Widesl expiry sit at
  PBO 0.55, already above the 0.5 pass line (rule 3). **Waiting on the owner**: confirm the
  finalist list (or a dated rule changing it) so it can be committed before the test half is
  read; the 0% / 0.5% sensitivity runs follow.
