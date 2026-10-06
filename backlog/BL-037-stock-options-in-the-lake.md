# BL-037 — Stock options in the lake: finish loading the vendor's 216 stocks (deferred)

| | |
|---|---|
| **Priority** | P3 — the owner trades NIFTY and SENSEX only (2026-10-07: "do it as P3"); nothing depends on it |
| **Status** | Planned |
| **Type** | feature |
| **Area** | trading-data |
| **Created** | 2026-10-07 |
| **Depends on** | [BL-034](BL-034-options-history-lake.md) Phase 1 (done: the importer, the quality table, the disk image) |
| **TODO.md row** | — (filled in when started) |

## Context

The vendor's history includes 216 stocks' option chains (1-minute OHLC + volume + OI,
2022-09 → 2026-08-25): **1.77 billion rows, 84% of everything the vendor sent**, in the staged
Parquet at `/Volumes/RAHUL'S SSD/Stock Market Data/parquet/options/stocks/`. During BL-034
Phase 1 they were queued for the lake as "raw only, no derived tables". The owner then made
clear that only NIFTY and SENSEX matter (straddle sell + adjust with IV), so the stock import
was **stopped partway on 2026-10-07 and deferred to here** (47 stocks were in by then;
the owner asked to complete the one in flight, `ZOMATO`, and stop). Nothing was thrown away: the
staging set is untouched and the importer resumes where it stopped.

### State of the lake when it was stopped (verified from the Parquet footers)

| | Units | Note |
|---|---|---|
| Fully loaded, row counts equal staging | 47 stock folders: `360ONE`…`BHARTIARTL`, `DELHIVERY`, `DIVISLAB`, `DIXON`, `DLF`, `DMART`, `DRREDDY`, `EICHERMOT`, `EXIDEIND`, `FEDERALBNK`, `FORCEMOT`, `FORTIS`, `GAIL`, `GLENMARK`, and the four renamed ones (`GMRINFRA`→`GMRAIRPORT`, `LTIM`→`LTM`, `TATAMOTORS`→`TMPV`, `ZOMATO`→`ETERNAL`) | Day files under `lake/bars_1m/asset=option/underlying=<SYMBOL>/`, each with a `data_quality` row. `ZOMATO` was finished on request after the stop |
| Not started | 169 stock folders (`BHEL` … `ZYDUSLIFE` not listed above) | |

The partial stock data is harmless (readers pick an underlying by name) and was left in place.
To drop it instead: delete the `underlying=<stock>` folders under `lake/bars_1m/asset=option/`
and the matching `data_quality` rows; the import is reproducible from staging.

### What a full load costs (measured)

- **Time:** about 4–6 hours. Stock units are small (a few million rows each), so per-unit
  overhead dominates: roughly 110,000 rows/s with two importers in parallel, against 290,000
  rows/s for NIFTY.
- **Space:** about 10–15 GB of Parquet in the disk image (plus ~110,000 more day files — a view
  over every underlying then lists ~110k files, which adds seconds to each query that does not
  name an underlying).
- **Memory:** ~0.5–1.2 GB per importer process; on the 8 GB laptop keep it to two in parallel.

### Facts that matter when this is picked up

- Four stock folders hold renamed stocks (old and new symbol in one folder). The importer
  handles them since PR #68 — each symbol is its own partition family.
- The stocks have **no spot series** in the lake (the vendor ships index spot only), so the
  `no_spot` quality rule deliberately leaves them alone, and the legwise engine cannot
  backtest them (it picks strikes from the underlying's spot). Stock 1-minute spot would have
  to come from Fyers' history API.
- `ref_lot_sizes` / `ref_strike_steps` hold no stock rows, so P&L in rupees and strike
  resolution for stocks need reference data first (the engine raises on a missing lot size).

## Goal

All 216 stocks' option history is in the lake, verified row-for-row against staging, **only if
the owner decides stock options are worth backtesting** — at that point also stock spot and the
reference data above.

## Out of scope

- Derived tables, IV and greeks for stocks (BL-034 Phase 3 is NIFTY and SENSEX only).
- Daily collection of stock options (decided against, 2026-10-06).

## Plan

### Phase 1 — Decide
- **Tasks:** the owner says whether stocks are wanted, and which (all 216, or a watchlist —
  `tdata vendor import --unit` takes a list, so a watchlist is cheap), and whether to keep or
  remove the 47 already loaded.
- **Done when:** the decision is recorded in this item.

### Phase 2 — Finish the import
- **Tasks:** resume with `tdata vendor import --from "<staging>/parquet/options" --section stocks`
  (resumable; finished chunks and existing day files are skipped), two processes at most;
  then check every unit against the staging set from the Parquet footers (the check used in
  BL-034 is a scratch script — promote it to `tdata vendor verify` first); `tdata quality
  rebuild --asset option` to judge the days an interrupted run left unrecorded.
- **Done when:** every in-scope stock unit's lake rows equal its staged rows, and
  `tdata quality status` shows a verdict for each of its days.

### Phase 3 — Make them backtestable (only if wanted)
- **Tasks:** stock 1-minute spot via Fyers history; dated lot sizes and strike steps for the
  stocks; then the BL-034 derived tables for the chosen stocks.
- **Done when:** the legwise engine runs a strategy on a stock day.

## Risks

- The partial load makes the lake look "mostly stocks loaded" to anyone listing underlyings;
  record the decision from Phase 1 promptly.
- A full load roughly doubles the number of files in the lake; query planning that globs all
  underlyings slows accordingly (name the underlying, or use per-underlying paths).

## Open questions

- All stocks, a watchlist, or none?
- The forward collection of stock options (BL-038) will fill the lake with new stock data from
  October 2026 on; does the vendor history for stocks still matter next to that?

## Log

- 2026-10-07 — created. The stock import started as part of BL-034 Phase 1 was stopped at the
  owner's request ("only Nifty and Sensex"; "do it as P3"); this item records exactly where it
  stopped and what resuming costs.
