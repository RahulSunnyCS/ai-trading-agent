# BL-107 — Daily NSE F&O bhavcopy: official end-of-day record, and a cross-check on the Fyers data

| | |
|---|---|
| **Priority** | P0 — set by the owner 2026-10-14: an independent check on data every options result rests on, and the only official record of contracts we do not collect (stock options, far expiries) that cannot be re-downloaded later |
| **Status** | Planned |
| **Type** | feature |
| **Area** | options / trading-data (+ scheduler) |
| **Created** | 2026-10-14 |
| **Depends on** | [BL-034](BL-034-options-history-lake.md) Phase 1 (lake, `data_quality`); [BL-012](BL-012-scheduler-service.md) for the schedule |
| **TODO.md row** | — (filled in when started) |

## Context

The lake's 1-minute option data comes from one vendor feed per day (Fyers, or Angel One as the
fallback, BL-079), and expiring contracts cannot be re-downloaded. Nothing independent checks it.
NSE publishes an official end-of-day F&O file ("UDiFF bhavcopy") for every trading day with
open, high, low, close, settlement price, open interest, change in OI, volume and traded value
for every contract, stock options and stock futures included.

Checked by hand on 2026-10-14 for 2026-10-13:

- URL: `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_YYYYMMDD_F_0000.csv.zip`.
  The answer for a date not yet published is a 404 HTML page, not an error code in the body.
  Fetched with a browser `User-Agent` and a `Referer` of `nseindia.com`; no login or cookie.
- 1.17 MB zipped, 6.8 MB as CSV, 37,400 rows: 30,954 stock options, 5,793 index options
  (1,900 NIFTY), 635 stock futures, 18 index futures. Published about 18:30 IST.
- Columns include `TckrSymb`, `FinInstrmTp` (IDO/STO/IDF/STF), `XpryDt`, `StrkPric`, `OptnTp`,
  `OpnPric`..`ClsPric`, `SttlmPric`, `UndrlygPric`, `OpnIntrst`, `ChngInOpnIntrst`, `TtlTradgVol`.

## Goal

Every trading day, by about 19:15 IST, the lake holds that day's official F&O file as a table,
and `data_quality` carries a comparison of the day's Fyers 1-minute data against it (close,
volume, OI per contract), with a Telegram line when they disagree beyond a threshold.

## Out of scope

- Using bhavcopy prices in backtests (it is end-of-day only).
- Stock-option 1-minute collection ([BL-038](BL-038-monthly-expiry-stock-options-collection.md)).
- Cash-market bhavcopy and other NSE reports.

## Plan

### Phase 1 — Fetch and store
- **Tasks:** `obt bhavcopy fetch [--date D]`: download, keep the raw zip under
  `TRADING_DATA_ROOT/raw/nse/bhavcopy/`, parse to Parquet `lake/eod/fo_bhavcopy/date=D/`, one
  `ingest_runs` row. Idempotent; 404 on a trading day means "not yet published", not a failure;
  non-trading days (reference holidays) are skipped.
- **Deliverables:** the command, a schema, unit tests on a frozen sample file.
- **Done when:** 2026-10-13 and 2026-10-14 are in the lake and a re-run changes nothing.

### Phase 2 — Cross-check in `data_quality`
- **Tasks:** per day, join the lake's index-option and futures bars to the bhavcopy on
  (underlying, expiry, strike, type): last-bar close vs bhavcopy close, summed volume vs
  `TtlTradgVol`, last OI vs `OpnIntrst`; also contracts present in one and not the other. Write
  the result as new reason codes on the day's verdict; set thresholds from the first 30 days
  of agreement, not from a guess.
- **Deliverables:** the check, a `tdata quality` summary line, tests.
- **Done when:** a deliberately corrupted copy of a day's file is flagged and a clean day is not.

### Phase 3 — Schedule and alert
- **Tasks:** a scheduler job at about 19:15 IST that runs Phase 1 then Phase 2, retries until
  21:00 if the file is not up, alert-only on a mismatch or a missing file.
- **Deliverables:** registry entry, run history, a Telegram type that can be switched off.
- **Done when:** three consecutive trading days run with no manual step.

### Phase 4 — History (optional)
- **Tasks:** backfill the UDiFF format back to when it started, and decide whether the older
  format (different URL and columns) is worth parsing. Bounded by the owner's answer below.

## Risks

- NSE changes the URL or blocks unattended downloads: the job fails loudly and the day is
  retried; the raw archive keeps what was fetched.
- Terms of use: this is a public report for personal research use; confirm before sharing it.
- A mismatch may be the bhavcopy's convention (last-traded price vs close, settlement) and not
  a data error; Phase 2 starts with report-only before anything can exclude a day.

## Open questions

- On a mismatch: report only, or let it exclude the day from backtests?
- Backfill depth (Phase 4): none, UDiFF era only, or everything NSE offers?
- Keep all stock-option rows, or only the underlyings the lake collects? (About 1.5 MB a day
  as Parquet, so everything is the default.)

## Log

- 2026-10-14 — created (owner: "yes lets do" to the bhavcopy idea); file format and size
  checked by hand on the 2026-10-13 file.
- 2026-10-14 — re-prioritised P2 → P0 by the owner. Each day not fetched is a day that can be
  backfilled only while NSE keeps the archive, so Phase 1 should be first in line.
