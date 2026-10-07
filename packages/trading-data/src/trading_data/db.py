"""
The catalog connection: root resolution, migrations, and the views over the lake.

DuckDB allows ONE read-write process at a time (a read-write connection also
locks out other processes' readers). So: open late, close early — every caller
uses `connect()` as a context manager around a short unit of work, never holds
a connection across a long download.
"""

from __future__ import annotations

import os
import time
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from importlib import resources
from pathlib import Path

import duckdb

DEFAULT_ROOT = Path.home() / "TradingData"

#: view name -> (lake sub-path glob, empty-view column list used when no files exist yet)
LAKE_VIEWS: dict[str, tuple[str, str]] = {
    "bars_1m_option": (
        "bars_1m/asset=option/*/*/data.parquet",
        "NULL::BIGINT AS instrument_id, NULL::TIMESTAMPTZ AS ts, NULL::DOUBLE AS open, "
        "NULL::DOUBLE AS high, NULL::DOUBLE AS low, NULL::DOUBLE AS close, "
        "NULL::DOUBLE AS volume, NULL::DOUBLE AS oi, NULL::DATE AS expiry, "
        "NULL::DOUBLE AS strike, NULL::TEXT AS option_type, NULL::TEXT AS vendor_symbol, "
        "NULL::TEXT AS underlying, NULL::DATE AS date",
    ),
    "bars_1m_index": (
        "bars_1m/asset=index/*/*/data.parquet",
        "NULL::BIGINT AS instrument_id, NULL::TIMESTAMPTZ AS ts, NULL::DOUBLE AS open, "
        "NULL::DOUBLE AS high, NULL::DOUBLE AS low, NULL::DOUBLE AS close, "
        "NULL::DOUBLE AS volume, NULL::DOUBLE AS oi, NULL::TEXT AS vendor_symbol, "
        "NULL::TEXT AS symbol, NULL::DATE AS date",
    ),
    "bars_1m_future": (
        "bars_1m/asset=future/*/*/data.parquet",
        "NULL::BIGINT AS instrument_id, NULL::TIMESTAMPTZ AS ts, NULL::DOUBLE AS open, "
        "NULL::DOUBLE AS high, NULL::DOUBLE AS low, NULL::DOUBLE AS close, "
        "NULL::DOUBLE AS volume, NULL::DOUBLE AS oi, NULL::TEXT AS vendor_symbol, "
        "NULL::TEXT AS underlying, NULL::DATE AS date",
    ),
    "symbol_master": (
        "symbol_master/*/*/data.parquet",
        "NULL::TEXT AS vendor_symbol, NULL::TEXT AS underlying, NULL::DATE AS expiry, "
        "NULL::DOUBLE AS strike, NULL::TEXT AS option_type, NULL::INTEGER AS lot_size, "
        "NULL::TEXT AS vendor, NULL::DATE AS date",
    ),
    "bars_1d_stock": (
        "bars_1d/asset=stock/*/data.parquet",
        "NULL::BIGINT AS instrument_id, NULL::DATE AS date, NULL::TEXT AS series, "
        "NULL::TEXT AS isin, NULL::DOUBLE AS open, NULL::DOUBLE AS high, "
        "NULL::DOUBLE AS low, NULL::DOUBLE AS close, NULL::DOUBLE AS prevclose, "
        "NULL::BIGINT AS volume, NULL::DOUBLE AS turnover, "
        "NULL::BOOLEAN AS synthetic_close, NULL::INTEGER AS year",
    ),
    # BL-034 Phase 3 derived tables (trading_data.derived). tests/test_derived.py checks these
    # placeholder columns against derived's schemas, so the two cannot drift.
    "chain_snapshots_5m": (
        "derived/chain_snapshots_5m/*/*/data.parquet",
        "NULL::TIMESTAMPTZ AS bucket, NULL::DATE AS expiry, NULL::DOUBLE AS strike, "
        "NULL::TEXT AS option_type, NULL::SMALLINT AS offset, NULL::DOUBLE AS open, "
        "NULL::DOUBLE AS high, NULL::DOUBLE AS low, NULL::DOUBLE AS close, "
        "NULL::DOUBLE AS volume, NULL::DOUBLE AS oi, NULL::BOOLEAN AS traded, "
        "NULL::DOUBLE AS spot_open, NULL::DOUBLE AS spot_high, NULL::DOUBLE AS spot_low, "
        "NULL::DOUBLE AS spot_close, NULL::DOUBLE AS vix, NULL::SMALLINT AS dte, "
        "NULL::DOUBLE AS t_years, NULL::DOUBLE AS forward, NULL::TEXT AS forward_source, "
        "NULL::DOUBLE AS iv, NULL::DOUBLE AS delta, NULL::DOUBLE AS gamma, "
        "NULL::DOUBLE AS theta, NULL::DOUBLE AS vega, NULL::TEXT AS iv_quality, "
        "NULL::TEXT AS underlying, NULL::DATE AS date",
    ),
    "straddle_series_5m": (
        "derived/straddle_series_5m/*/*/data.parquet",
        "NULL::TIMESTAMPTZ AS bucket, NULL::DATE AS expiry, NULL::SMALLINT AS dte, "
        "NULL::DOUBLE AS spot_open, NULL::DOUBLE AS spot_close, NULL::DOUBLE AS vix, "
        "NULL::DOUBLE AS atm, NULL::DOUBLE AS ce_close, NULL::DOUBLE AS pe_close, "
        "NULL::DOUBLE AS straddle, NULL::DOUBLE AS atm_open, NULL::DOUBLE AS ce_open, "
        "NULL::DOUBLE AS pe_open, NULL::DOUBLE AS straddle_open, NULL::DOUBLE AS forward, "
        "NULL::DOUBLE AS atm_iv, NULL::DOUBLE AS skew, NULL::TEXT AS underlying, "
        "NULL::DATE AS date",
    ),
    "contracts_daily": (
        "derived/contracts_daily/*/*/data.parquet",
        "NULL::BIGINT AS instrument_id, NULL::DATE AS expiry, NULL::DOUBLE AS strike, "
        "NULL::TEXT AS option_type, NULL::SMALLINT AS dte, NULL::TIMESTAMPTZ AS first_ts, "
        "NULL::TIMESTAMPTZ AS last_ts, NULL::INTEGER AS bars, "
        "NULL::INTEGER AS traded_minutes, NULL::DOUBLE AS open, NULL::DOUBLE AS high, "
        "NULL::DOUBLE AS low, NULL::DOUBLE AS close, NULL::DOUBLE AS volume, "
        "NULL::DOUBLE AS oi, NULL::TEXT AS underlying, NULL::DATE AS date",
    ),
    "iv_daily": (
        "derived/iv_daily/*/data.parquet",
        "NULL::DATE AS trading_day, NULL::DATE AS expiry, NULL::SMALLINT AS expiry_rank, "
        "NULL::SMALLINT AS dte, NULL::DOUBLE AS atm_iv_0920, NULL::DOUBLE AS atm_iv_1500, "
        "NULL::DOUBLE AS skew_1500, NULL::DOUBLE AS straddle_1500, "
        "NULL::DOUBLE AS forward_1500, NULL::DOUBLE AS spot_close, "
        "NULL::DOUBLE AS vix_close, NULL::DOUBLE AS rv_20, NULL::DATE AS front_expiry, "
        "NULL::DOUBLE AS front_iv_1500, NULL::DOUBLE AS vix_pct_1y, "
        "NULL::DOUBLE AS vix_pct_2y, NULL::DOUBLE AS front_iv_pct_1y, "
        "NULL::DOUBLE AS front_iv_pct_2y, NULL::DOUBLE AS iv_7d_1500, "
        "NULL::DOUBLE AS iv_7d_pct_1y, NULL::DOUBLE AS iv_7d_pct_2y, "
        "NULL::TEXT AS underlying",
    ),
}



def data_root(*, require_mounted: bool = True) -> Path:
    """TRADING_DATA_ROOT, else ~/TradingData. On the owner's laptop that is an APFS disk
    image on the external SSD (`tdata mount`); `require_mounted` refuses a root on a
    volume that is not mounted, so no process silently writes somewhere else."""
    override = os.environ.get("TRADING_DATA_ROOT", "").strip()
    root = Path(override).expanduser() if override else DEFAULT_ROOT
    if require_mounted:
        check_mounted(root)
    return root


def check_mounted(root: Path) -> None:
    """Raise if `root` lives on /Volumes/<name> and that volume is not mounted. Catches
    the image not being attached (the SSD unplugged, or not mounted yet after login) and
    it being attached under another name ("TradingData 1"). `~/TradingData` may be a
    symlink to the image: resolving it checks the target, so a dangling link also fails
    here instead of `mkdir` creating a fresh, empty root."""
    resolved = root.expanduser().resolve(strict=False)
    parts = resolved.parts
    if len(parts) >= 3 and parts[1] == "Volumes" and not os.path.ismount(Path(*parts[:3])):
        raise RuntimeError(
            f"the trading data root {root} is on {Path(*parts[:3])}, which is not mounted "
            "— run `tdata mount` (attaches TRADING_DATA_IMAGE), or connect the SSD"
        )


def catalog_path(root: Path | None = None) -> Path:
    return (root or data_root()) / "catalog.duckdb"


def _migrations() -> list[tuple[str, str]]:
    folder = resources.files("trading_data") / "migrations"
    files = sorted(p for p in folder.iterdir() if p.name.endswith(".sql"))
    return [(p.name.removesuffix(".sql"), p.read_text()) for p in files]


def migrate(con: duckdb.DuckDBPyConnection) -> list[str]:
    """Apply pending migrations in filename order, each in its own transaction.
    Returns the versions applied. Identified by filename, like apps/server's runner:
    never edit an applied migration — add a new file."""
    has_table = con.execute(
        "SELECT count(*) FROM information_schema.tables WHERE table_name = 'schema_migrations'"
    ).fetchone()[0]
    applied = (
        {r[0] for r in con.execute("SELECT version FROM schema_migrations").fetchall()}
        if has_table
        else set()
    )
    done = []
    for version, sql in _migrations():
        if version in applied:
            continue
        con.execute("BEGIN")
        try:
            con.execute(sql)
            con.execute("INSERT INTO schema_migrations (version) VALUES (?)", [version])
            con.execute("COMMIT")
        except Exception:
            con.execute("ROLLBACK")
            raise
        done.append(version)
    return done


def _ensure_reference(con: duckdb.DuckDBPyConnection) -> None:
    """A brand-new catalog (whoever created it) gets the reference data from the
    committed CSVs once; after that the catalog is the master."""
    if con.execute("SELECT count(*) FROM ref_lot_sizes").fetchone()[0] == 0:
        from .reference import REFERENCE_DIR, import_csvs

        if (REFERENCE_DIR / "lot_sizes.csv").exists():
            import_csvs(con)


def refresh_views(
    con: duckdb.DuckDBPyConnection, root: Path, views: Iterable[str] | None = None
) -> None:
    """(Re)create TEMP views over the lake for this connection — temp so they work on
    read-only connections too and always point at the CURRENT root, even after the
    folder has moved to another disk. `views` limits it to those names (None = all of
    `LAKE_VIEWS`); works on any connection, an in-memory one included.

    Binding a view reads the footer of every file it covers (`union_by_name`): on the live
    lake (2026-10-07: ~30k option and ~14k index day files) the two 1-minute views take
    ~20-35 s, all of it with the catalog locked. A caller that does not query them passes
    `views` (`connect(views=...)`).

    Only runs on `connect()`'s way in. If a lake glob matched nothing, the view is a
    fixed empty placeholder for that connection's whole lifetime — a write made
    through THIS SAME connection later (e.g. a migration that first registers
    instruments, then writes Parquet) is invisible to a query on this connection
    afterward. Always read back through a NEW `connect()` call (a fresh process, or
    a second `with connect(...)` block), never the writer's own connection."""
    names = list(LAKE_VIEWS) if views is None else list(views)
    unknown = sorted(set(names) - LAKE_VIEWS.keys())
    if unknown:
        raise ValueError(f"no lake view named {', '.join(unknown)}")
    for name in names:
        glob, empty = LAKE_VIEWS[name]
        # read_parquet errors on a glob that matches nothing, so a fresh lake gets an
        # empty view with the same columns instead.
        if any((root / "lake").glob(glob)):
            path = (root / "lake" / glob).as_posix().replace("'", "''")
            con.execute(
                f"CREATE OR REPLACE TEMP VIEW {name} AS SELECT * FROM read_parquet("
                f"'{path}', hive_partitioning = true, union_by_name = true)"
            )
        else:
            con.execute(f"CREATE OR REPLACE TEMP VIEW {name} AS SELECT {empty} WHERE false")


def _open(path: Path, read_only: bool, attempts: int = 40) -> duckdb.DuckDBPyConnection:
    """DuckDB allows one writer process; another process briefly holding the file (the
    dashboard API reading, an evening run saving) makes connect fail with a lock
    error. Retry for ~10 s before giving up — every holder only keeps it open briefly.

    The SAME process can also hit this: two requests in a FastAPI server's threadpool
    (e.g. a saved-run POST's write connection still open when a concurrent GET opens a
    read-only one) raise `ConnectionException: ... different configuration than
    existing connections` instead of `IOException` — same transient cause, same fix.
    Reproduced live 2026-09-30 in `mbt ui`: a stock-dataset GET arriving while a
    saved-runs POST's write connection was still open 500'd instead of just waiting the
    ~1s for it to close."""
    for attempt in range(attempts):
        try:
            return duckdb.connect(str(path), read_only=read_only)
        except duckdb.IOException as error:
            if "lock" not in str(error).lower() or attempt == attempts - 1:
                raise
            time.sleep(0.25)
        except duckdb.ConnectionException as error:
            if "different configuration" not in str(error).lower() or attempt == attempts - 1:
                raise
            time.sleep(0.25)
    raise AssertionError("unreachable")


@contextmanager
def connect(
    root: Path | None = None,
    *,
    read_only: bool = False,
    lock_wait: float = 10.0,
    views: Iterable[str] | None = None,
) -> Iterator[duckdb.DuckDBPyConnection]:
    """`lock_wait`: seconds to keep retrying while another process holds the catalog. 10 s
    suits an interactive command; a long import that has already written files and only
    needs to record them passes minutes (a crash between the two leaves unrecorded days).

    `views`: the lake views this connection needs (None = all). Every caller holds the
    catalog lock while they bind, and the 1-minute ones take tens of seconds on the live
    lake, so a caller that never reads them passes the few it does (see `refresh_views`).

    Hold the connection for one short unit of work: never across a request that streams,
    a network fetch or a long computation (another process waits on it, `lock_wait` long)."""
    root = root or data_root()
    path = catalog_path(root)
    if read_only and not path.exists():
        raise FileNotFoundError(f"no catalog at {path} — run `tdata init` first")
    root.mkdir(parents=True, exist_ok=True)
    con = _open(path, read_only, attempts=max(1, round(lock_wait / 0.25)))
    try:
        if not read_only:
            migrate(con)
            _ensure_reference(con)
        refresh_views(con, root, views)
        yield con
    finally:
        con.close()
