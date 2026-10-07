"""
The catalog connection: root resolution, migrations, and the views over the lake.

DuckDB allows ONE read-write process at a time (a read-write connection also
locks out other processes' readers). So: open late, close early — every caller
uses `connect()` as a context manager around a short unit of work, never holds
a connection across a long download.

Within one process, `connect()` also serialises connections per catalog file
(`_CatalogLock`): read-only connections share, a read-write one is alone. DuckDB
itself cannot be opened concurrently from two threads in mixed modes, nor two
read-write connections opened and closed at once (see `_CatalogLock`).
"""

from __future__ import annotations

import os
import threading
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

#: Views whose every file is written with one pinned schema — `lake.BAR_SCHEMA` / `OPT_SCHEMA`
#: (enforced by `lake.write_parquet`) or `derived`'s schemas (each table is cast to its schema
#: before `derived._write`). They bind from the first file alone instead of `union_by_name`,
#: which reads every file's footer: on the live lake (2026-10-07: 30,174 option and 14,054
#: index day files, all one schema) that took the option view 13-21 s and the index view ~8 s,
#: against 0.5-1.7 s and 0.2-0.7 s without it. Without `union_by_name` DuckDB takes the first file's
#: columns and silently casts or drops a later file's differing ones, hence the write guard.
#: The rest keep `union_by_name` (bars_1d_stock's files differ in column order; both are tiny).
FIXED_SCHEMA_VIEWS = frozenset(
    {
        "bars_1m_option",
        "bars_1m_index",
        "bars_1m_future",
        "chain_snapshots_5m",
        "straddle_series_5m",
        "contracts_daily",
        "iv_daily",
    }
)


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

    Binding a view lists every file it covers, with the catalog locked: on the live lake
    (2026-10-07) all views together take ~1 s, the 1-minute ones nearly all of it (21-33 s
    before `FIXED_SCHEMA_VIEWS`). A caller that does not query them passes `views`
    (`connect(views=...)`); most catalog work (runs, quality, reference data) passes `()`.

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
            union = "false" if name in FIXED_SCHEMA_VIEWS else "true"
            con.execute(
                f"CREATE OR REPLACE TEMP VIEW {name} AS SELECT * FROM read_parquet("
                f"'{path}', hive_partitioning = true, union_by_name = {union})"
            )
        else:
            con.execute(f"CREATE OR REPLACE TEMP VIEW {name} AS SELECT {empty} WHERE false")


class CatalogBusy(duckdb.IOException):
    """Another thread of this process held the catalog for longer than `lock_wait`. An
    `IOException`, like DuckDB's own error for another process holding it, so a caller that
    handles one handles both."""


class _CatalogLock:
    """A readers-writer lock for one catalog file, within this process: any number of
    read-only connections at once, or one read-write connection alone. Writers go first
    (a reader arriving while a writer waits waits too), so a polled read endpoint cannot
    starve a save. Reentrant per thread in the mode it holds: a `with connect()` nested in
    another of the same mode on the same thread does not deadlock.

    Why it exists: DuckDB keeps one database instance per file per process, and opening that
    file from two threads at once only works when both are read-only. Measured on DuckDB
    1.5.6 (2026-10-07, six threads opening and closing a copy of the live catalog):
    mixed modes raise `ConnectionException: ... different configuration than existing
    connections` (583 of 1,200 opens), and read-write alone still raises `BinderException:
    Unique file handle conflict` (17 of 1,200) while one thread's close and another's open
    overlap. `_open` used to retry the first every 0.25 s for 10 s, which under the
    dashboard's polling left `GET /api/meta` waiting 8 s and more, burning CPU in the
    retries (`mbt serve`, 2026-10-07); the second was not retried at all and failed the
    request."""

    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._readers: dict[int, int] = {}  # thread id -> nesting depth
        self._writer: int | None = None
        self._writer_depth = 0
        self._writers_waiting = 0

    def acquire(self, read_only: bool, timeout: float) -> None:
        me = threading.get_ident()
        deadline = time.monotonic() + timeout
        with self._cond:
            if read_only:
                if me in self._readers:
                    self._readers[me] += 1
                    return
                if self._writer == me:
                    raise RuntimeError(
                        "this thread already holds the catalog read-write: use that "
                        "connection instead of opening a read-only one inside it"
                    )
                while self._writer is not None or self._writers_waiting:
                    if not self._cond.wait(max(0.0, deadline - time.monotonic())):
                        raise CatalogBusy(_busy_message(timeout))
                self._readers[me] = 1
                return
            if self._writer == me:
                self._writer_depth += 1
                return
            if me in self._readers:
                raise RuntimeError(
                    "this thread already holds the catalog read-only: close that "
                    "connection before opening a read-write one"
                )
            self._writers_waiting += 1
            try:
                while self._writer is not None or self._readers:
                    if not self._cond.wait(max(0.0, deadline - time.monotonic())):
                        raise CatalogBusy(_busy_message(timeout))
            finally:
                self._writers_waiting -= 1
                self._cond.notify_all()  # readers held back by this waiter may go now
            self._writer, self._writer_depth = me, 1

    def release(self, read_only: bool) -> None:
        me = threading.get_ident()
        with self._cond:
            if read_only:
                self._readers[me] -= 1
                if not self._readers[me]:
                    del self._readers[me]
            else:
                self._writer_depth -= 1
                if not self._writer_depth:
                    self._writer = None
            self._cond.notify_all()


def _busy_message(timeout: float) -> str:
    return f"the catalog was held by another thread of this process for over {timeout:g} s"


_catalog_locks: dict[str, _CatalogLock] = {}
_catalog_locks_guard = threading.Lock()


def _catalog_lock(path: Path) -> _CatalogLock:
    key = os.path.realpath(path)  # one lock per file, however the root was spelled
    with _catalog_locks_guard:
        return _catalog_locks.setdefault(key, _CatalogLock())


def _open(path: Path, read_only: bool, attempts: int = 40) -> duckdb.DuckDBPyConnection:
    """DuckDB allows one writer process; another process briefly holding the file (the
    dashboard API reading, an evening run saving) makes connect fail with a lock
    error. Retry for ~10 s before giving up — every holder only keeps it open briefly.

    Another thread of THIS process is not retried here: `connect()` waits on
    `_CatalogLock` instead, so a `ConnectionException` reaching this is a caller that
    opened the file with `duckdb.connect` directly, outside `connect()`, and it keeps
    the old retry."""
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
    catalog lock while they bind (~1 s for all of them on the live lake), so a caller that
    never reads them passes the few it does, or `()` (see `refresh_views`).

    Hold the connection for one short unit of work: never across a request that streams,
    a network fetch or a long computation (another process waits on it, `lock_wait` long,
    and so does every other thread of this one: `_CatalogLock`). Prefer `read_only=True`
    wherever nothing is written: read-only connections share, in this process and across
    processes. `lock_wait` covers both waits; past it, `CatalogBusy` (another thread) or
    DuckDB's `IOException` (another process)."""
    root = root or data_root()
    path = catalog_path(root)
    if read_only and not path.exists():
        raise FileNotFoundError(f"no catalog at {path} — run `tdata init` first")
    root.mkdir(parents=True, exist_ok=True)
    lock = _catalog_lock(path)
    start = time.monotonic()
    lock.acquire(read_only, lock_wait)
    try:
        remaining = lock_wait - (time.monotonic() - start)
        con = _open(path, read_only, attempts=max(1, round(remaining / 0.25)))
        try:
            if not read_only:
                migrate(con)
                _ensure_reference(con)
            refresh_views(con, root, views)
            yield con
        finally:
            con.close()
    finally:
        lock.release(read_only)
