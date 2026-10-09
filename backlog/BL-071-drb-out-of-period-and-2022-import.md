# BL-071 — Does DRB's rule hold outside the studied year? Jan–Aug 2025 now; 2022–2024 needs an import

| | |
|---|---|
| **Priority** | P2 — options research; follows BL-067 / 068 / 069 |
| **Status** | Part A done: recent edge not confirmed out of period; part B (import) started 2026-10-10 on the owner's go-ahead |
| **Type** | research |
| **Area** | options / trading-data |
| **Created** | 2026-10-10 |
| **Depends on** | BL-065 (DRB-6W3L2), BL-068 (controls), BL-034 (lake; Phase 5 = `2014-2024`) |
| **TODO.md row** | — |

## Context

Every DRB result so far comes from one year, 2025-09-01 → 2026-10-08, which the owner chose ("last one
year only") and which has been examined many times. Two ways to test the rule outside it.

## Plan

### Part A — Jan–Aug 2025, from results that already exist (no engine runs)
- **Why possible:** every one of the 248 variants has per-day results from 2024-10-09 (BL-054/056/059–062
  ran 2024-10-09 → 2026-10-08); the rotation only ever read them from 2025-09-01. `rotate.py
  --window-from 2024-10-09` scores from the start; with a 63-day warm-up the selection days run
  2025-01-10 → 2026-10-08, and the days before 2025-09-01 (about 160) are the out-of-period slice. Scores
  use only earlier rows, so slicing the picks file is exact (no look-ahead).
- **What "unseen" means here:** the rule, its weights and every ingredient were chosen and examined on
  the 2025-09 → 2026-10 year. The 33 morning variants' two-year totals (BL-054/056) were looked at before;
  the rotation was not. So this tests the rotation rule, not the variants.
- **Rows:** baseline 33/25/25/17, recent-only 100/0/0/0, no-recent 0/33/33/34, no-VIX 40/30/30/0, on the
  slice 2025-01-10 → 2025-08-29.
- **Read-out (registered before the run):**
  1. baseline gross on the slice ≥ the 90th percentile of 1,000 random picks of the same shape (3 core
     strategies × 2 lots, at least 2 Widesl, Buy on the days the rule bought) on the same days;
  2. baseline − no-recent is positive and the 90% block-bootstrap interval (5-day blocks, 2,000
     resamples) excludes zero;
  3. the per-day gap baseline − no-recent is at least half its in-sample value (₹204,763 over 202 days =
     ₹1,014 a day → ₹507 a day).
  The recent edge is *confirmed out of period* if all three hold, *not confirmed* if (2) fails. No-VIX
  and recent-only are reported, not judged.
- **Hold-out:** this slice is the hold-out; nothing is changed after it is read.
- **Will not run:** other slices, other rows, re-tuning on the slice.
- **Result (2026-10-10): NOT confirmed — the recent edge did not hold out of period; it reversed.** Slice
  2025-01-10 → 2025-08-29, 157 selection days, gross before charges, DRB-6W3L2, 248 variants:

  | Row | Gross | Max DD | Win % | Per day |
  |---|---|---|---|---|
  | baseline 33/25/25/17 | ₹1,70,015 | −₹88,366 | 52.9 | ₹1,083 |
  | recent-only 100/0/0/0 | ₹1,98,550 | −₹69,912 | 57.3 | ₹1,265 |
  | no-recent 0/33/33/34 | **₹2,96,897** | −₹59,930 | 56.1 | ₹1,891 |
  | no-VIX 40/30/30/0 | ₹2,18,753 | −₹87,720 | 52.9 | ₹1,393 |

  Random picks of the same shape on the same days (n = 1,000): P50 ₹1,98,170, P90 ₹2,94,240, max
  ₹4,26,365. (1) baseline ≥ P90: **false** (it beats 34% of random picks; below the median). (2)
  baseline − no-recent: **−₹1,26,882**, 90% block-bootstrap interval [−₹2,59,561, −₹68], so the sign is
  the opposite of the in-sample year's +₹2,04,763. (3) per-day gap −₹808 against ≥ +₹507: false. All three
  conditions fail. Report-only: baseline − recent-only −₹28,535; baseline − no-VIX −₹48,739.
  Reading: in Jan–Aug 2025 the weekday / days-to-expiry / VIX-band fit criteria alone (no-recent) did
  best, at the random P90, and adding recent return made it worse; in 2025-09 → 2026-10 it was the other
  way round (BL-067/068). The ranking of the criteria is not stable across the two periods, so BL-067/068's
  "recent return carries the edge" is a finding about that one year, not yet about the rule. Not a
  statement that no-recent is good: one 157-day slice, one comparison. The whole two-year run of the
  baseline (422 selection days) makes ₹7,20,873 gross, drawdown −₹88,366, of which ₹4,30,868 is the
  2025-12 → 2026-10 year.

### Part A, extra block (2026-10-10, exploratory: the slice was already read)
- **Why:** BL-069 produced four candidates in-sample and the slice result says the recent criterion did
  not hold there. The owner wants to know which rows, if any, hold up on Jan–Aug 2025. The slice was
  read by part A, so this block cannot confirm anything; it is a second, clearly labelled look.
- **Rows (fixed here, no others):** recent-only + family-pooled recent F = 0.5 (BL-069's keep);
  baseline with fit lookbacks 21:50,63:50; baseline with 63:50,126:50 (the two placebo-real B3 rows);
  baseline with the streak gate 5 (tests the "after a losing stretch the basket does better" finding).
  All `--window-from 2024-10-09`, sliced at 2025-09-01, same random comparator as part A.
- **Read-out:** report gross, max drawdown, win % and per day beside part A's four rows, and whether
  each is ≥ the slice's random P90 (₹2,94,240). No keep / drop is declared from this block.
- **Will not run:** any other row on this slice.
- **Result:** pending.

### Part B — 2022–2024 NIFTY from the SSD's `2014-2024` folder (needs the owner's go-ahead)
- **What is there** (read-only inspection, 2026-10-10, `/Volumes/RAHUL'S SSD/Stock Market Data/2014-2024`):
  `nifty/` 46,864 contract CSVs (12 GB; 52 / 53 / 44 expiry folders in 2022 / 2023 / 2024), `banknifty/`
  51,185 CSVs (13 GB), `spot_data/` (NIFTY 2015 →, BANKNIFTY 2015 →, SENSEX 2018 → 1-minute spot).
  One CSV per strike × CE/PE × expiry (`NIFTY_17350_PE_30_NOV_23.csv`, columns `date,time,open,high,low,
  close,volume,oi`, `dd-mm-yyyy`), holding only that contract's **expiry week**. For the 2023-03-16 expiry:
  151 contracts, 137 with rows on 2023-03-15, the day the lake calls `thin_chain: 6 contracts`.
- **Why the lake looked thin (correction):** the lake's NIFTY options start at the expiry 2024-10-03; a
  2022–2023 day therefore holds only the few long-dated contracts that traded that early. The week's own
  contracts are in `2014-2024`, which BL-034 reserved as Phase 5 and never imported. The 2022–2023 data
  is not sparse; it is not loaded.
- **Cross-check against the already-imported set (2024-10-31 expiry, 226 contracts, 256,304 minutes in
  both):** OHLC identical on 74% of minutes (close 74%, open 71.5%, high / low 77.5%); open interest
  equal on 98%; median close difference 0.0%, 95th-percentile high difference 0.75%. The `2014-2024`
  CSV holds **traded minutes only** (all 256,570 rows have volume > 0); the Parquet set fills untraded
  minutes with carried-forward bars (379,863 minutes in the same span, 256,255 traded). So the two sources
  are the same vendor but not the same construction: importing creates a seam at 2024-10-03.
- **Proposed route (not started):** convert the `2014-2024/nifty` expiry folders for 2022-01 → 2024-09 to
  the staging Parquet layout `tdata vendor import` already reads (columns underlying, contract, strike,
  option_type, expiry, ts, open, high, low, close, volume, oi), together with the existing
  expiries as one staging set so a rewritten day keeps its far-dated contracts; import with
  `--days 2022-03-25..2024-10-02 --force` (a Fyers-collector day is never overwritten; there are none
  before 2026-09). Fill untraded minutes the way the Parquet set does, decided against a day-by-day
  comparison on the Oct 2024 overlap. Then `tdata quality rebuild`, `tdata reference derive-expiries`,
  `tdata derived rebuild --underlying NIFTY --days …`, and run the 124 NIFTY variants over the days
  (about 700 sessions; ~10–12 h at the current pace). Lot sizing stays "current" (the default).
- **Risks:** a source seam at 2024-10 (prices differ on ~22% of minutes, by 0.75% at the 95th
  percentile on highs); expiry-week-only chains (no next-expiry contracts on a given day); the single
  DuckDB writer, so the import must not overlap `obt daily`; the lake lives on a disk image on the same
  SSD as the source, so it competes with every engine run. Nothing is written to the lake until the
  owner agrees and a scratch import reproduces the Oct 2024 overlap.
- **Decision for the owner:** widen the lake to 2022–2024 (BL-034 Phase 5), yes / no.

### Part B — registered read-out (2026-10-10, before any 2022–2024 variant run)
- **Universe:** NIFTY only (SENSEX options before 2023-07 are not in the lake, and none before 2024-10
  are imported): the 124 NIFTY variants of the 248-list (OTM1 Widesl, Dir ATM, Buy, closest-premium
  ₹80 / ₹100 at the 25 start times 09:17–15:17; Buy has no 15:17). Per-day results from the same
  variant files as the main runs, run over the imported days 2022-01-03 → 2024-10-08 with
  `research/bl071/run_variant.py` (research-only reference override, `lot_sizing: current`, costs 0).
  The existing results for 2024-10-09 onward are used only as warm-up context where a row needs it; the
  test period is **2022-01 → 2024-10-08** minus the 63 warm-up days and the days `data_quality` excludes.
- **Rule:** DRB-6W3L2 as BL-065 (3 strategies × 2 lots, at least 2 Widesl, Buy add-on when a Buy ranks in
  the top 10), NIFTY-only. Days-to-expiry from the nearest listed expiry with bars on that day; VIX band
  from the 09:15 INDIAVIX open; weekday from the calendar. Nothing is tuned on this period.
- **Rows (fixed):** baseline 33/25/25/17; recent-only 100/0/0/0; no-recent 0/33/33/34; no-VIX
  40/30/30/0; baseline with fit lookbacks 21:50,63:50; baseline with 63:50,126:50; recent-only + family
  0.5; the four BL-072 blends (25/25/15/15/20/0 and 25/25/15/15/10/10 on the two lookback sets).
- **Read-out:** (1) *the recent edge holds* if baseline − no-recent is positive with a 90% block-
  bootstrap interval (5-day blocks, 2,000 resamples) above zero and at least half the main year's
  ₹1,014 a day. (2) *the longer fit lookbacks hold* if each B3 row beats the baseline with a bootstrap
  interval above zero. (3) *the rule beats chance* if baseline ≥ P90 of 1,000 random picks of the same
  shape on the same days. (4) Report per calendar year (2022 / 2023 / 2024), since regimes differ.
  Risk caveats written down now: the data are expiry-week-only chains with traded minutes only, a
  different construction from the 2025+ vendor set (prices differ on ~22% of overlapping minutes, 0.75%
  at the 95th percentile on highs); NIFTY's expiry day moved from Thursday to Tuesday in the period.
- **Hold-out:** this is the hold-out. Nothing is changed after reading it; a row that fails here is
  not adopted whatever it did in-sample.
- **Result:** pending (engine runs started 2026-10-10).

## Log

- 2026-10-10 — created; part A registered before its runs, part B inspected read-only and written up.
- 2026-10-10 — part A ran: not confirmed (all three conditions fail; baseline − no-recent −₹1,26,882). Owner said "import it now in parallel": part B starts, staged (importer into scratch, checked against the Oct 2024 overlap, before anything is written to the lake).
- 2026-10-10 — part B, owner said "import it now in parallel". Converter `packages/trading-data/scripts/
  drive_csv_to_parquet.py` wrote 144 expiry Parquet files for 2022-01 → 2024-10-02 (25,246,971 rows, 25,422
  contract files, none empty / duplicate / skipped) into a staging set with links to the 103 existing vendor
  expiries. One-week trial (2023-03-13..17, `--force`): 5 days written, 182,534 rows, all `usable`, 129–149
  contracts a day (was 2–6), far-dated contracts kept. Full import (`--days 2022-01-01..2024-10-02 --force`)
  started. **Run from a throwaway checkout at 4881945**, not from this branch: after `main` was merged in,
  any read-write catalog connect fails with `CatalogException: Table "momentum_holdings" already exists`,
  because the live catalog recorded `011_momentum_orders` while `main` ships the same DDL as
  `012_momentum_orders.sql` (renumbered). Nothing was written by the failed attempt. Needs the BL-051 owner
  to reconcile the ledger before anything from `main`'s `trading_data` runs against this catalog (including
  `obt daily`).
