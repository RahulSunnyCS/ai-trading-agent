"""
Judging every lake partition: is this (asset, name, day) usable for a backtest?

`data_quality` has one row per bars_1m file. Rows are written by the importers as they
write files and regenerated from the files by `rebuild`, so the table can always be
rebuilt. Nothing is dropped from the lake on a bad verdict — the label says why a day is
excluded, and readers decide.

A day is described by the instrument with the most bars in the regular session
(09:15 up to 15:30, bar start, IST): 375 on a full day. Fyers files also keep the 15:30-15:39
closing bars and some vendor days have rows after hours (Muhurat evenings); those count as
`off_session_rows`, never as bars.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import duckdb
import pyarrow as pa

from . import lake
from .db import connect

#: Fewer than this many bars on the busiest instrument and the day is not a trading day
#: worth backtesting (an NSE disaster-recovery drill, an afternoon Muhurat session).
#: Same meaning as `fyers/history.py` always had.
MIN_BARS = 300
FULL_DAY_BARS = 375
#: An option day with fewer contracts than this is not a chain.
MIN_CONTRACTS = 10

#: Bar-start times of the regular session, IST: 09:15:00 up to but not including 15:30:00.
#: Half-open on purpose — a bar stamped 15:29:30 belongs to minute 15:29, as in legwise's grid.
_IST_TIME = "CAST(ts AT TIME ZONE 'Asia/Kolkata' AS TIME)"
IN_SESSION_SQL = f"({_IST_TIME} >= TIME '09:15' AND {_IST_TIME} < TIME '15:30')"

IST = ZoneInfo("Asia/Kolkata")
ASSETS = ("option", "future", "index")


@dataclass(frozen=True)
class DayStats:
    asset: str
    name: str
    day: date
    n_rows: int
    contracts: int
    expiries: int | None
    max_bars: int
    off_session_rows: int
    first_ts: datetime | None
    last_ts: datetime | None
    source: str = "vendor"


def verdict(stats: DayStats) -> tuple[str, str | None]:
    """(verdict, reason) for one partition. The first failing rule names the reason."""
    if stats.max_bars == 0:
        return "excluded", "off_session_only"
    if stats.max_bars < MIN_BARS:
        return "excluded", f"short_session:{stats.max_bars}"
    if stats.asset == "option" and stats.contracts < MIN_CONTRACTS:
        return "excluded", f"thin_chain:{stats.contracts}"
    if stats.max_bars > FULL_DAY_BARS:
        return "excluded", f"duplicate_bars:{stats.max_bars}"
    return "usable", None


def session_kind(stats: DayStats, holidays: set[date]) -> str:
    """`special` for a session on a weekend or an exchange holiday (Budget Saturdays,
    DR drills, Muhurat), `off_session` when nothing traded in the regular hours."""
    if stats.max_bars == 0:
        return "off_session"
    if stats.day.weekday() >= 5 or stats.day in holidays:
        return "special"
    return "regular"


def infer_source(vendor_symbol: str | None) -> str:
    """Fyers symbols look like `NSE:NIFTY26OCT22700CE`; the vendor's are bare contract
    names (`NIFTY_22700_CE_06_OCT_26`) or csv stems."""
    return "fyers" if vendor_symbol and vendor_symbol.startswith(("NSE:", "BSE:")) else "vendor"


def parse_days(spec: str) -> tuple[date, date]:
    """`2024-10-01..2026-09-17` -> (date, date); either side may be left empty."""
    lo, sep, hi = spec.partition("..")
    if not sep:
        raise ValueError(f"expected A..B, got {spec!r}")
    return (
        date.fromisoformat(lo) if lo else date.min,
        date.fromisoformat(hi) if hi else date.max,
    )


_DAY_FROM_PATH = re.compile(r"date=(\d{4}-\d{2}-\d{2})/data\.parquet$")

# One scan per (asset, name): aggregate each (file, instrument) once — an instrument has one
# expiry, so any_value is exact — then roll that small intermediate up per file.
_STATS_SQL = f"""
WITH per AS (
    SELECT filename, instrument_id,
           count(*) AS n,
           count(*) FILTER (WHERE {IN_SESSION_SQL}) AS bars,
           min(ts) AS first_ts, max(ts) AS last_ts,
           any_value({{expiry}}) AS expiry, any_value(vendor_symbol) AS vendor_symbol
    FROM read_parquet(?, filename = true)
    GROUP BY 1, 2
)
SELECT filename,
       sum(n) AS n_rows,
       count(*) AS contracts,
       count(DISTINCT expiry) AS expiries,
       max(bars) AS max_bars,
       sum(n - bars) AS off_rows,
       epoch(min(first_ts)) AS first_epoch,   -- epoch, not TIMESTAMPTZ: fetching one needs pytz
       epoch(max(last_ts)) AS last_epoch,
       any_value(vendor_symbol) AS vendor_symbol
FROM per
GROUP BY filename
"""


def _from_epoch(value: float | None) -> datetime | None:
    return None if value is None else datetime.fromtimestamp(value, IST)


def file_stats(asset: str, name: str, files: list[Path]) -> list[DayStats]:
    """Stats for every file of one (asset, name) in a single parallel scan."""
    if not files:
        return []
    expiry = "expiry" if asset == "option" else "CAST(NULL AS DATE)"
    sql = _STATS_SQL.format(expiry=expiry)
    con = duckdb.connect()
    try:
        rows = con.execute(sql, [[str(f) for f in files]]).fetchall()
    finally:
        con.close()
    out = []
    for filename, n_rows, contracts, expiries, max_bars, off_rows, first, last, vsym in rows:
        first, last = _from_epoch(first), _from_epoch(last)
        match = _DAY_FROM_PATH.search(filename)
        if match is None:
            raise ValueError(f"not a lake partition path: {filename}")
        out.append(
            DayStats(
                asset=asset,
                name=name,
                day=date.fromisoformat(match.group(1)),
                n_rows=n_rows,
                contracts=contracts,
                expiries=expiries if asset == "option" else None,
                max_bars=max_bars or 0,
                off_session_rows=off_rows,
                first_ts=first,
                last_ts=last,
                source=infer_source(vsym),
            )
        )
    return sorted(out, key=lambda s: s.day)


def upsert(
    con: duckdb.DuckDBPyConnection,
    stats: list[DayStats],
    holidays: set[date],
    run_id: str | None = None,
) -> None:
    """Insert or replace one row per partition (bulk)."""
    if not stats:
        return
    records = []
    for s in stats:
        v, reason = verdict(s)
        records.append(
            {
                "asset": s.asset,
                "name": s.name,
                "trading_day": s.day,
                "source": s.source,
                "verdict": v,
                "reason": reason,
                "session_kind": session_kind(s, holidays),
                "n_rows": s.n_rows,
                "contracts": s.contracts,
                "expiries": s.expiries,
                "max_bars": s.max_bars,
                "off_session_rows": s.off_session_rows,
                "first_ts": s.first_ts,
                "last_ts": s.last_ts,
                "run_id": run_id,
            }
        )
    schema = pa.schema(
        [
            ("asset", pa.string()),
            ("name", pa.string()),
            ("trading_day", pa.date32()),
            ("source", pa.string()),
            ("verdict", pa.string()),
            ("reason", pa.string()),
            ("session_kind", pa.string()),
            ("n_rows", pa.int64()),
            ("contracts", pa.int32()),
            ("expiries", pa.int32()),
            ("max_bars", pa.int32()),
            ("off_session_rows", pa.int64()),
            ("first_ts", pa.timestamp("us", tz="Asia/Kolkata")),
            ("last_ts", pa.timestamp("us", tz="Asia/Kolkata")),
            ("run_id", pa.string()),
        ]
    )
    con.register("_dq", pa.Table.from_pylist(records, schema=schema))
    try:
        con.execute(
            "INSERT OR REPLACE INTO data_quality (asset, name, trading_day, source, verdict, "
            "reason, session_kind, n_rows, contracts, expiries, max_bars, off_session_rows, "
            "first_ts, last_ts, run_id) "
            "SELECT asset, name, trading_day, source, verdict, reason, session_kind, n_rows, "
            "contracts, expiries, max_bars, off_session_rows, first_ts, last_ts, run_id FROM _dq"
        )
    finally:
        con.unregister("_dq")


def prune(
    con: duckdb.DuckDBPyConnection,
    asset: str,
    name: str,
    window: tuple[date, date],
    keep: set[date],
) -> int:
    """Delete verdicts of days in `window` that no longer have a lake file, so the table
    keeps mirroring the files after a partition is removed. Returns the rows deleted."""
    con.register("_keep", pa.table({"d": pa.array(sorted(keep), pa.date32())}))
    try:
        return con.execute(
            "DELETE FROM data_quality WHERE asset = ? AND name = ? "
            "AND trading_day BETWEEN ? AND ? AND trading_day NOT IN (SELECT d FROM _keep)",
            [asset, name, *window],
        ).fetchone()[0]
    finally:
        con.unregister("_keep")


def cross_check(con: duckdb.DuckDBPyConnection, names: list[str] | None = None) -> int:
    """An option day whose underlying has index data in the lake, but none usable for that
    day, cannot be backtested (strikes are picked from spot): label it `no_spot`. Clears
    the label when the spot day arrives, so import order does not matter. Underlyings with
    no index data at all (the stocks) are left alone — they never have a spot series.
    Returns the number of rows changed. `names=None` checks every underlying; an empty list
    checks none."""
    if names is not None and not names:
        return 0
    flt = "" if names is None else f" AND o.name IN ({','.join('?' for _ in names)})"
    args = list(names or [])
    usable_spot = (
        "EXISTS (SELECT 1 FROM data_quality i WHERE i.asset = 'index' AND i.name = o.name "
        "AND i.trading_day = o.trading_day AND i.verdict = 'usable')"
    )
    has_spot_series = (
        "EXISTS (SELECT 1 FROM data_quality i WHERE i.asset = 'index' AND i.name = o.name)"
    )
    marked = con.execute(
        "UPDATE data_quality o SET verdict = 'excluded', reason = 'no_spot' "
        f"WHERE o.asset = 'option' AND o.verdict = 'usable' AND {has_spot_series} "
        f"AND NOT {usable_spot}{flt}",
        args,
    ).fetchone()[0]
    cleared = con.execute(
        "UPDATE data_quality o SET verdict = 'usable', reason = NULL "
        f"WHERE o.asset = 'option' AND o.reason = 'no_spot' AND {usable_spot}{flt}",
        args,
    ).fetchone()[0]
    return marked + cleared


def rebuild(
    root: Path,
    *,
    asset: str | None = None,
    name: str | None = None,
    days: tuple[date, date] | None = None,
    log=print,
) -> dict[str, int]:
    """Re-judge partitions from the Parquet files. The scan runs outside the catalog
    connection; each (asset, name) is written in one short connect()."""
    with connect(root, read_only=True) as con:
        holidays = {r[0] for r in con.execute("SELECT date FROM ref_holidays").fetchall()}
    lo, hi = days or (date.min, date.max)
    judged: dict[str, int] = {}
    changed = pruned = 0
    for a in [asset] if asset else ASSETS:
        by_name: dict[str, list[Path]] = {}
        for n, day, path in lake.partitions(root, a):
            if (name is None or n == name) and lo <= day <= hi:
                by_name.setdefault(n, []).append(path)
        with connect(root, read_only=True, lock_wait=300) as con:
            known = {r[0] for r in con.execute(
                "SELECT DISTINCT name FROM data_quality WHERE asset = ?", [a]).fetchall()
            }  # fmt: skip
        # a name whose files are all gone still has rows to prune
        for n in sorted(set(by_name) | {k for k in known if name in (None, k)}):
            stats = file_stats(a, n, by_name.get(n, []))
            with connect(root, lock_wait=300) as con:
                upsert(con, stats, holidays)
                pruned += prune(con, a, n, (lo, hi), keep={s.day for s in stats})
                # per name, in the same connection: upsert resets every option day to usable,
                # so the no_spot labels must not stay wiped while later names are scanned
                changed += cross_check(con, [n])
            judged[f"{a}/{n}"] = len(stats)
            log(f"{a}/{n}: judged {len(stats)} days")
    judged["no_spot_changes"] = changed
    judged["rows_pruned"] = pruned
    return judged
