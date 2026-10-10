"""A day's weekday, 09:15 India VIX open and band, and each index's days to the nearest listed
expiry, read from the lake (the quantities `research/bl056/analyse.py::day_features`
derives)."""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import duckdb
from trading_data import lake, quality

from .score import dte_label, vix_band

IST = ZoneInfo("Asia/Kolkata")
VIX_NAME = "INDIAVIX"
UNDERLYINGS = ("NIFTY", "SENSEX")


def vix_bar_epoch(day: date) -> int:
    """The start of the 09:15 IST bar, as the epoch seconds every source (lake, Fyers, Angel One)
    stamps it with. The ONE definition of "the 09:15 VIX open"."""
    return int(
        datetime(day.year, day.month, day.day, 9, 15, tzinfo=IST).astimezone(UTC).timestamp()
    )


def excluded_map(root: Path) -> dict[str, dict[date, str]]:
    """{index: {day: reason}} of the days data_quality excludes ({} when there is no snapshot)."""
    return {u: quality.excluded_days(root, "option", u) or {} for u in UNDERLYINGS}


def is_collected(root: Path, day: date, excluded: dict[str, dict[date, str]] | None = None) -> bool:
    """A weekday both indices have option and index bars for that data_quality does not exclude."""
    excluded = excluded if excluded is not None else excluded_map(root)
    return day.weekday() < 5 and all(
        lake.bars_1m_path(root, "option", u, day).exists()
        and lake.bars_1m_path(root, "index", u, day).exists()
        and day not in excluded[u]
        for u in UNDERLYINGS
    )


def last_collected_before(root: Path, day: date, within: int = 14) -> date | None:
    """The latest collected day before `day` (holiday-proof: a shut day simply has no file)."""
    excluded = excluded_map(root)
    d = day - timedelta(days=1)
    for _ in range(within):
        if is_collected(root, d, excluded):
            return d
        d -= timedelta(days=1)
    return None


def vix_open_from_lake(root: Path, day: date) -> float | None:
    path = lake.bars_1m_path(root, "index", VIX_NAME, day)
    if not path.exists():
        return None
    con = duckdb.connect()
    try:
        # the 09:15 bar itself: a later bar's open is not the "VIX open" (a gap gives None)
        row = con.execute(
            "SELECT open FROM read_parquet(?) WHERE epoch(ts) = ? LIMIT 1",
            [str(path), vix_bar_epoch(day)],
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
