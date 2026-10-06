"""Independent completeness check of the vendor import: staging rows vs lake rows, per unit.
Reads Parquet footers only (no catalog), so it works while an import is running.
usage: verify_lake.py [FOLDER ...]   (staging folder names, e.g. nifty ZOMATO; default all)"""
import os, sys
from pathlib import Path
import duckdb
import pyarrow.parquet as pq
from trading_data import vendor
root = Path(os.environ.get("TRADING_DATA_ROOT", "/Volumes/TradingData"))
staging = Path("/Volumes/RAHUL'S SSD/Stock Market Data/parquet/options")
only = {a.lower() for a in sys.argv[1:]}
con = duckdb.connect()
ok, bad, missing, tot_s, tot_l = 0, [], [], 0, 0
for u in vendor.list_units(staging):
    if only and u.folder.lower() not in only: continue
    symbols = [r[0] for r in con.execute("SELECT DISTINCT underlying FROM read_parquet(?) WHERE underlying <> ''", [[str(f) for f in u.files]]).fetchall()]
    l_rows, nfiles = 0, 0
    for sym in symbols:
        folder = root / "lake" / "bars_1m" / "asset=option" / f"underlying={sym}"
        for f in sorted(folder.glob("date=*/data.parquet")) if folder.exists() else []:
            nfiles += 1
            first = next(pq.ParquetFile(f).iter_batches(batch_size=1, columns=["vendor_symbol"]), None)
            if first is not None and str(first.column(0)[0].as_py()).startswith(("NSE:", "BSE:")): continue  # a Fyers-collector day
            l_rows += pq.read_metadata(f).num_rows
    tot_s += u.rows; tot_l += l_rows
    if not nfiles: missing.append(u.folder)
    elif l_rows == u.rows: ok += 1
    else: bad.append((u.folder, symbols, u.rows, l_rows, l_rows - u.rows))
print(f"units equal: {ok} | missing from lake: {len(missing)} | mismatched: {len(bad)}")
if len(missing) <= 12 and missing: print("  missing:", missing)
for b in bad[:20]: print("  MISMATCH", b)
print(f"staging rows {tot_s:,} | lake vendor rows {tot_l:,} | difference {tot_l - tot_s:,}")
