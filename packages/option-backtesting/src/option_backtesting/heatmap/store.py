"""The heatmap's rows on disk: TRADING_DATA_ROOT/heatmap/<UNDERLYING>.parquet, one row per
(day, entry time, stop loss), points per unit for each leg. Plain files, not the catalog (which
allows one writer, and `obt daily` must not wait on a heatmap build).

A build is incremental: days already in the file are kept, new collected days are added, and
`force` recomputes the range. The write is a temp file renamed over the old one."""

from __future__ import annotations

import logging
import os
from datetime import date
from pathlib import Path

import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq

from ..data.reference.loader import ReferenceData, default_reference_data
from ..fyers.daily import data_dir
from ..legwise.market import backtest_days
from . import grid

log = logging.getLogger(__name__)

SCHEMA = pa.schema(
    [
        ("day", pa.date32()),
        ("time", pa.string()),
        ("exit", pa.string()),
        ("sl", pa.int16()),
        ("strike", pa.float64()),
        ("expiry", pa.date32()),
        ("dte", pa.int16()),
        ("ce_entry", pa.float64()),
        ("pe_entry", pa.float64()),
        ("ce_pts", pa.float64()),
        ("pe_pts", pa.float64()),
        ("ce_stopped", pa.bool_()),
        ("pe_stopped", pa.bool_()),
    ]
)


def heatmap_dir(root: Path | None = None) -> Path:
    return (root or data_dir()) / "heatmap"


def path_for(underlying: str, root: Path | None = None) -> Path:
    return heatmap_dir(root) / f"{underlying}.parquet"


def read(underlying: str, root: Path | None = None) -> pa.Table | None:
    path = path_for(underlying, root)
    if not path.exists():
        return None
    table = pq.read_table(path)
    # a file written by an older layout is rebuilt, never half-read
    return table if table.schema.names == SCHEMA.names else None


def stored_days(underlying: str, root: Path | None = None) -> set[date]:
    table = read(underlying, root)
    return set(table.column("day").to_pylist()) if table is not None else set()


def _rows(cells: list[grid.Cell]) -> list[dict]:
    return [
        {
            "day": c.day,
            "time": c.time,
            "exit": c.exit,
            "sl": c.sl,
            "strike": c.strike,
            "expiry": c.expiry,
            "dte": (c.expiry - c.day).days,
            "ce_entry": c.ce_entry,
            "pe_entry": c.pe_entry,
            "ce_pts": c.ce_pts,
            "pe_pts": c.pe_pts,
            "ce_stopped": c.ce_stopped,
            "pe_stopped": c.pe_stopped,
        }
        for c in cells
    ]


def build(
    underlying: str,
    root: Path | None = None,
    start: date | None = None,
    end: date | None = None,
    *,
    force: bool = False,
    reference: ReferenceData | None = None,
) -> dict:
    """Add (or with `force` recompute) the grid for every usable collected day in [start, end].
    Returns {"added": days built, "skipped": {day: reason}, "total_days": days in the file}."""
    root = root or data_dir()
    reference = reference or default_reference_data()
    days, left_out = backtest_days(root, underlying, start, end)
    skipped: dict[date, str] = dict(left_out)
    existing = read(underlying, root)
    have = set(existing.column("day").to_pylist()) if existing is not None else set()
    todo = [d for d in days if force or d not in have]
    rows: list[dict] = []
    for day in todo:
        try:
            cells, notes = grid.day_cells(root, underlying, day, reference)
        except FileNotFoundError:
            skipped[day] = "no index or option file"
            continue
        if not cells:
            skipped[day] = "; ".join(notes[:2]) or "no cells"
            continue
        rows.extend(_rows(cells))
    built = {r["day"] for r in rows}
    if rows:
        new = pa.Table.from_pylist(rows, schema=SCHEMA)
        if existing is not None:
            keep = existing.filter(
                pc.invert(pc.is_in(existing.column("day"), pa.array(sorted(built), pa.date32())))
            )
            new = pa.concat_tables([keep.cast(SCHEMA), new])
        new = new.sort_by(
            [
                ("day", "ascending"),
                ("exit", "ascending"),
                ("time", "ascending"),
                ("sl", "ascending"),
            ]
        )
        path = path_for(underlying, root)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".parquet.tmp")
        pq.write_table(new, tmp, compression="zstd")
        os.replace(tmp, path)
        total = len(set(new.column("day").to_pylist()))
    else:
        total = len(have)
    return {"added": len(built), "skipped": skipped, "total_days": total}


def available(root: Path | None = None) -> list[dict]:
    """Every underlying with a stored grid: its day range and count."""
    out = []
    directory = heatmap_dir(root)
    if not directory.exists():
        return out
    for path in sorted(directory.glob("*.parquet")):
        table = pq.read_table(path, columns=["day"])
        days = sorted(set(table.column("day").to_pylist()))
        if not days:
            continue
        name = path.stem
        out.append(
            {
                "underlying": name,
                "kind": "index" if grid.is_index(name) else "stock",
                "expiry": grid.expiry_kind(name),
                "first_day": days[0].isoformat(),
                "last_day": days[-1].isoformat(),
                "days": len(days),
            }
        )
    return out
