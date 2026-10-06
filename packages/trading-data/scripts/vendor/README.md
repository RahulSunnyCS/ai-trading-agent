# Vendor options history — how it was converted (BL-034 Phase 0)

The provenance of the staging set that `tdata vendor import` loads. **Not part of the package**
and not run by anything; kept so the conversion can be audited or redone.

## What the vendor sent

An options history shared as Google Drive folders (and a 6.5 GB `stock options.zip` holding
most of the stocks' files), one CSV per contract per expiry:

- `options/index/<nifty|sensex|banknifty|finnifty|midcpnifty|niftynxt50>/<expiry>/<contract>.csv`
- `options/stocks/<216 symbols>/<expiry>/<contract>.csv`
- 1-minute OHLC, volume, OI; full contract lives; expiries Oct 2024 → Sep 2026.

The CSVs are huge in file count (404,477) and in bytes (110.9 GiB), so they were converted once
into one Parquet file per expiry on the external SSD, and the CSVs deleted.

## The staging set

```
/Volumes/RAHUL'S SSD/Stock Market Data/parquet/options/<index|stocks>/<unit>/<expiry>.parquet
columns: underlying, contract, strike, option_type, expiry, ts (TIMESTAMPTZ, IST bar start),
         open, high, low, close, volume (BIGINT), oi
```

4,739 files, 2,112,987,863 rows, 9.3 GiB. **This is the vendor's only raw copy on the machine** —
the lake is derivable from it. Keep a second copy somewhere else. `CONVERSION-REPORT.md` (here)
has the counts and every anomaly found.

## The scripts

- `options_to_parquet.py` — for each expiry folder: list it on Drive (names, sizes, MD5), take
  files from the local zip where the MD5 matches, download only the rest, verify names/sizes/MD5,
  convert to one Parquet file, check Parquet rows == an independent CSV line count, then delete
  the CSVs. Resumable through `_done.jsonl`.

  ```bash
  # needs duckdb + pytz, and an rclone remote named `gdrive:` with read-only access to the share
  uv run --with duckdb --with pytz python options_to_parquet.py --workers 5 --max-minutes 105
  ```

  Defaults are the paths and share id that ran; override with `BL034_ROOT` (the disk folder that
  holds `options/` and `parquet/`), `BL034_DRIVE_ROOT` (the Drive folder id) and `BL034_ZIP` (the
  local `stock options.zip`). When the vendor adds or corrects files: `--refresh` rebuilds the
  cached folder list **and** the per-stock Drive listings, and `--redo stocks/RELIANCE` converts
  folders again that `_done.jsonl` already lists (a folder's key alone says it is done, not that
  it is current). rclone failures are retried only when transient (rate limit, 5xx, network).
- An earlier `reconcile_zip.py` that patched finished Parquet files from the zip was removed:
  the zip comparison now happens inside the converter, per folder, before anything is written.
  It is in git history.

## Checking a load

Two scripts check the lake against the vendor's data; run them from `packages/trading-data`
with `TRADING_DATA_ROOT` set (they need `duckdb`; `verify_values.py` also an `rclone` remote
`gdrive:` and the vendor zips on the SSD):

- `verify_lake.py [folder ...]` — **completeness**: for each staged unit, the lake's vendor-written
  rows must equal the staging rows, read from the Parquet footers (works while an import runs;
  skips days the Fyers collector wrote; sums a renamed stock's symbols).
- `verify_values.py` — **values**: draws random contract CSVs from sources that did not go through
  the conversion (the vendor's zips, Drive via rclone) and 25 random days of each spot/VIX CSV,
  and compares every row cell by cell (open, high, low, close, volume, oi per minute) with the
  lake. `SEED=...` gives another sample. Run on 2026-10-07: 957,290 option rows (158 files across
  NIFTY, SENSEX, BANKNIFTY, FINNIFTY, MIDCPNIFTY, NIFTYNXT50 and stocks) and 37,160 spot/VIX
  rows, **0 differing, 0 only in the CSV, 0 only in the lake**.

## Findings that shaped the importer

Where the zip and Drive disagreed each held 147 / 160 contracts that were longer than the other's
copy (the longer one was kept); one contract file is all NUL bytes in both sources; one zip entry
is NUL-padded to a 256 KiB block (stripped); a `- Copy` file carried a different series under a
contract name (the owner kept the original); 78,352 contract files were header-only; 273 whole
expiry folders had no data. Details and counts: `CONVERSION-REPORT.md`.

## Loading it

```bash
cd packages/trading-data
uv run tdata vendor import --from "/Volumes/RAHUL'S SSD/Stock Market Data/parquet/options" --unit nifty
```
