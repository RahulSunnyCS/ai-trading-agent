"""
Loading the vendor's 1-minute history into the lake (BL-034).

The vendor's options arrive as a verified staging set of per-expiry Parquet files
(`<staging>/<index|stocks>/<unit>/<expiry>.parquet`, columns underlying, contract, strike,
option_type, expiry, ts, open, high, low, close, volume, oi) and its index spot / India VIX
as 1-minute CSVs. This module re-partitions them into the lake's one-file-per-(asset, name,
trading day) layout, registers every contract in the catalog and judges every day it writes.

Rules:

* **Every vendor row is kept** — including the 15:30-15:39 closing bars (Fyers' own files
  have them) and special sessions (Budget Saturdays, Muhurat evenings). `data_quality` labels
  the days; nothing is dropped. Only rows whose contract name could not be parsed have no
  instrument to belong to; they are counted and recorded, not written.
* **The Fyers collector wins.** A day file the collector wrote is never overwritten, not
  even with `force`; a day a previous vendor import wrote is rewritten only with `force`.
* **Resumable.** The work is cut into date chunks (one `ingest_runs` row each, scope
  `NIFTY 2025-06-01..2025-06-30`); a chunk that finished `ok` is skipped on a re-run, and
  existing day files are skipped regardless.
* One DuckDB connection to the catalog at a time, only for the short register / record steps
  — never held across the scan (see db.py). The scanning uses a private in-memory DuckDB.
"""

from __future__ import annotations

import shutil
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, timedelta
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from . import ingest, lake, quality
from .db import connect as _connect_catalog
from .instruments import InstrumentSpec, instrument_key, register

VENDOR = "drive-vendor"
#: Import order for the index section: the underlyings the owner trades first.
INDEX_UNITS = ("nifty", "sensex", "banknifty", "finnifty", "midcpnifty", "niftynxt50")
#: A chunk is cut so that about this many rows are in memory at once (~100 B/row in DuckDB).
CHUNK_TARGET_ROWS = 8_000_000
TZ = "Asia/Kolkata"
#: Seconds to wait for the catalog's single writer before giving up (see db.connect).
LOCK_WAIT = 600.0

OPTION_COLUMNS = (
    "instrument_id, ts, open, high, low, close, volume, oi, expiry, strike, option_type, "
    "vendor_symbol"
)
BAR_COLUMNS = "instrument_id, ts, open, high, low, close, volume, oi, vendor_symbol"


class VendorError(RuntimeError):
    pass


@dataclass(frozen=True)
class Unit:
    section: str  # index | stocks
    folder: str  # as named in the staging set, e.g. "nifty", "M&M"
    files: list[Path]
    rows: int

    @property
    def asset_class(self) -> str:
        """Of the options' underlying."""
        return "index" if self.section == "index" else "stock"


@dataclass
class UnitReport:
    name: str
    chunks_run: int = 0
    chunks_skipped: int = 0
    days_written: int = 0
    days_skipped_existing: int = 0
    rows_written: int = 0
    rows_unparsed: int = 0
    excluded: dict[str, int] = field(default_factory=dict)


def _connect(root: Path, *, read_only: bool = False):
    return _connect_catalog(root, read_only=read_only, lock_wait=LOCK_WAIT)


def exchange_for(symbol: str) -> str:
    """SENSEX trades on BSE (index and options); everything else here is NSE."""
    return "BSE" if symbol == "SENSEX" else "NSE"


# ---------------------------------------------------------------------------
# Listing the staging set
# ---------------------------------------------------------------------------


def list_units(
    staging: Path, *, units: list[str] | None = None, section: str = "all"
) -> list[Unit]:
    """Units in import order (index units first, in INDEX_UNITS order; stocks A-Z). Explicit
    listing, never a glob: the staging disk is ExFAT, which sprouts AppleDouble `._*`
    siblings; zero-row files (expiries the vendor shipped empty) are skipped."""
    wanted = {u.lower() for u in units or []}
    out: list[Unit] = []
    for sec in ("index", "stocks"):
        base = staging / sec
        if section not in ("all", sec) or not base.is_dir():
            continue
        folders = [p for p in base.iterdir() if p.is_dir() and not p.name.startswith(".")]
        if sec == "index":
            folders.sort(
                key=lambda p: (
                    INDEX_UNITS.index(p.name) if p.name in INDEX_UNITS else len(INDEX_UNITS),
                    p.name,
                )
            )
        else:
            folders.sort(key=lambda p: p.name)
        for folder in folders:
            if wanted and folder.name.lower() not in wanted:
                continue
            files, rows = [], 0
            for f in sorted(folder.glob("*.parquet")):
                if f.name.startswith("."):
                    continue
                n = pq.read_metadata(f).num_rows
                if n:
                    files.append(f)
                    rows += n
            if files:
                out.append(Unit(sec, folder.name, files, rows))
    return out


# ---------------------------------------------------------------------------
# The scanning connection
# ---------------------------------------------------------------------------


def _open_duck() -> tuple[duckdb.DuckDBPyConnection, Path]:
    tmp = Path(tempfile.mkdtemp(prefix="tdata-vendor-"))
    con = duckdb.connect()
    con.execute(f"SET temp_directory = '{tmp.as_posix()}'")
    con.execute("SET threads = 4")
    con.execute("SET memory_limit = '2GB'")
    con.execute("SET preserve_insertion_order = false")
    con.execute(f"SET TimeZone = '{TZ}'")
    return con, tmp


def _arrow(result) -> pa.Table:
    return result.to_arrow_table() if hasattr(result, "to_arrow_table") else result.arrow()


def _next_month(d: date) -> date:
    return (d.replace(day=1) + timedelta(days=32)).replace(day=1)


def plan_chunks(
    monthly_rows: list[tuple[date, int]],
    window: tuple[date, date],
    target: int = CHUNK_TARGET_ROWS,
) -> list[tuple[date, date]]:
    """Cut months (month start, rows) into [lo, hi) date ranges of about `target` rows,
    clipped to the inclusive day window. A single month bigger than the target is its own
    chunk."""
    lo_w, hi_w = window
    chunks: list[tuple[date, date]] = []
    start: date | None = None
    acc = 0
    for month, n in sorted(monthly_rows):
        if start is not None and acc + n > target:
            chunks.append((start, month))
            start, acc = None, 0
        if start is None:
            start = month
        acc += n
    if start is not None:
        chunks.append((start, _next_month(max(m for m, _ in monthly_rows))))
    out = []
    for lo, hi in chunks:
        lo, hi = max(lo, lo_w), min(hi, hi_w + timedelta(days=1) if hi_w < date.max else hi)
        if lo < hi:
            out.append((lo, hi))
    return out


def _ts_param(d: date) -> str:
    return f"{d.isoformat()} 00:00:00+05:30"


# ---------------------------------------------------------------------------
# Judging and writing one chunk (shared by options and index CSVs)
# ---------------------------------------------------------------------------


def _day_stats(con: duckdb.DuckDBPyConnection, asset: str, name: str) -> list[quality.DayStats]:
    """Per-day stats of the `chunk` temp table (columns incl. day, ins)."""
    head = con.execute(
        "SELECT day, count(*), count(DISTINCT instrument_id), count(DISTINCT expiry), "
        "count(*) FILTER (WHERE NOT ins), epoch(min(ts)), epoch(max(ts)) FROM chunk GROUP BY day"
    ).fetchall()
    bars = dict(
        con.execute(
            "SELECT day, max(n) FROM (SELECT day, instrument_id, count(*) FILTER (WHERE ins) AS n "
            "FROM chunk GROUP BY 1, 2) GROUP BY day"
        ).fetchall()
    )
    return sorted(
        (
            quality.DayStats(
                asset=asset,
                name=name,
                day=day,
                n_rows=n_rows,
                contracts=contracts,
                expiries=expiries if asset == "option" else None,
                max_bars=bars[day] or 0,
                off_session_rows=off_rows,
                first_ts=quality._from_epoch(first),
                last_ts=quality._from_epoch(last),
                source="vendor",
            )
            for day, n_rows, contracts, expiries, off_rows, first, last in head
        ),
        key=lambda s: s.day,
    )


def _written_by_collector(path: Path) -> bool:
    """The Fyers collector's files carry Fyers symbols (`NSE:…`) in vendor_symbol."""
    first = pq.ParquetFile(path).read_row_group(0, columns=["vendor_symbol"])
    return bool(first.num_rows) and quality.infer_source(first.column(0)[0].as_py()) == "fyers"


def _write_days(
    con: duckdb.DuckDBPyConnection,
    root: Path,
    asset: str,
    name: str,
    stats: list[quality.DayStats],
    *,
    force: bool,
) -> tuple[list[quality.DayStats], int]:
    """Write one lake file per day of `chunk`. Returns (stats of files written, number of
    days skipped because a file existed)."""
    schema = lake.OPT_SCHEMA if asset == "option" else lake.BAR_SCHEMA
    columns = OPTION_COLUMNS if asset == "option" else BAR_COLUMNS
    written, skipped = [], 0
    for s in stats:
        path = lake.bars_1m_path(root, asset, name, s.day)
        if path.exists() and (not force or _written_by_collector(path)):
            skipped += 1
            continue
        table = _arrow(
            con.execute(
                f"SELECT {columns} FROM chunk WHERE day = ? ORDER BY instrument_id, ts", [s.day]
            )
        )
        lake.write_parquet(table.select(schema.names).cast(schema), path)
        written.append(s)
    return written, skipped


def _holidays(root: Path) -> set[date]:
    with _connect(root, read_only=True) as con:
        return {r[0] for r in con.execute("SELECT date FROM ref_holidays").fetchall()}


def _chunk_done(root: Path, scope: str) -> bool:
    """A chunk is done once a run finished — `partial` means it finished with issues (rows
    dropped, duplicates) that were recorded, not that it should be redone. A crashed run is
    `running`/`failed` and is retried."""
    with _connect(root, read_only=True) as con:
        return bool(
            con.execute(
                "SELECT 1 FROM ingest_runs WHERE source = 'vendor' AND dataset = 'bars_1m' "
                "AND scope = ? AND status IN ('ok', 'partial') LIMIT 1",
                [scope],
            ).fetchone()
        )


def _fail_stale_runs(root: Path, prefix: str) -> None:
    """A crashed import leaves `running` rows; mark them so they are not mistaken for live."""
    with _connect(root) as con:
        con.execute(
            "UPDATE ingest_runs SET status = 'failed', finished_at = now() "
            "WHERE source = 'vendor' AND status = 'running' AND starts_with(scope, ?)",
            [prefix],
        )


def _record_chunk(
    root: Path,
    scope: str,
    written: list[quality.DayStats],
    holidays: set[date],
    *,
    requests: int,
    rows_in: int,
    unparsed: int,
    skipped: int,
    details: dict,
    issues: list[tuple[str, str, date | None]],
) -> None:
    with _connect(root) as con:
        run_id = ingest.start_run(con, "vendor", "bars_1m", None, scope)
        quality.upsert(con, written, holidays, run_id)
        for check, detail, day in issues:
            ingest.add_issue(con, run_id, check, detail, day=day)
        ingest.finish_run(
            con,
            run_id,
            requests=requests,
            rows_written=sum(s.n_rows for s in written),
            errors=len(issues),
            details={
                "rows_in": rows_in,
                "rows_unparsed": unparsed,
                "days_written": len(written),
                "days_skipped_existing": skipped,
                **details,
            },
        )


# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------


def _register_unit(
    root: Path, con: duckdb.DuckDBPyConnection, unit: Unit
) -> tuple[str, dict[str, int]]:
    """Register every contract of the unit; returns (underlying symbol, {contract: id})."""
    files = [str(f) for f in unit.files]
    symbols = [
        r[0]
        for r in con.execute(
            "SELECT DISTINCT underlying FROM read_parquet(?) WHERE underlying <> ''", [files]
        ).fetchall()
    ]
    if len(symbols) != 1:
        raise VendorError(f"{unit.section}/{unit.folder}: expected one underlying, got {symbols}")
    symbol = symbols[0]
    exchange = exchange_for(symbol)
    underlying_key = instrument_key(exchange, unit.asset_class, symbol)
    contracts = con.execute(
        "SELECT DISTINCT contract, expiry, strike, option_type FROM read_parquet(?) "
        "WHERE expiry IS NOT NULL AND strike IS NOT NULL AND option_type IN ('CE', 'PE')",
        [files],
    ).fetchall()
    specs = [
        InstrumentSpec(
            "option",
            exchange,
            symbol,
            expiry=expiry,
            strike=strike,
            option_type=option_type,
            underlying_key=underlying_key,
            vendor=VENDOR,
            vendor_symbol=contract,
        )
        for contract, expiry, strike, option_type in contracts
    ]
    distinct_contracts = {(s.expiry, s.strike, s.option_type) for s in specs}
    if len({s.key for s in specs}) != len(distinct_contracts):
        raise VendorError(
            f"{symbol}: instrument keys collide ('{{:g}}' strike formatting) — nothing written"
        )
    with _connect(root) as catalog:
        ids = register(catalog, specs)
    return symbol, {s.vendor_symbol: ids[s.key] for s in specs}


def import_unit(
    root: Path,
    unit: Unit,
    *,
    days: tuple[date, date] | None = None,
    force: bool = False,
    log: Callable[[str], None] = print,
) -> UnitReport:
    """Import one underlying's options (all its staged expiry files) into the lake."""
    window = days or (date.min, date.max)
    con, tmp = _open_duck()
    try:
        symbol, ids = _register_unit(root, con, unit)
        report = UnitReport(symbol)
        con.register(
            "ids",
            pa.table(
                {
                    "contract": pa.array(list(ids), pa.string()),
                    "instrument_id": pa.array(list(ids.values()), pa.int64()),
                }
            ),
        )
        files = [str(f) for f in unit.files]
        monthly = con.execute(
            "SELECT CAST(date_trunc('month', ts AT TIME ZONE 'Asia/Kolkata') AS DATE), count(*) "
            "FROM read_parquet(?) GROUP BY 1",
            [files],
        ).fetchall()
        holidays = _holidays(root)
        _fail_stale_runs(root, f"{symbol} ")
        for lo, hi in plan_chunks(monthly, window):
            scope = f"{symbol} {lo}..{hi - timedelta(days=1)}"
            if not force and _chunk_done(root, scope):
                report.chunks_skipped += 1
                continue
            started = time.monotonic()
            con.execute(
                f"""
                CREATE OR REPLACE TEMP TABLE chunk AS
                SELECT i.instrument_id, s.ts, s.open, s.high, s.low, s.close,
                       CAST(s.volume AS DOUBLE) AS volume, s.oi, s.expiry, s.strike,
                       s.option_type, s.contract AS vendor_symbol,
                       CAST(s.ts AT TIME ZONE 'Asia/Kolkata' AS DATE) AS day,
                       {quality.IN_SESSION_SQL} AS ins
                FROM read_parquet(?) s JOIN ids i ON s.contract = i.contract
                WHERE s.ts >= CAST(? AS TIMESTAMPTZ) AND s.ts < CAST(? AS TIMESTAMPTZ)
                ORDER BY day, instrument_id, ts
                """,
                [files, _ts_param(lo), _ts_param(hi)],
            )
            rows_in = con.execute(
                "SELECT count(*) FROM read_parquet(?) "
                "WHERE ts >= CAST(? AS TIMESTAMPTZ) AND ts < CAST(? AS TIMESTAMPTZ)",
                [files, _ts_param(lo), _ts_param(hi)],
            ).fetchone()[0]
            rows_chunk = con.execute("SELECT count(*) FROM chunk").fetchone()[0]
            issues = []
            unparsed = rows_in - rows_chunk
            if unparsed:
                issues.append(("unparsed_contract", f"{unparsed} rows dropped, {scope}", None))
            dups = con.execute(
                "SELECT count(*) - count(DISTINCT (instrument_id, ts)) FROM chunk"
            ).fetchone()[0]
            if dups:
                issues.append(("duplicate_rows", f"{dups} repeated (contract, ts), {scope}", None))
                con.execute(
                    "CREATE OR REPLACE TEMP TABLE chunk AS SELECT * EXCLUDE (rn) FROM ("
                    "SELECT *, row_number() OVER (PARTITION BY instrument_id, ts) AS rn "
                    "FROM chunk) WHERE rn = 1 ORDER BY day, instrument_id, ts"
                )
            stats = _day_stats(con, "option", symbol)
            written, skipped = _write_days(con, root, "option", symbol, stats, force=force)
            _record_chunk(
                root,
                scope,
                written,
                holidays,
                requests=len(unit.files),
                rows_in=rows_in,
                unparsed=unparsed,
                skipped=skipped,
                details={"duplicates_removed": dups, "chunk": [str(lo), str(hi)]},
                issues=issues,
            )
            report.chunks_run += 1
            report.days_written += len(written)
            report.days_skipped_existing += skipped
            report.rows_written += sum(s.n_rows for s in written)
            report.rows_unparsed += unparsed
            for s in written:
                v, reason = quality.verdict(s)
                if v == "excluded":
                    key = (reason or "").split(":")[0]
                    report.excluded[key] = report.excluded.get(key, 0) + 1
            log(
                f"{scope}: {len(written)} days written, {skipped} existing, "
                f"{sum(s.n_rows for s in written):,} rows ({time.monotonic() - started:.0f}s)"
            )
        with _connect(root) as catalog:
            quality.cross_check(catalog, [symbol])
        return report
    finally:
        con.close()
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------------------
# Index spot / India VIX CSVs
# ---------------------------------------------------------------------------


def import_index_csv(
    root: Path,
    csv: Path,
    symbol: str,
    *,
    days: tuple[date, date] | None = None,
    force: bool = False,
    log: Callable[[str], None] = print,
) -> UnitReport:
    """Import a `Date,Open,High,Low,Close,Volume` 1-minute CSV (ISO timestamps with +0530)
    as `asset=index/symbol=<SYMBOL>`. The csv's stem is the vendor symbol; oi is empty."""
    symbol = symbol.upper()
    window = days or (date.min, date.max)
    exchange = exchange_for(symbol)
    with _connect(root) as catalog:
        key = instrument_key(exchange, "index", symbol)
        ids = register(
            catalog,
            [InstrumentSpec("index", exchange, symbol, vendor=VENDOR, vendor_symbol=csv.stem)],
        )
        instrument_id = ids[key]
    con, tmp = _open_duck()
    try:
        con.execute(
            """
            CREATE TEMP TABLE raw AS
            SELECT strptime("Date", '%Y-%m-%dT%H:%M:%S%z') AS ts, "Open" AS open, "High" AS high,
                   "Low" AS low, "Close" AS close, "Volume" AS volume
            FROM read_csv(?, header = true, columns = {'Date': 'VARCHAR', 'Open': 'DOUBLE',
                'High': 'DOUBLE', 'Low': 'DOUBLE', 'Close': 'DOUBLE', 'Volume': 'DOUBLE'})
            """,
            [str(csv)],
        )
        report = UnitReport(symbol)
        holidays = _holidays(root)
        _fail_stale_runs(root, f"{symbol} {csv.name}")
        years = con.execute(
            "SELECT DISTINCT year(ts AT TIME ZONE 'Asia/Kolkata') FROM raw ORDER BY 1"
        ).fetchall()
        for (year,) in years:
            lo, hi = max(date(year, 1, 1), window[0]), min(date(year + 1, 1, 1), _after(window[1]))
            if lo >= hi:
                continue
            scope = f"{symbol} {csv.name} {lo}..{hi - timedelta(days=1)}"
            if not force and _chunk_done(root, scope):
                report.chunks_skipped += 1
                continue
            con.execute(
                f"""
                CREATE OR REPLACE TEMP TABLE chunk AS
                SELECT {instrument_id}::BIGINT AS instrument_id, ts, open, high, low, close,
                       volume, CAST(NULL AS DOUBLE) AS oi, '{csv.stem}' AS vendor_symbol,
                       CAST(NULL AS DATE) AS expiry,
                       CAST(ts AT TIME ZONE 'Asia/Kolkata' AS DATE) AS day,
                       {quality.IN_SESSION_SQL} AS ins
                FROM raw
                WHERE ts >= CAST(? AS TIMESTAMPTZ) AND ts < CAST(? AS TIMESTAMPTZ)
                ORDER BY day, ts
                """,
                [_ts_param(lo), _ts_param(hi)],
            )
            dups = con.execute("SELECT count(*) - count(DISTINCT ts) FROM chunk").fetchone()[0]
            issues = []
            if dups:
                issues.append(("duplicate_rows", f"{dups} repeated ts, {scope}", None))
                con.execute(
                    "CREATE OR REPLACE TEMP TABLE chunk AS SELECT * EXCLUDE (rn) FROM ("
                    "SELECT *, row_number() OVER (PARTITION BY ts) AS rn FROM chunk) "
                    "WHERE rn = 1 ORDER BY day, ts"
                )
            stats = _day_stats(con, "index", symbol)
            written, skipped = _write_days(con, root, "index", symbol, stats, force=force)
            rows_in = con.execute("SELECT count(*) FROM chunk").fetchone()[0]
            _record_chunk(
                root,
                scope,
                written,
                holidays,
                requests=1,
                rows_in=rows_in,
                unparsed=0,
                skipped=skipped,
                details={"csv": csv.name, "duplicates_removed": dups},
                issues=issues,
            )
            report.chunks_run += 1
            report.days_written += len(written)
            report.days_skipped_existing += skipped
            report.rows_written += sum(s.n_rows for s in written)
            log(f"{scope}: {len(written)} days written, {skipped} existing")
        with _connect(root) as catalog:
            quality.cross_check(catalog, [symbol])
        return report
    finally:
        con.close()
        shutil.rmtree(tmp, ignore_errors=True)


def _after(d: date) -> date:
    return d if d == date.max else d + timedelta(days=1)
