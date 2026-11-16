"""The F&O stock universe (BL-226): the stocks whose futures NSE listed on a given day, read
from the point-in-time list `obt nse fno-build` writes (`lake/eod/fno_universe/members.parquet`
under TRADING_DATA_ROOT, derived from NSE's daily F&O bhavcopy).

`members_by_year` gives Broad's yearly superset (every stock on the list at any time that year,
so the price frame holds all of them); `gate` narrows it week by week: a stock is in the universe
in week W when it was on the list on the last listed session on or before W. A stock that leaves
the list mid-year leaves the universe that week, so a holding in it is sold like any other.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pandas as pd
import pyarrow.parquet as pq


def members_path(root: Path | None = None) -> Path:
    if root is None:
        from trading_data.db import data_root

        root = data_root()
    return root / "lake" / "eod" / "fno_universe" / "members.parquet"


def bans_path(root: Path | None = None) -> Path:
    return members_path(root).with_name("bans.parquet")


def members_stamp(root: Path | None = None) -> tuple | None:
    """Size and mtime of the F&O list file (None when it is not built): part of every cache key
    a result that reads the list depends on, since a rebuild writes no catalog row."""
    path = members_path(root)
    if not path.exists():
        return None
    stat = path.stat()
    return ("fno_universe", stat.st_size, stat.st_mtime_ns)


def members_digest(through: str | None = None, root: Path | None = None) -> str | None:
    """A hash of the list's (day, symbol) rows up to `through` (all when None): what a search's
    data snapshot records, so a rebuild that changes an end-dated run's past moves its id and a
    new week beyond it does not."""
    path = members_path(root)
    if not path.exists():
        return None
    df = pq.read_table(path, columns=["date", "symbol"]).to_pandas()
    df["date"] = pd.to_datetime(df["date"])
    if through is not None:
        df = df[df["date"] <= pd.Timestamp(through)]
    rows = df.sort_values(["date", "symbol"]).astype(str).agg("|".join, axis=1)
    return hashlib.sha1("\n".join(rows).encode()).hexdigest()[:12]


def load_bans(root: Path | None = None) -> dict[pd.Timestamp, set[str]]:
    """day -> the symbols in NSE's F&O ban period that day (no new positions may be opened in
    them). A day with no ban file is absent, and `lake/eod/fno_universe/bans.parquet` records
    which days those are (its `days_without_file` metadata)."""
    path = bans_path(root)
    if not path.exists():
        raise FileNotFoundError(f"{path} is missing: run `obt nse fo-fetch`, `obt nse fno-build`")
    df = pq.read_table(path).to_pandas()
    df["date"] = pd.to_datetime(df["date"])
    return {day: set(g["symbol"]) for day, g in df.groupby("date")}


def load_members(root: Path | None = None) -> pd.DataFrame:
    path = members_path(root)
    if not path.exists():
        raise FileNotFoundError(f"{path} is missing: run `obt nse fo-fetch`, `obt nse fno-build`")
    df = pq.read_table(path).to_pandas()
    df["date"] = pd.to_datetime(df["date"])
    return df


def members_by_year(root: Path | None = None) -> dict[int, set[str]]:
    df = load_members(root)
    return {int(y): set(g["symbol"]) for y, g in df.groupby(df["date"].dt.year)}


def gate(weeks: pd.Index, symbols: list[str], root: Path | None = None) -> pd.DataFrame:
    """week x symbol booleans: on the F&O list on the last listed session on or before the week."""
    df = load_members(root)
    daily = (
        df.assign(on=True)
        .pivot_table(index="date", columns="symbol", values="on", aggfunc="any")
        .fillna(False)
        .astype(bool)
    )
    idx = pd.DatetimeIndex(weeks)
    pos = daily.index.searchsorted(idx, side="right") - 1
    out = pd.DataFrame(False, index=weeks, columns=symbols)
    known = [s for s in symbols if s in daily.columns]
    valid = pos >= 0
    if known and valid.any():
        rows = daily.iloc[pos[valid]][known].to_numpy()
        out.loc[out.index[valid], known] = rows
    return out
