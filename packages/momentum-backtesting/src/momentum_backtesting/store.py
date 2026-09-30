"""File <-> rows conversion for a momentum `data/` folder.

Was also the Postgres (Neon) price/signal store until 2026-09-30 (TODO.md 3.11.5, `mbt db
init/push/pull`, `MOMENTUM_DATABASE_URL`) — retired in favour of the shared local database
(`local_store.py`, `packages/trading-data`). `rows_from_dir`/`write_dir` are the one piece
still used, by `db_migrate.import_momentum_prices` (the local database's own writer) and by
`local_store.pull_dir` (the inverse, rebuilding `data/` from the database) — kept here rather
than duplicated, since both directions belong together as a pair.

  momentum_prices   (instrument, kind, date) -> open, close
      kind: signal     data/daily/<name>.csv
            etf        data/daily_etf/<name>.csv
            at10_index data/intraday/index/<name>.csv   (close = the 10:00 price)
            at10_etf   data/intraday/etf/<name>.csv
            premium    data/etf_premium.csv             (close = close / NAV - 1)
            weekly     data/weekly_closes.csv           (date = the week's Friday)
"""

from collections.abc import Iterator
from pathlib import Path

import pandas as pd

# kind -> (folder under data/, value column in the file)
FOLDERS = {
    "signal": ("daily", None),
    "etf": ("daily_etf", None),
    "at10_index": ("intraday/index", "price"),
    "at10_etf": ("intraday/etf", "price"),
}

Row = tuple[str, str, pd.Timestamp, float | None, float]


def _num(value) -> float | None:
    return None if pd.isna(value) else float(value)


def rows_from_dir(data_dir: Path, since: pd.Timestamp | None = None) -> Iterator[Row]:
    """Every price point in a data folder as (instrument, kind, date, open, close)."""
    for kind, (folder, value_col) in FOLDERS.items():
        for path in sorted((data_dir / folder).glob("*.csv")):
            if path.stem.endswith("(weekly)"):  # silver's splice log, rebuilt by fetch
                continue
            frame = pd.read_csv(path, index_col=0, parse_dates=True)
            name = path.stem
            if since is not None:
                frame = frame[frame.index >= since]
            close_col = value_col or "close"
            for day, row in frame.iterrows():
                if pd.isna(row[close_col]):
                    continue
                opened = _num(row["open"]) if value_col is None and "open" in frame else None
                yield name, kind, day, opened, float(row[close_col])
    for kind, file in (("premium", "etf_premium.csv"), ("weekly", "weekly_closes.csv")):
        path = data_dir / file
        if not path.exists():
            continue
        frame = pd.read_csv(path, index_col=0, parse_dates=True)
        if since is not None:
            frame = frame[frame.index >= since]
        for name in frame:
            for day, value in frame[name].dropna().items():
                yield name, kind, day, None, float(value)


def write_dir(rows: list[Row], data_dir: Path) -> None:
    """The inverse of rows_from_dir: rebuild the data folder's files from stored rows."""
    frame = pd.DataFrame(rows, columns=["instrument", "kind", "date", "open", "close"])
    frame["date"] = pd.to_datetime(frame["date"])
    for kind, (folder, value_col) in FOLDERS.items():
        part = frame[frame["kind"] == kind]
        for name, group in part.groupby("instrument"):
            out = group.set_index("date").sort_index()
            out.index.name = "date"
            target = data_dir / folder / f"{name}.csv"
            target.parent.mkdir(parents=True, exist_ok=True)
            if value_col:
                out[["close"]].rename(columns={"close": value_col}).to_csv(target)
            elif out["open"].notna().any():
                out[["open", "close"]].to_csv(target)
            else:
                out[["close"]].to_csv(target)
    for kind, file, index_name in (
        ("premium", "etf_premium.csv", "date"),
        ("weekly", "weekly_closes.csv", "week_ending"),
    ):
        part = frame[frame["kind"] == kind]
        if part.empty:
            continue
        wide = part.pivot(index="date", columns="instrument", values="close").sort_index()
        wide.index.name = index_name
        wide.columns.name = None
        data_dir.mkdir(parents=True, exist_ok=True)
        wide.to_csv(data_dir / file)
