"""BL-071 part B / BL-034 Phase 5: convert the Drive `2014-2024/<index>/<year>/<expiry>/*.csv` option
history into the staging Parquet layout `tdata vendor import` reads.

    uv run python scripts/drive_csv_to_parquet.py --src "<.../2014-2024/nifty>" --out <staging>/index/nifty \
        --from 2022-01-01 --to 2024-10-02 [--workers 4]

One Parquet per expiry folder, `<out>/<expiry>.parquet`, columns underlying, contract, strike,
option_type, expiry, ts (timestamptz, UTC), open, high, low, close, volume, oi — the layout of the
vendor's own `parquet/options/index/<name>/<expiry>.parquet`. Source CSVs: `date,time,open,high,low,
close,volume,oi`, `dd-mm-yyyy`, `HH:MM` IST (the minute the bar starts), one file per contract holding
only its expiry week and only the minutes that traded. Nothing is filled here (the engine forward-fills
on its 375-minute grid). Skipped and counted: `- Copy` files (a different series, dropped by the owner in
BL-034), AppleDouble `._*`, files whose name is not `<SYMBOL>_<strike>_<CE|PE>_<dd>_<MON>_<yy>`, empty
and header-only files. Resumable: an expiry whose Parquet exists is not redone. A `_convert.jsonl` in
`--out` records one line per expiry (rows read, rows written, files skipped by reason).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import duckdb

NAME = re.compile(r"^([A-Z]+)_(\d+(?:\.\d+)?)_(CE|PE)_(\d{2})_([A-Z]{3})_(\d{2})$")
MONTHS = {
    m: i
    for i, m in enumerate(
        ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1
    )
}


def list_folders(src: Path, lo: date, hi: date) -> list[tuple[date, Path]]:
    """(expiry, folder) for every `<year>/<YYYY-MM-DD>` folder with lo <= expiry <= hi."""
    out = []
    for year in sorted(p for p in src.iterdir() if p.is_dir() and p.name.isdigit()):
        for f in sorted(p for p in year.iterdir() if p.is_dir()):
            try:
                d = date.fromisoformat(f.name[:10])
            except ValueError:
                continue
            if lo <= d <= hi:
                out.append((d, f))
    return out


def contract_files(folder: Path) -> tuple[list[tuple[Path, tuple]], dict[str, int]]:
    """Source files that are real contract CSVs with a parseable name, and the skip counts."""
    keep, skipped = [], {"copy": 0, "appledouble": 0, "bad_name": 0}
    for f in sorted(folder.glob("*.csv")):
        if f.name.startswith("."):
            skipped["appledouble"] += 1
        elif " - Copy" in f.stem:
            skipped["copy"] += 1
        elif not (m := NAME.match(f.stem)):
            skipped["bad_name"] += 1
        else:
            keep.append((f, m.groups()))
    return keep, skipped


def convert_folder(expiry: date, folder: Path, out_dir: Path) -> dict:
    target = out_dir / f"{expiry.isoformat()}.parquet"
    if target.exists():
        return {"expiry": str(expiry), "status": "exists"}
    files, skipped = contract_files(folder)
    rows_in, empty, errors = 0, 0, []
    con = duckdb.connect()
    con.execute("SET TimeZone='Asia/Kolkata'")
    con.execute(
        "CREATE TEMP TABLE bars (underlying VARCHAR, contract VARCHAR, strike DOUBLE, option_type VARCHAR,"
        " expiry DATE, ts TIMESTAMPTZ, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume BIGINT, oi DOUBLE)"
    )
    for f, (u, strike, typ, dd, mon, yy) in files:
        contract_expiry = date(2000 + int(yy), MONTHS[mon], int(dd))
        try:
            n = con.execute(
                """
                INSERT INTO bars
                SELECT ?, ?, ?, ?, ?,
                       strptime(date || ' ' || time, '%d-%m-%Y %H:%M') AT TIME ZONE 'Asia/Kolkata',
                       open, high, low, close, CAST(volume AS BIGINT), oi
                FROM read_csv(?, header = true, ignore_errors = true,
                     columns = {'date': 'VARCHAR', 'time': 'VARCHAR', 'open': 'DOUBLE', 'high': 'DOUBLE',
                                'low': 'DOUBLE', 'close': 'DOUBLE', 'volume': 'DOUBLE', 'oi': 'DOUBLE'})
                WHERE date IS NOT NULL AND time IS NOT NULL AND close IS NOT NULL
                """,
                [u, f.stem, float(strike), typ, contract_expiry, str(f)],
            ).fetchone()[0]
        except duckdb.Error as error:  # one bad row fails the whole file: say which and why
            n = 0
            errors.append({"file": f.name, "error": str(error).splitlines()[0][:160]})
        if n == 0:
            empty += 1
        rows_in += n
    rows = con.execute("SELECT count(*) FROM bars").fetchone()[0]
    dups = con.execute("SELECT count(*) - count(DISTINCT (contract, ts)) FROM bars").fetchone()[0]
    if rows:
        con.execute("CREATE TEMP TABLE out AS SELECT * FROM bars ORDER BY contract, ts")
        tmp = target.with_suffix(".tmp")
        con.execute("COPY out TO ? (FORMAT PARQUET, COMPRESSION ZSTD)", [str(tmp)])
        tmp.rename(target)
    con.close()
    status = "written" if rows else "empty"
    if errors:  # never reported as a clean day: the run prints it and the log keeps the files
        status += "_with_errors"
    return {
        "expiry": str(expiry),
        "status": status,
        "files": len(files),
        "files_empty": empty,
        "files_errored": len(errors),
        "errors": errors[:20],
        "rows": rows,
        "duplicate_rows": dups,
        "skipped": skipped,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--from", dest="lo", type=date.fromisoformat, required=True)
    ap.add_argument("--to", dest="hi", type=date.fromisoformat, required=True)
    ap.add_argument("--workers", type=int, default=4)
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    folders = list_folders(a.src, a.lo, a.hi)
    print(f"{len(folders)} expiry folders {a.lo} .. {a.hi}", flush=True)
    log = a.out / "_convert.jsonl"
    done = 0
    with ThreadPoolExecutor(a.workers) as pool, log.open("a") as fh:
        for r in pool.map(lambda t: convert_folder(t[0], t[1], a.out), folders):
            fh.write(json.dumps(r) + "\n")
            fh.flush()
            done += 1
            if done % 10 == 0 or r["status"] not in ("written", "exists"):
                print(f"{done}/{len(folders)} {r}", flush=True)
    print("done", flush=True)


if __name__ == "__main__":
    sys.exit(main())
