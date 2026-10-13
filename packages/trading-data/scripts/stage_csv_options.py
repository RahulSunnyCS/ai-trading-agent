"""Stage the vendor's per-contract 1-minute options CSVs (the "2014-2024" set) as per-expiry
Parquet files in the layout `tdata vendor import` reads:

    <out>/index/<unit>/<expiry>.parquet
    columns: underlying, contract, strike, option_type, expiry, ts, open, high, low, close, volume, oi

Source layout: <src>/<year>/<expiry date>/<UNDERLYING>_<strike>_<CE|PE>_<DD>_<MON>_<YY>.csv
with header `date,time,open,high,low,close,volume[,oi]`. Before late 2020 the date is ISO and
there is no open interest (written as 0.0, as the vendor's own staged Parquet does when it has
none); later files carry `oi` and `dd-mm-yyyy` dates. Times are IST.

    uv run python scripts/stage_csv_options.py --src ".../2014-2024/nifty" --out <dir> \
        --underlying NIFTY --unit nifty --to 2022-02-28

Resumable: an expiry whose output file exists is skipped. Run `tdata vendor import --from <out>
--unit nifty --days 2013-01-01..2022-01-02` afterwards; days the lake already holds are skipped.
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path

import duckdb

NAME = re.compile(r"^(?P<u>[A-Z0-9&-]+)_(?P<strike>\d+(?:\.\d+)?)_(?P<type>CE|PE)_\d{2}_[A-Z]{3}_\d{2}$")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, type=Path, help="<...>/nifty (holds <year>/<expiry>/*.csv)")
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--underlying", required=True)
    ap.add_argument("--unit", required=True, help="staging folder name, e.g. nifty")
    ap.add_argument("--from", dest="lo", default="0000-01-01", help="first expiry to stage")
    ap.add_argument("--to", dest="hi", default="9999-12-31", help="last expiry to stage")
    a = ap.parse_args()

    dest = a.out / "index" / a.unit
    dest.mkdir(parents=True, exist_ok=True)
    folders = sorted(p for p in a.src.glob("*/*") if p.is_dir() and a.lo <= p.name <= a.hi)
    con = duckdb.connect()
    con.execute("SET TimeZone='Asia/Kolkata'")
    for folder in folders:
        out = dest / f"{folder.name}.parquet"
        if out.exists():
            continue
        files = sorted(folder.glob("*.csv"))
        if not files:
            continue
        rows = 0
        tmp = out.with_suffix(".tmp")
        con.execute("DROP TABLE IF EXISTS staged")
        con.execute(
            "CREATE TABLE staged (underlying VARCHAR, contract VARCHAR, strike DOUBLE, option_type VARCHAR,"
            " expiry DATE, ts TIMESTAMPTZ, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE,"
            " volume BIGINT, oi DOUBLE)"
        )
        for f in files:
            m = NAME.match(f.stem)
            if not m or m["u"] != a.underlying:
                continue
            try:
                with f.open("rb") as fh:
                    header = fh.readline(200).decode("ascii", "ignore").strip().lower()
                has_oi = header.split(",")[-1] == "oi"
                names = ["d", "t", "o", "h", "l", "c", "v"] + (["oi"] if has_oi else [])
                cols = ", ".join(f"'{n}':'VARCHAR'" for n in names)
                oi_expr = "COALESCE(TRY_CAST(oi AS DOUBLE), 0.0)" if has_oi else "0.0"
                dt = "COALESCE(TRY_STRPTIME(d, '%Y-%m-%d'), TRY_STRPTIME(d, '%d-%m-%Y'))"
                n = con.execute(
                    f"""INSERT INTO staged
                        SELECT ?, ?, ?, ?, ?::DATE,
                               ({dt}::DATE::VARCHAR || ' ' || t || ':00+05:30')::TIMESTAMPTZ,
                               TRY_CAST(o AS DOUBLE), TRY_CAST(h AS DOUBLE), TRY_CAST(l AS DOUBLE),
                               TRY_CAST(c AS DOUBLE), TRY_CAST(TRY_CAST(v AS DOUBLE) AS BIGINT), {oi_expr}
                        FROM read_csv(?, header=true, all_varchar=true, columns={{{cols}}})
                        WHERE TRY_CAST(o AS DOUBLE) IS NOT NULL AND TRY_CAST(c AS DOUBLE) IS NOT NULL
                          AND {dt} IS NOT NULL""",
                    [a.underlying, f.stem, float(m["strike"]), m["type"], folder.name, str(f)],
                ).fetchone()
                rows += n[0] if n else 0
            except (duckdb.Error, OSError) as e:  # an empty / NUL-padded file: skip it, say so
                print(f"  skip {f.name}: {str(e).splitlines()[0][:80]}")
        quoted = str(tmp).replace("'", "''")
        con.execute(f"COPY staged TO '{quoted}' (FORMAT PARQUET, COMPRESSION ZSTD)")
        tmp.rename(out)
        print(f"{folder.name}: {len(files)} files -> {con.execute('SELECT count(*) FROM staged').fetchone()[0]:,} rows")


if __name__ == "__main__":
    main()
