"""A day's weekday, 09:15 India VIX open and band, and each index's days to the nearest listed
expiry, read from the lake (the quantities `research/bl056/analyse.py::day_features`
derives)."""

from __future__ import annotations

from datetime import UTC, date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import duckdb
from trading_data import lake

from .score import dte_label, vix_band

IST = ZoneInfo("Asia/Kolkata")
VIX_NAME = "INDIAVIX"


def vix_open_from_lake(root: Path, day: date) -> float | None:
    path = lake.bars_1m_path(root, "index", VIX_NAME, day)
    if not path.exists():
        return None
    first = int(
        datetime(day.year, day.month, day.day, 9, 15, tzinfo=IST).astimezone(UTC).timestamp()
    )
    con = duckdb.connect()
    try:
        row = con.execute(
            "SELECT arg_min(open, ts) FROM read_parquet(?) WHERE epoch(ts) >= ?", [str(path), first]
        ).fetchone()
    finally:
        con.close()
    return float(row[0]) if row and row[0] is not None else None


def nearest_expiry(root: Path, underlying: str, day: date) -> date | None:
    """The nearest expiry on or after `day` among the contracts that have bars that day."""
    path = lake.bars_1m_path(root, "option", underlying, day)
    if not path.exists():
        return None
    con = duckdb.connect()
    try:
        row = con.execute(
            "SELECT min(expiry)::VARCHAR FROM read_parquet(?) WHERE expiry >= CAST(? AS DATE)",
            [str(path), day.isoformat()],
        ).fetchone()
    finally:
        con.close()
    return date.fromisoformat(row[0]) if row and row[0] else None


def day_attributes(root: Path, day: date) -> dict:
    vix = vix_open_from_lake(root, day)
    out: dict = {
        "day": day.isoformat(),
        "weekday": day.strftime("%a"),
        "vix_open": "" if vix is None else round(vix, 4),
        "vix_band": vix_band(vix),
    }
    for key, underlying in (("dte_n", "NIFTY"), ("dte_s", "SENSEX")):
        exp = nearest_expiry(root, underlying, day)
        out[key] = dte_label(None if exp is None else (exp - day).days)
    return out
