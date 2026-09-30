"""
One-off: copy momentum-backtesting's data into the shared trading-data catalog
(`packages/trading-data`, TRADING_DATA_ROOT).

What moves where, and why:

  companies.csv, aliases.csv          -> companies, company_symbols tables
  nifty50_membership.csv              -> index_membership (index_name='NIFTY50')
  data/categories/category_membership.csv -> category_membership table
  data/stocks/events.parquet          -> corporate_actions table
  data/stocks/daily.parquet           -> lake/bars_1d/asset=stock/year=<YYYY>/ (Parquet,
                                          NOT a table — 6.9M rows; see trading_data.lake)
  data/daily, data/daily_etf,
  data/etf_premium.csv, data/weekly_closes.csv
                                       -> momentum_prices table (mirrors the retired Neon
                                          schema's (instrument, kind, date) shape exactly,
                                          via the SAME rows_from_dir() this package already
                                          used to push to Neon — see store.py)

The curated CSVs and the raw parquet stay the master copies (git-tracked research, most
of it built from Wayback Machine archaeology — flipping mastery to the DB the way
reference.py does for lot sizes would risk losing that history's own diffability). This
import is re-run wholesale each time (`mbt db migrate`): every target table/partition is
replaced, never appended to, so running it twice is harmless.

Stock instrument identity is the literal exchange symbol AT THE TIME (matching
daily.parquet's own `symbol` column) — MUNDRAPORT and its later name ADANIPORTS are two
`instruments` rows, linked by `company_id` for the ~95 companies curated so far (aliases.csv
covers the Nifty 50 universe only; the other ~4,200 symbols in daily.parquet get an
instrument row with no company_id, which is a query convenience left for later curation,
not a data loss).
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

import duckdb
import pandas as pd
import pyarrow as pa
import pyarrow.compute as pc
import pyarrow.parquet as pq
from trading_data import lake
from trading_data.instruments import InstrumentSpec, register

from . import store
from .config import DATA_DIR

CURATED_DIR = Path(__file__).with_name("stocks") / "curated"
NIFTY50_INDEX_NAME = "NIFTY50"


def _insert_many(con: duckdb.DuckDBPyConnection, sql: str, frame: pd.DataFrame) -> None:
    """`executemany` with pandas NaN turned into SQL NULL, and a no-op on an empty
    frame (DuckDB's executemany rejects an empty parameter list outright)."""
    if frame.empty:
        return
    clean = frame.astype(object).where(pd.notna(frame), None)
    con.executemany(sql, clean.values.tolist())


@dataclass(frozen=True)
class MigrationReport:
    companies: int = 0
    company_symbols: int = 0
    corporate_actions: int = 0
    index_membership: int = 0
    category_membership: int = 0
    stock_instruments: int = 0
    stock_bars: int = 0
    stock_years: int = 0
    momentum_prices: int = 0
    stock_weekly_prices: int = 0
    stock_membership_weekly: int = 0
    total_market_membership: int = 0


# ---------------------------------------------------------------------------
# Curated CSVs: companies, renames, index/category membership
# ---------------------------------------------------------------------------


def import_curated(
    con: duckdb.DuckDBPyConnection, curated_dir: Path = CURATED_DIR
) -> tuple[int, int, int]:
    companies = pd.read_csv(curated_dir / "companies.csv")
    aliases = pd.read_csv(curated_dir / "aliases.csv")
    membership = pd.read_csv(curated_dir / "nifty50_membership.csv")

    con.execute("DELETE FROM companies")
    _insert_many(con, "INSERT INTO companies VALUES (?, ?)", companies[["company_id", "name"]])
    con.execute("DELETE FROM company_symbols")
    _insert_many(
        con,
        "INSERT INTO company_symbols VALUES (?, ?, ?, ?, ?)",
        aliases[["company_id", "symbol", "from", "to", "source"]],
    )
    con.execute("DELETE FROM index_membership WHERE index_name = ?", [NIFTY50_INDEX_NAME])
    membership = membership.assign(index_name=NIFTY50_INDEX_NAME)
    _insert_many(
        con,
        "INSERT INTO index_membership VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        membership[
            ["index_name", "company_id", "symbol", "from", "to", "kind", "source", "source2"]
        ],
    )
    return len(companies), len(aliases), len(membership)


def import_category_membership(con: duckdb.DuckDBPyConnection, path: Path) -> int:
    """`path` is data/categories/category_membership.csv — a FETCHED cache (`mbt
    categories fetch`), not a hand-curated file, so (unlike companies/aliases/
    membership above) this is exactly the kind of CSV cache this migration retires.
    Scoped delete (not the whole table) because total_market_membership.csv shares
    this same table — see import_total_market_membership below."""
    if not path.exists():
        return 0
    frame = pd.read_csv(path)
    con.execute("DELETE FROM category_membership WHERE category != 'Total Market'")
    _insert_many(
        con,
        "INSERT INTO category_membership VALUES (?, ?, ?, ?, ?)",
        frame[["category", "year", "symbol", "source_tier", "wayback_timestamp"]],
    )
    return len(frame)


def import_total_market_membership(con: duckdb.DuckDBPyConnection, path: Path) -> int:
    """`data/categories/total_market_membership.csv` — same (category, year, symbol,
    source_tier, wayback_timestamp) shape as category_membership.csv (category is
    always the literal 'Total Market'), so it shares that table rather than getting
    its own; Custom Index and Broad Momentum both need it (`total_market_members_by_year`
    in categories/broad.py) and it was the one raw input D-4 missed the first time."""
    if not path.exists():
        return 0
    frame = pd.read_csv(path, dtype={"year": int, "symbol": str})
    con.execute("DELETE FROM category_membership WHERE category = 'Total Market'")
    _insert_many(
        con,
        "INSERT INTO category_membership VALUES (?, ?, ?, ?, ?)",
        frame[["category", "year", "symbol", "source_tier", "wayback_timestamp"]],
    )
    return len(frame)


# ---------------------------------------------------------------------------
# Corporate actions
# ---------------------------------------------------------------------------


def import_corporate_actions(con: duckdb.DuckDBPyConnection, events_path: Path) -> int:
    if not events_path.exists():
        return 0
    events = pq.read_table(events_path)
    con.execute("DELETE FROM corporate_actions")
    con.register("_events", events)
    try:
        con.execute(
            "INSERT INTO corporate_actions SELECT company_id, symbol_at_ex, session, ex_date, "
            "kind, factor, dividend, source, subject_sha1 FROM _events"
        )
    finally:
        con.unregister("_events")
    return events.num_rows


# ---------------------------------------------------------------------------
# Stock daily bars: instruments + Parquet lake, year-partitioned
# ---------------------------------------------------------------------------


def register_stock_instruments(
    con: duckdb.DuckDBPyConnection, symbols: list[str], curated_dir: Path = CURATED_DIR
) -> dict[str, int]:
    company_of_symbol: dict[str, str] = {}
    aliases_path = curated_dir / "aliases.csv"
    if aliases_path.exists():
        aliases = pd.read_csv(aliases_path)
        company_of_symbol = dict(zip(aliases["symbol"], aliases["company_id"], strict=True))
    specs = [
        InstrumentSpec("stock", "NSE", symbol, company_id=company_of_symbol.get(symbol))
        for symbol in symbols
    ]
    by_key = register(con, specs)
    return {spec.symbol: by_key[spec.key] for spec in specs}


def _year_batches(path: Path) -> Iterator[tuple[int, pa.Table]]:
    table = pq.read_table(path)
    years = pc.year(table.column("date"))
    table = table.append_column("year", years)
    for year in sorted(set(years.to_pylist())):
        yield year, table.filter(pc.equal(table.column("year"), year)).drop(["year"])


def migrate_stock_bars(
    con: duckdb.DuckDBPyConnection, root: Path, daily_parquet: Path, curated_dir: Path = CURATED_DIR
) -> tuple[int, int, int]:
    if not daily_parquet.exists():
        return 0, 0, 0
    symbols = sorted(
        pc.unique(pq.read_table(daily_parquet, columns=["symbol"]).column("symbol")).to_pylist()
    )
    ids = register_stock_instruments(con, symbols, curated_dir)
    total_rows = 0
    years = 0
    for year, batch in _year_batches(daily_parquet):
        instrument_id = pa.array([ids[s] for s in batch.column("symbol").to_pylist()], pa.int64())
        out = batch.drop(["symbol"]).append_column("instrument_id", instrument_id)
        lake.write_parquet(out, lake.bars_1d_stock_path(root, year))
        total_rows += out.num_rows
        years += 1
    return len(symbols), total_rows, years


# ---------------------------------------------------------------------------
# momentum_prices — reuses store.py's existing rows_from_dir exactly
# ---------------------------------------------------------------------------


def import_momentum_prices(con: duckdb.DuckDBPyConnection, data_dir: Path = DATA_DIR) -> int:
    rows = list(store.rows_from_dir(data_dir))
    con.execute("DELETE FROM momentum_prices")
    if rows:
        con.executemany(
            "INSERT INTO momentum_prices VALUES (?, ?, ?, ?, ?)",
            [
                [instrument, kind, day.date(), opened, close]
                for instrument, kind, day, opened, close in rows
            ],
        )
    return len(rows)


# ---------------------------------------------------------------------------
# Stock dataset's weekly, already-adjusted series (`stocks/ui_data.py::load_stock_dataset`'s
# five inputs) — kept as their own tables (003_stock_weekly.sql), not recomputed from
# bars_1d_stock/corporate_actions; see that migration's docstring for why.
# ---------------------------------------------------------------------------


def _read_weekly(path: Path) -> pd.DataFrame | None:
    return pd.read_csv(path, index_col=0, parse_dates=True) if path.exists() else None


def _melt_weekly(frame: pd.DataFrame, value_name: str) -> pd.DataFrame:
    out = frame.reset_index(names="week").melt(
        id_vars="week", var_name="company_id", value_name=value_name
    )
    out = out.dropna(subset=[value_name])
    out["week"] = out["week"].dt.date
    return out


def import_stock_weekly(con: duckdb.DuckDBPyConnection, stocks_dir: Path) -> tuple[int, int, int]:
    """Returns (price rows, membership rows, cash/benchmark rows written to momentum_prices)."""
    tr = _read_weekly(stocks_dir / "nifty50_weekly_tr.csv")
    price = _read_weekly(stocks_dir / "nifty50_weekly_price.csv")
    membership = _read_weekly(stocks_dir / "nifty50_membership_weekly.csv")
    benchmarks = _read_weekly(stocks_dir / "benchmarks_weekly.csv")
    cash = _read_weekly(stocks_dir / "cash_weekly.csv")

    con.execute("DELETE FROM stock_weekly_prices")
    n_prices = 0
    for kind, frame in (("tr", tr), ("price", price)):
        if frame is None:
            continue
        long = _melt_weekly(frame, "close")
        con.executemany(
            "INSERT INTO stock_weekly_prices VALUES (?, ?, ?, ?)",
            [
                [cid, kind, week, close]
                for cid, week, close in zip(
                    long["company_id"], long["week"], long["close"], strict=True
                )
            ],
        )
        n_prices += len(long)

    con.execute("DELETE FROM stock_membership_weekly")
    n_membership = 0
    if membership is not None:
        long = _melt_weekly(membership.astype(bool), "is_member")
        con.executemany(
            "INSERT INTO stock_membership_weekly VALUES (?, ?, ?)",
            list(zip(long["company_id"], long["week"], long["is_member"], strict=True)),
        )
        n_membership = len(long)

    # Renamed to ui_data.py's own output column names — momentum_prices' instrument names
    # must match exactly what api.py/the engine expect to see, same rule as the ETF dataset.
    n_extra = 0
    if benchmarks is not None:
        from .stocks.ui_data import _BENCHMARK_COLUMNS  # noqa: PLC0415 (avoid a hard import cycle)

        renamed = benchmarks[[c for c in _BENCHMARK_COLUMNS if c in benchmarks.columns]].rename(
            columns=_BENCHMARK_COLUMNS
        )
        n_extra += _insert_weekly_kind(con, renamed, "weekly")
    if cash is not None:
        from .engine import CASH  # noqa: PLC0415

        n_extra += _insert_weekly_kind(con, cash.rename(columns={"close": CASH}), "weekly")
    return n_prices, n_membership, n_extra


def _insert_weekly_kind(con: duckdb.DuckDBPyConnection, frame: pd.DataFrame, kind: str) -> int:
    con.executemany(
        f"DELETE FROM momentum_prices WHERE kind = '{kind}' AND instrument = ?",
        [[c] for c in frame.columns],
    )
    long = _melt_weekly(frame, "close")
    if long.empty:
        return 0
    con.executemany(
        "INSERT INTO momentum_prices VALUES (?, ?, ?, NULL, ?)",
        list(zip(long["company_id"], [kind] * len(long), long["week"], long["close"], strict=True)),
    )
    return len(long)


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------


def migrate(
    con: duckdb.DuckDBPyConnection,
    root: Path,
    data_dir: Path = DATA_DIR,
    curated_dir: Path = CURATED_DIR,
) -> MigrationReport:
    n_companies, n_aliases, n_membership = import_curated(con, curated_dir)
    n_category = import_category_membership(
        con, data_dir / "categories" / "category_membership.csv"
    )
    n_total_market = import_total_market_membership(
        con, data_dir / "categories" / "total_market_membership.csv"
    )
    n_actions = import_corporate_actions(con, data_dir / "stocks" / "events.parquet")
    n_symbols, n_bars, n_years = migrate_stock_bars(
        con, root, data_dir / "stocks" / "daily.parquet", curated_dir
    )
    n_prices = import_momentum_prices(con, data_dir)
    n_stock_prices, n_stock_membership, n_extra = import_stock_weekly(con, data_dir / "stocks")
    return MigrationReport(
        companies=n_companies,
        company_symbols=n_aliases,
        corporate_actions=n_actions,
        index_membership=n_membership,
        category_membership=n_category + n_total_market,
        stock_instruments=n_symbols,
        stock_bars=n_bars,
        stock_years=n_years,
        momentum_prices=n_prices + n_extra,
        stock_weekly_prices=n_stock_prices,
        stock_membership_weekly=n_stock_membership,
        total_market_membership=n_total_market,
    )
