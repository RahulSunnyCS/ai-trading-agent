#!/usr/bin/env python3
"""Cut the frozen market data the golden suite runs on (BL-001) out of the real database.

    uv run python scripts/build-golden-fixture.py [--source-root ~/TradingData] [--data-dir data]

Run on purpose and rarely: new inputs move every expected result, so it must be followed by
`scripts/update-goldens.py --accept-results --reason ...`. The fixture is a trimmed, real
slice: every catalog table the backtests read up to END, daily bars for the STOCKS most-traded
Total Market names from BARS_FROM, and the file inputs the ETF fills use.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from datetime import date
from pathlib import Path

import duckdb
import pandas as pd

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
FIXTURE = PACKAGE_ROOT / "tests" / "golden" / "fixture"
END = date(2025, 6, 27)  # a Friday; nothing after it is in the fixture
BARS_FROM = date(2017, 1, 1)
STOCKS = 170
SIZE_BUDGET_MB = 15

#: Catalog tables copied whole up to END (`date_column` None = no date to cut on).
TABLES = {
    "momentum_prices": "date",
    "stock_weekly_prices": "week",
    "stock_weekly_series": "week",
    "stock_membership_weekly": "week",
    "companies": None,
    "company_symbols": None,
}
FILES = ("etf_premium.csv", "stocks/benchmarks_weekly.csv")
FILE_FOLDERS = ("daily", "daily_etf")


def _write(con: duckdb.DuckDBPyConnection, sql: str, params: list, path: Path) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    frame = con.execute(sql, params).df()
    frame.to_parquet(path, index=False, compression="zstd")
    return len(frame)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=Path.home() / "TradingData")
    parser.add_argument("--data-dir", type=Path, default=PACKAGE_ROOT / "data")
    args = parser.parse_args()

    if FIXTURE.exists():
        shutil.rmtree(FIXTURE)
    con = duckdb.connect(str(args.source_root / "catalog.duckdb"), read_only=True)
    lake = (args.source_root / "lake/bars_1d/asset=stock/*/data.parquet").as_posix()
    bars = f"read_parquet('{lake}', hive_partitioning = true, union_by_name = true)"

    # The most-traded Total Market names over the window, by median daily turnover.
    symbols = [
        row[0]
        for row in con.execute(
            f"""SELECT i.symbol FROM {bars} b JOIN instruments i USING (instrument_id)
                WHERE b.date BETWEEN ? AND ? AND NOT coalesce(b.synthetic_close, false)
                  AND i.symbol IN (SELECT symbol FROM category_membership
                                   WHERE category = 'Total Market')
                GROUP BY i.symbol HAVING count(*) >= 250
                ORDER BY median(b.turnover) DESC, i.symbol LIMIT ?""",
            [BARS_FROM, END, STOCKS],
        ).fetchall()
    ]
    rows: dict[str, int] = {}
    tables = FIXTURE / "tables"
    for name, date_column in TABLES.items():
        where = f"WHERE {date_column} <= ?" if date_column else ""
        rows[name] = _write(
            con,
            f"SELECT * FROM {name} {where}",
            [END] if date_column else [],
            tables / f"{name}.parquet",
        )
    rows["instruments"] = _write(
        con,
        "SELECT * FROM instruments WHERE asset_class = 'stock' AND symbol IN (SELECT unnest(?))",
        [symbols],
        tables / "instruments.parquet",
    )
    rows["category_membership"] = _write(
        con,
        "SELECT * FROM category_membership WHERE symbol IN (SELECT unnest(?)) AND year <= ?",
        [symbols, END.year],
        tables / "category_membership.parquet",
    )
    for name in ("stock_action_candidates", "stock_action_reviews"):
        rows[name] = _write(
            con,
            f"SELECT * FROM {name} WHERE symbol IN (SELECT unnest(?)) AND ex_date <= ?",
            [symbols, END],
            tables / f"{name}.parquet",
        )
    for year in range(BARS_FROM.year, END.year + 1):
        rows[f"bars_{year}"] = _write(
            con,
            f"""SELECT b.instrument_id, b.date, b.series, b.isin, b.open, b.high, b.low, b.close,
                       b.prevclose, b.volume, b.turnover, b.synthetic_close
                FROM {bars} b JOIN instruments i USING (instrument_id)
                WHERE i.symbol IN (SELECT unnest(?)) AND b.date BETWEEN ? AND ?
                  AND year(b.date) = ? ORDER BY b.instrument_id, b.date""",
            [symbols, BARS_FROM, END, year],
            FIXTURE / "lake" / "bars_1d" / "asset=stock" / f"year={year}" / "data.parquet",
        )
    con.close()

    files = FIXTURE / "files"
    for relative in FILES:
        (files / relative).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(args.data_dir / relative, files / relative)
    for folder in FILE_FOLDERS:
        (files / folder).mkdir(parents=True, exist_ok=True)
        for source in sorted((args.data_dir / folder).glob("*.csv")):
            frame = pd.read_csv(source)
            frame = frame[pd.to_datetime(frame.iloc[:, 0]) <= pd.Timestamp(END)]
            frame.to_csv(files / folder / source.name, index=False)
    premium = pd.read_csv(files / "etf_premium.csv")
    premium[pd.to_datetime(premium.iloc[:, 0]) <= pd.Timestamp(END)].to_csv(
        files / "etf_premium.csv", index=False
    )

    paths = sorted(p for p in FIXTURE.rglob("*") if p.is_file())
    total = sum(p.stat().st_size for p in paths)
    manifest = {
        "end": str(END),
        "bars_from": str(BARS_FROM),
        "stocks": symbols,
        "rows": rows,
        "bytes": total,
        "sha256": {
            str(p.relative_to(FIXTURE)): hashlib.sha256(p.read_bytes()).hexdigest() for p in paths
        },
    }
    (FIXTURE / "manifest.json").write_text(json.dumps(manifest, indent=1) + "\n")
    print(f"{len(paths)} files, {total / 1e6:.1f} MB, {len(symbols)} stocks, rows {rows}")
    if total > SIZE_BUDGET_MB * 1e6:
        raise SystemExit(f"fixture is over the {SIZE_BUDGET_MB} MB budget")


if __name__ == "__main__":
    main()
