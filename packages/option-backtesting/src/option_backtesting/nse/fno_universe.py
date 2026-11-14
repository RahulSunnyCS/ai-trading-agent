"""The point-in-time F&O stock list, lot sizes and ban days, derived from the stored daily F&O
bhavcopy (BL-226 Phase 1).

- **Members:** a stock is on the F&O list on day D when its stock futures (FUTSTK) are in D's file.
  Stored as one row per (date, symbol), plus spells (symbol, first, last day of each unbroken run).
- **Lot size per (symbol, expiry, day):** the UDiFF file states it (`NewBrdLotQty`). The old file
  does not, so it is derived: open interest and its change are whole lots, so the greatest common
  divisor of every OI and OI change of that symbol and expiry on that day (futures and options
  together) is the lot (or, when every position happens to be an even number of lots, a multiple of
  it). A second estimate, futures value / contracts / close, is kept beside it; `lot_check` says
  whether they agree.
  Run on UDiFF days too, the derivation is compared with the stated lot (`compare_derived_lots`).
- **Bans:** one row per (date, symbol) from the day's ban-list file.

Written to `lake/eod/fno_universe/{members,spells,lots,bans}.parquet`; rebuilt in full each time
(seconds over the whole history through DuckDB).
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from .fo_bhavcopy import lake_days, lake_path, read_bans


def universe_dir(root: Path) -> Path:
    return root / "lake" / "eod" / "fno_universe"


def _glob(root: Path) -> str:
    return str(root / "lake" / "eod" / "fo_bhavcopy" / "date=*" / "data.parquet")


def _con() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    con.execute("SET TimeZone='Asia/Kolkata'")
    return con


def members(con: duckdb.DuckDBPyConnection, root: Path) -> pa.Table:
    return con.execute(
        f"""SELECT DISTINCT date, symbol FROM read_parquet('{_glob(root)}')
            WHERE instrument = 'FUTSTK' ORDER BY date, symbol"""
    ).to_arrow_table()


def spells(con: duckdb.DuckDBPyConnection, member_table: pa.Table) -> pa.Table:
    """Unbroken runs of membership: a gap of one or more sessions (on the file's own session list)
    ends a spell."""
    con.register("m", member_table)
    return con.execute(
        """WITH s AS (SELECT DISTINCT date FROM m),
                n AS (SELECT date, row_number() OVER (ORDER BY date) AS k FROM s),
                j AS (SELECT m.symbol, m.date, n.k,
                             n.k - row_number() OVER (PARTITION BY m.symbol ORDER BY m.date) AS grp
                      FROM m JOIN n USING (date))
           SELECT symbol, min(date) AS first_day, max(date) AS last_day, count(*) AS sessions
           FROM j GROUP BY symbol, grp ORDER BY symbol, first_day"""
    ).to_arrow_table()


def lots(con: duckdb.DuckDBPyConnection, root: Path) -> pa.Table:
    return con.execute(
        f"""WITH r AS (
              SELECT date, symbol, expiry, instrument, oi, chg_oi, contracts, value_rs, close,
                     lot_size, source_format
              FROM read_parquet('{_glob(root)}')
              WHERE instrument IN ('FUTSTK', 'OPTSTK')),
            g0 AS (
              SELECT date, symbol, expiry,
                     any_value(source_format) AS source_format,
                     max(lot_size) AS stated,
                     min(lot_size) AS stated_min,
                     list_filter(list(abs(oi)) || list(abs(chg_oi)),
                                 x -> x IS NOT NULL AND x > 0) AS pos,
                     max(CASE WHEN instrument = 'FUTSTK' AND contracts > 0
                              THEN value_rs / contracts / close END) AS value_estimate
              FROM r GROUP BY date, symbol, expiry),
            g AS (
              SELECT * EXCLUDE (pos),
                     CASE WHEN len(pos) = 0 THEN NULL
                          ELSE list_reduce(pos, (a, b) -> gcd(a, b)) END AS derived
              FROM g0)
           SELECT date, symbol, expiry, source_format,
                  coalesce(stated, derived) AS lot_size,
                  stated, stated_min, derived, value_estimate,
                  CASE WHEN derived IS NULL OR value_estimate IS NULL THEN 'unchecked'
                       WHEN abs(value_estimate / derived - 1) <= 0.05 THEN 'agree'
                       ELSE 'differ' END AS lot_check
           FROM g ORDER BY date, symbol, expiry"""
    ).to_arrow_table()


def bans(root: Path) -> pa.Table:
    rows: dict[str, list] = {"date": [], "symbol": []}
    missing = []
    for day in lake_days(root):
        names = read_bans(root, day)
        if names is None:
            missing.append(day)
            continue
        for s in names:
            rows["date"].append(day)
            rows["symbol"].append(s)
    table = pa.table(rows, schema=pa.schema([("date", pa.date32()), ("symbol", pa.string())]))
    return table.replace_schema_metadata({"days_without_file": ",".join(map(str, missing))})


def build(root: Path) -> dict:
    con = _con()
    out = universe_dir(root)
    out.mkdir(parents=True, exist_ok=True)
    m = members(con, root)
    tables = {"members": m, "spells": spells(con, m), "lots": lots(con, root), "bans": bans(root)}
    for name, t in tables.items():
        tmp = out / f".{name}.parquet.tmp"
        pq.write_table(t, tmp, compression="zstd")
        tmp.replace(out / f"{name}.parquet")
    return {name: t.num_rows for name, t in tables.items()}


def members_on(root: Path, day: date) -> set[str]:
    """The F&O stock list on one session (empty when the session is not stored)."""
    if not lake_path(root, day).exists():
        return set()
    t = pq.read_table(lake_path(root, day), columns=["instrument", "symbol"])
    return {
        s
        for s, i in zip(t["symbol"].to_pylist(), t["instrument"].to_pylist(), strict=True)
        if i == "FUTSTK"
    }


def compare_derived_lots(root: Path) -> dict:
    """On UDiFF days, how often the derived lot equals the stated one (the check on the old-format
    derivation)."""
    t = pq.read_table(universe_dir(root) / "lots.parquet")
    con = _con()
    con.register("l", t)
    row = con.execute(
        """SELECT count(*) AS n,
                  count(*) FILTER (WHERE derived = stated) AS equal,
                  count(*) FILTER (WHERE derived % stated = 0 AND derived <> stated) AS multiple,
                  count(*) FILTER (WHERE derived IS NULL) AS no_oi,
                  count(*) FILTER (WHERE stated <> stated_min) AS mixed_stated
           FROM l WHERE source_format = 'udiff'"""
    ).fetchone()
    return dict(zip(("n", "equal", "multiple", "no_oi", "mixed_stated"), row, strict=True))


def report(root: Path) -> dict:
    d = universe_dir(root)
    con = _con()
    for name in ("members", "spells", "lots", "bans"):
        con.register(name, pq.read_table(d / f"{name}.parquet"))
    by_month = con.execute(
        """SELECT strftime(date, '%Y-%m') AS month, count(DISTINCT symbol) AS stocks
           FROM members GROUP BY 1 ORDER BY 1"""
    ).fetchall()
    first, last = con.execute("SELECT min(date), max(date) FROM members").fetchone()
    events = con.execute(
        f"""SELECT 'entry' AS kind, symbol, first_day AS day FROM spells
            WHERE first_day > DATE '{first}'
            UNION ALL
            SELECT 'exit', symbol, last_day FROM spells WHERE last_day < DATE '{last}'
            ORDER BY day, kind, symbol"""
    ).fetchall()
    lot_checks = dict(
        con.execute(
            "SELECT lot_check, count(*) FROM lots WHERE source_format = 'old' GROUP BY 1"
        ).fetchall()
    )
    ban_days = con.execute("SELECT count(DISTINCT date), count(*) FROM bans").fetchone()
    return {
        "first_day": str(first),
        "last_day": str(last),
        "stocks_by_month": {m: n for m, n in by_month},
        "entries": [(s, str(dy)) for k, s, dy in events if k == "entry"],
        "exits": [(s, str(dy)) for k, s, dy in events if k == "exit"],
        "old_format_lot_checks": lot_checks,
        "udiff_lot_derivation": compare_derived_lots(root),
        "ban_days": ban_days[0],
        "ban_rows": ban_days[1],
    }
