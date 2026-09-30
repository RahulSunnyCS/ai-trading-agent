"""
Read-only reconstruction of momentum-backtesting's file-shaped inputs FROM the
shared local database (`packages/trading-data`), instead of `data/`.

`weekly_closes_from_db()` mirrors `pd.read_csv(DATA_DIR / "weekly_closes.csv",
index_col=0, parse_dates=True)` exactly (same shape `api.py`'s `_Data.get()` and
`cli.py`'s `_load_inputs()` both hand straight to `engine.run_backtest`), sourced from
`momentum_prices WHERE kind='weekly'` (see `002_momentum.sql`). Verified byte-for-byte
against the real file, and verified that `engine.run_backtest` produces an identical
equity curve, benchmark, weights and trade log fed either source (see TODO 3.11.4).

`stock_dataset_from_db_or_none()` is the same idea for `stocks/ui_data.py`'s five
inputs (`003_stock_weekly.sql` + `momentum_prices`), reconstructed in the exact RAW
shapes (lowercase benchmark column names, a "close"-named cash Series) the file-based
path produces, so `load_stock_dataset`'s own rename/reindex/concat logic downstream
runs completely unchanged regardless of source.

Both callers (`api.py`'s `_Data.get()`, `ui_data.load_stock_dataset()`) prefer the
database once `mbt local migrate` has populated it, falling back to files on a fresh
checkout or a test fixture that only wrote CSVs — see each `*_or_none()` function.
Custom Index and Broad Momentum still read files only; see TODO 3.11.8.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd
from trading_data.db import catalog_path, connect, data_root


def catalog_mtime(root: Path | None = None) -> float | None:
    """None if there is no catalog yet — a caller's cue that the DB path is unavailable
    at all, distinct from "the catalog exists but has no momentum_prices rows yet"."""
    path = catalog_path(root or data_root())
    return path.stat().st_mtime if path.exists() else None


def weekly_closes_from_db(root: Path | None = None) -> pd.DataFrame:
    with connect(root or data_root(), read_only=True) as con:
        rows = con.execute(
            "SELECT date, instrument, close FROM momentum_prices WHERE kind = 'weekly' "
            "ORDER BY date"
        ).fetchall()
    frame = pd.DataFrame(rows, columns=["week_ending", "instrument", "close"])
    wide = frame.pivot(index="week_ending", columns="instrument", values="close").sort_index()
    wide.index = pd.to_datetime(wide.index)
    wide.columns.name = None
    return wide


def weekly_closes_from_db_or_none(root: Path | None = None) -> pd.DataFrame | None:
    """`weekly_closes_from_db`, but None (never raises) when there is no catalog, or the
    catalog exists but has no `momentum_prices` rows yet (`mbt local migrate` not run)."""
    if catalog_mtime(root) is None:
        return None
    frame = weekly_closes_from_db(root)
    return frame if not frame.empty else None


def _pivot_weekly(rows: list, value_col: str) -> pd.DataFrame:
    frame = pd.DataFrame(rows, columns=["week", "id", value_col])
    wide = frame.pivot(index="week", columns="id", values=value_col).sort_index()
    wide.index = pd.to_datetime(wide.index)
    wide.columns.name = None
    return wide


def _momentum_prices_frame(con, instruments: tuple[str, ...]) -> pd.DataFrame:
    rows = con.execute(
        "SELECT date, instrument, close FROM momentum_prices WHERE kind = 'weekly' "
        "AND instrument IN (SELECT unnest(?)) ORDER BY date",
        [list(instruments)],
    ).fetchall()
    return _pivot_weekly(rows, "close") if rows else pd.DataFrame()


#: `stocks/ui_data.py`'s five inputs, in RAW (pre-rename) shape.
StockDatasetRaw = tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.Series]


def stock_dataset_from_db_or_none(root: Path | None = None) -> StockDatasetRaw | None:
    """None (never raises) when the catalog is missing, or has none of `stock_weekly_prices`
    yet (`mbt local migrate` not run) — the caller's cue to read the files instead."""
    from .engine import CASH
    from .stocks.ui_data import NIFTY50_EQUAL_WEIGHT_TRI, NIFTY50_TRI, NIFTY200_MOMENTUM30_TRI

    if catalog_mtime(root) is None:
        return None
    with connect(root or data_root(), read_only=True) as con:
        tr = _pivot_weekly(
            con.execute(
                "SELECT week, company_id, close FROM stock_weekly_prices WHERE kind = 'tr'"
            ).fetchall(),
            "close",
        )
        if tr.empty:
            return None  # migrated catalog, but `mbt stocks fetch` never ran
        price = _pivot_weekly(
            con.execute(
                "SELECT week, company_id, close FROM stock_weekly_prices WHERE kind = 'price'"
            ).fetchall(),
            "close",
        )
        membership = _pivot_weekly(
            con.execute(
                "SELECT week, company_id, is_member FROM stock_membership_weekly"
            ).fetchall(),
            "is_member",
        )
        # RAW lowercase names, matching benchmarks_weekly.csv's own columns — the caller
        # (load_stock_dataset) applies ui_data.py's own canonical rename, unchanged.
        raw_to_canonical = {
            "nifty50_tri": NIFTY50_TRI,
            "nifty200_momentum30_tri": NIFTY200_MOMENTUM30_TRI,
            "nifty50_ew_tri": NIFTY50_EQUAL_WEIGHT_TRI,
        }
        benchmarks = _momentum_prices_frame(con, tuple(raw_to_canonical.values())).rename(
            columns={v: k for k, v in raw_to_canonical.items()}
        )
        cash_frame = _momentum_prices_frame(con, (CASH,))
        cash = (cash_frame[CASH] if CASH in cash_frame else pd.Series(dtype=float)).rename("close")
    return tr, price, membership, benchmarks, cash


def has_category_data(root: Path | None = None) -> bool:
    """Cheap existence check for the "has this been fetched at all" gates in api.py —
    a count, not a full frame load. True as soon as ANY non-Total-Market category row
    exists, matching what category_membership.csv's mere presence used to signal."""
    if catalog_mtime(root) is None:
        return False
    with connect(root or data_root(), read_only=True) as con:
        return bool(
            con.execute(
                "SELECT 1 FROM category_membership WHERE category != 'Total Market' LIMIT 1"
            ).fetchone()
        )


def constant_current_total_market_years_from_db_or_none(
    root: Path | None = None,
) -> list[int] | None:
    """Years whose Total Market membership is `source_tier='constant_current'` (a
    live-list stand-in, not real point-in-time history) — mirrors `api.py`'s
    `_membership_quality`'s file-based query exactly. None (never raises) when there
    is no catalog, or no Total Market rows yet."""
    if not has_total_market_data(root):
        return None
    with connect(root or data_root(), read_only=True) as con:
        rows = con.execute(
            "SELECT DISTINCT year FROM category_membership WHERE category = 'Total Market' "
            "AND source_tier = 'constant_current'"
        ).fetchall()
    return sorted(int(r[0]) for r in rows)


def has_total_market_data(root: Path | None = None) -> bool:
    if catalog_mtime(root) is None:
        return False
    with connect(root or data_root(), read_only=True) as con:
        return bool(
            con.execute(
                "SELECT 1 FROM category_membership WHERE category = 'Total Market' LIMIT 1"
            ).fetchone()
        )


def category_membership_from_db_or_none(root: Path | None = None) -> pd.DataFrame | None:
    """Mirrors `data_dir/category_membership.csv` exactly (category, year, symbol,
    source_tier, wayback_timestamp) — EXCLUDING 'Total Market' (see
    total_market_members_by_year_from_db_or_none for that; the file never held those
    rows either). None (never raises) when there is no catalog, or it has no non-Total-
    Market rows yet — the caller's cue to read the file instead."""
    if catalog_mtime(root) is None:
        return None
    with connect(root or data_root(), read_only=True) as con:
        rows = con.execute(
            "SELECT category, year, symbol, source_tier, wayback_timestamp "
            "FROM category_membership WHERE category != 'Total Market'"
        ).fetchall()
    if not rows:
        return None
    return pd.DataFrame(
        rows, columns=["category", "year", "symbol", "source_tier", "wayback_timestamp"]
    )


#: (date, symbol, close, turnover) — matches categories/prices.py::load_daily_prices exactly.
_DAILY_PRICE_COLUMNS = ("date", "symbol", "close", "turnover")


def daily_prices_from_db_or_none(
    symbols: list[str], root: Path | None = None
) -> pd.DataFrame | None:
    """Mirrors `categories/prices.py::load_daily_prices`'s exact output (date, symbol,
    close, turnover; sorted by symbol then date) for the given symbols, sourced from
    `bars_1d_stock` joined to `instruments`. None (never raises) ONLY when there is no
    catalog at all — the caller's cue to read daily.parquet instead. If the catalog
    exists but none of `symbols` have bars, returns an EMPTY frame with the right
    columns (not None), matching load_daily_prices' own "no error, just empty" contract
    for that case — the DB is already the same source the file was built from, so
    falling back to the file would not find anything different."""
    if catalog_mtime(root) is None:
        return None
    if not symbols:
        return pd.DataFrame(columns=list(_DAILY_PRICE_COLUMNS))
    with connect(root or data_root(), read_only=True) as con:
        rows = con.execute(
            "SELECT b.date, i.symbol, b.close, b.turnover FROM bars_1d_stock b "
            "JOIN instruments i USING (instrument_id) WHERE i.symbol IN (SELECT unnest(?)) "
            "ORDER BY i.symbol, b.date",
            [symbols],
        ).fetchall()
    frame = pd.DataFrame(rows, columns=list(_DAILY_PRICE_COLUMNS))
    frame["date"] = pd.to_datetime(frame["date"])
    return frame


def total_market_members_by_year_from_db_or_none(
    root: Path | None = None,
) -> dict[int, set[str]] | None:
    """Mirrors `categories/broad.py::total_market_members_by_year`'s return shape exactly
    (year -> member symbols), sourced from `category_membership` (category='Total Market',
    sharing that table with the per-sector rows — see `db_migrate.import_total_market_
    membership`). None (never raises) when there is no catalog, or the catalog has no
    'Total Market' rows yet — the caller's cue to read the CSV instead."""
    if catalog_mtime(root) is None:
        return None
    with connect(root or data_root(), read_only=True) as con:
        rows = con.execute(
            "SELECT year, symbol FROM category_membership WHERE category = 'Total Market'"
        ).fetchall()
    if not rows:
        return None
    out: dict[int, set[str]] = {}
    for year, symbol in rows:
        out.setdefault(int(year), set()).add(symbol)
    return out
