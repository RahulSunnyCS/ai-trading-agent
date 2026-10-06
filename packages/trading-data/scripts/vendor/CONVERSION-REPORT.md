# Options conversion report (BL-034 Phase 0)

Generated 2026-10-06 from `_done.jsonl` (one verified record per expiry folder) and the Parquet files themselves.

## Result

| | |
|---|---|
| Expiry folders converted | **4,739 / 4,739** (index 316, stocks 4,423), 0 failures, 0 missing, 0 extra |
| Rows | **2,112,987,863** (Parquet file metadata equals the recorded, independently counted CSV rows for every file) |
| Size | 110.9 GiB of CSV data → 9.3 GiB of Parquet (11.9x), zstd level 6 |
| Layout | `parquet/options/<index\|stocks>/<name>/<expiry>.parquet` |
| Columns | `underlying, contract, strike, option_type, expiry, ts (timestamptz, +05:30), open, high, low, close, volume, oi` |

| Group | Expiry files | CSV files | Rows |
|---|---|---|---|
| index/nifty | 103 | 21,376 | 143,649,872 |
| index/sensex | 102 | 38,028 | 71,893,677 |
| index/banknifty | 29 | 8,957 | 68,448,988 |
| index/midcpnifty | 30 | 8,340 | 31,142,735 |
| index/finnifty | 30 | 7,130 | 21,134,187 |
| index/niftynxt50 | 22 | 8,720 | 3,700,483 |
| stocks (216 symbols) | 4,423 | 311,926 | 1,773,017,921 |

## How each folder was verified before its CSVs were deleted

1. The Drive file list (names + sizes, MD5 for stocks) equals what was staged locally.
2. Parquet rows == an independent count of CSV data lines; no NULL timestamps.
3. For stocks, files identical (MD5) in Drive and `stock options.zip` were taken from the zip with no download; where they differed, both were downloaded, MD5-checked, and the copy with more rows was kept.

## Findings

- **Zip vs Drive (3,581 stock folders covered by the zip):** 254,220 files identical; **147 contracts were longer in the zip, 160 longer in Drive** (each source has gaps the other fills; the longer one was used); 0 zip-only; 0 equal-rows-but-different. The two nifty zips (`2025 nifty options.zip`, `2026 … april & may 1st week.zip`) contain only files already in Drive with identical names and sizes: duplicates, not used.
- **Empty contract files:** 78,352 of 404,477 contract CSVs (19%) are header-only, empty or corrupt and appear in no Parquet file. Includes one all-NUL file identical in Drive and the zip (`LTIM_5000_PE_27_FEB_25.csv`) and one zip entry NUL-padded to 256 KiB (`MARICO_570_CE_28_NOV_24.csv`, padding stripped; after stripping it is 157,065 bytes, the same length as the Drive copy).
- **273 expiry folders hold no data at all** (all CSVs header-only, 733 KB in total): 270 stocks, 3 index (`banknifty 2024-10-01`, `finnifty 2024-10-01`, `midcpnifty 2024-09-30`), expiries 2024-09-30 → 2025-03-27. They have a (zero-row) Parquet file so the folder list stays complete. The 2014-2024 set may cover banknifty 2024-10-01 (to check in Phase 1).
- **Owner decision:** `index/nifty/2024-10-31/NIFTY_24500_PE_31_OCT_24 - Copy.csv` (a different series, 1,880 rows in `date,time` layout) was dropped; the original (25,479 rows) was kept.
- **Not recorded:** the per-folder `corrupt_skipped` field is empty because a thread race in the scratch script's bookkeeping could not carry it reliably; row counts were unaffected (all-NUL files count as 0 rows). The totals above come from comparing CSV file counts with distinct contracts in the Parquet files.

## Coverage seen in the data

index/banknifty ts 2023-03-16 → 2026-08-25; finnifty 2023-09-01 → 2026-08-25; midcpnifty 2023-06-30 → 2026-08-25; nifty 2022-03-25 → 2026-09-15 (expiries to 2026-09-15); niftynxt50 2023-09-04 → 2026-08-25; sensex 2023-07-26 → 2026-09-17; stocks 2022-09-30 → 2026-08-25. Gap before the Fyers collector (2026-09-23): 2026-08-26 → 2026-09-22 for everything except nifty/sensex (owner is sourcing it).

## Reproducing

`options_to_parquet.py` in this folder (download / verify / convert, resumable via `_done.jsonl`);
see `README.md` for how to run it and what to override. Drive listings are cached in `_remote/`.
The earlier `reconcile_zip.py` pass is superseded by the converter's zip step and was removed.
