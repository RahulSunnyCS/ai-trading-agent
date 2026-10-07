"""
Where Parquet and raw files go, and how they are written.

    lake/bars_1m/asset=option/underlying=NIFTY/date=2026-09-29/data.parquet
    lake/bars_1m/asset=future/underlying=NIFTY/date=…/data.parquet
    lake/bars_1m/asset=index/symbol=NIFTY/date=…/data.parquet       (INDIAVIX too)
    lake/symbol_master/vendor=fyers/date=…/data.parquet
    raw/fyers/date=2026-09-29/NIFTY.jsonl.gz

Partition values (asset, underlying/symbol, date) live in the folder names only —
never duplicated as columns inside the file — so DuckDB's hive_partitioning adds
them back without a name clash. Writes are atomic (tmp file + rename): a crash
mid-write never leaves a half file that a reader would trust.

The bar schemas live here too, so every writer (the Fyers collector, the vendor
importer) produces one shape: one file per (asset, name, trading day), rows sorted
by instrument_id then ts.
"""

from __future__ import annotations

import gzip
import json
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import pyarrow as pa
import pyarrow.parquet as pq

PARTITION_KEY = {
    "option": "underlying",
    "future": "underlying",
    "index": "symbol",
    "stock": "symbol",
}

#: Bar start, exchange time zone. Parquet has no seconds unit, so files read back as ms;
#: readers normalise the unit (legwise.market._minutes casts to seconds).
TS_TYPE = pa.timestamp("s", tz="Asia/Kolkata")
OHLC_FIELDS = [
    pa.field("open", pa.float64()),
    pa.field("high", pa.float64()),
    pa.field("low", pa.float64()),
    pa.field("close", pa.float64()),
    pa.field("volume", pa.float64()),
    pa.field("oi", pa.float64()),
]
#: bars_1m for asset=index / asset=future.
BAR_SCHEMA = pa.schema(
    [
        pa.field("instrument_id", pa.int64()),
        pa.field("ts", TS_TYPE),
        *OHLC_FIELDS,
        pa.field("vendor_symbol", pa.string()),
    ]
)
#: bars_1m for asset=option: every contract of one underlying on one day.
OPT_SCHEMA = pa.schema(
    [
        pa.field("instrument_id", pa.int64()),
        pa.field("ts", TS_TYPE),
        *OHLC_FIELDS,
        pa.field("expiry", pa.date32()),
        pa.field("strike", pa.float64()),
        pa.field("option_type", pa.string()),
        pa.field("vendor_symbol", pa.string()),
    ]
)


def bars_1m_path(root: Path, asset: str, name: str, day: date) -> Path:
    key = PARTITION_KEY[asset]
    return (
        root
        / "lake"
        / "bars_1m"
        / f"asset={asset}"
        / f"{key}={name}"
        / f"date={day}"
        / "data.parquet"
    )


def symbol_master_path(root: Path, vendor: str, day: date) -> Path:
    return root / "lake" / "symbol_master" / f"vendor={vendor}" / f"date={day}" / "data.parquet"


def bars_1d_stock_path(root: Path, year: int) -> Path:
    """One file per year for every stock (not one file per stock): past years never
    change again once written, so a monthly backup re-copies only the current year."""
    return root / "lake" / "bars_1d" / "asset=stock" / f"year={year}" / "data.parquet"


def raw_path(root: Path, vendor: str, day: date, name: str) -> Path:
    return root / "raw" / vendor / f"date={day}" / f"{name}.jsonl.gz"


def _pinned_schema(path: Path) -> pa.Schema | None:
    """The schema a lake/bars_1m file must have, from its path (None for any other file)."""
    parts = path.parts
    if "bars_1m" not in parts:
        return None
    asset = parts[parts.index("bars_1m") + 1].removeprefix("asset=")
    return OPT_SCHEMA if asset == "option" else BAR_SCHEMA


def write_parquet(table: pa.Table, path: Path) -> None:
    """Atomic write. A bars_1m file must match BAR_SCHEMA / OPT_SCHEMA exactly: the catalog's
    1-minute views bind without `union_by_name` (db.FIXED_SCHEMA_VIEWS), so DuckDB would read
    a file with other columns or types by silently casting or dropping them."""
    expected = _pinned_schema(path)
    if expected is not None and not table.schema.equals(expected):
        name = "OPT_SCHEMA" if expected is OPT_SCHEMA else "BAR_SCHEMA"
        raise ValueError(
            f"{path}: not lake.{name} — cast to it before writing\n"
            f"got:\n{table.schema}\nexpected:\n{expected}"
        )
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".parquet.tmp")
    pq.write_table(table, tmp, compression="zstd")
    tmp.replace(path)


def available_days(root: Path, asset: str, name: str) -> list[date]:
    key = PARTITION_KEY[asset]
    folder = root / "lake" / "bars_1m" / f"asset={asset}" / f"{key}={name}"
    return sorted(
        date.fromisoformat(p.parent.name.removeprefix("date="))
        for p in folder.glob("date=*/data.parquet")
    )


def partitions(root: Path, asset: str) -> list[tuple[str, date, Path]]:
    """Every bars_1m file of one asset as (name, day, path), sorted. The name is the
    partition value: an underlying for option/future, a symbol for index."""
    key = PARTITION_KEY[asset]
    folder = root / "lake" / "bars_1m" / f"asset={asset}"
    out = []
    for path in folder.glob(f"{key}=*/date=*/data.parquet"):
        name = path.parent.parent.name.removeprefix(f"{key}=")
        out.append((name, date.fromisoformat(path.parent.name.removeprefix("date=")), path))
    return sorted(out)


class RawSink:
    """Collects verbatim vendor responses and writes them as one gzipped JSON-lines
    file per (day, name). Buffered in memory and flushed atomically at the end, so a
    re-run replaces the file rather than appending duplicates."""

    def __init__(self, root: Path, vendor: str, day: date) -> None:
        self.root, self.vendor, self.day = root, vendor, day
        self._lines: dict[str, list[str]] = {}

    def add(self, name: str, symbol: str, params: dict[str, Any], response: Any) -> None:
        record = {
            "symbol": symbol,
            "params": params,
            "fetched_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "response": response,
        }
        self._lines.setdefault(name, []).append(json.dumps(record, separators=(",", ":")))

    def flush(self, name: str) -> Path | None:
        lines = self._lines.pop(name, None)
        if not lines:
            return None
        path = raw_path(self.root, self.vendor, self.day, name)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        with gzip.open(tmp, "wt", encoding="utf-8") as fh:
            fh.write("\n".join(lines) + "\n")
        tmp.replace(path)
        return path
