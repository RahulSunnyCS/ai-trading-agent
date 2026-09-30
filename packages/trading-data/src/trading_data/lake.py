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


def write_parquet(table: pa.Table, path: Path) -> None:
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
