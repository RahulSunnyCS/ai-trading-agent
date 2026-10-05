"""A copy of the research database with nothing after a cut date (BL-010 Phase 2 step 4).

Running a backtest on this copy, and on the full database stopped at the same date, must give
the same orders and the same equity curve. Anything else means a later price reached an
earlier decision.

Rows are dropped by date from every dated table and from the daily bars. Tables with no date
(instrument names, company identities) are copied whole. What this cannot remove is hindsight
stored without a date: today's index list recorded against every year, and category tags.
"""

from __future__ import annotations

import shutil
from datetime import date
from pathlib import Path

import duckdb

#: table -> the column its rows are dated by.
DATED = {
    "momentum_prices": "date",
    "momentum_signals": "week",
    "stock_weekly_prices": "week",
    "stock_weekly_series": "week",
    "stock_membership_weekly": "week",
    "stock_action_candidates": "ex_date",
    "stock_action_reviews": "ex_date",
    "corporate_actions": "ex_date",
}


def truncated_root(source: Path, target: Path, cut: date) -> Path:
    """Write `target` as `source` would have looked at the close of `cut`."""
    target.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source / "catalog.duckdb", target / "catalog.duckdb")
    con = duckdb.connect(str(target / "catalog.duckdb"))
    try:
        tables = {
            row[0]: {c[0] for c in con.execute(f"DESCRIBE {row[0]}").fetchall()}
            for row in con.execute(
                "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'"
            ).fetchall()
        }
        for table, column in DATED.items():
            if column in tables.get(table, ()):
                con.execute(f"DELETE FROM {table} WHERE {column} > ?", [cut])
        if "year" in tables.get("category_membership", ()):
            con.execute("DELETE FROM category_membership WHERE year > ?", [cut.year])
        con.execute("CHECKPOINT")
    finally:
        con.close()
    for bars in sorted((source / "lake" / "bars_1d" / "asset=stock").glob("year=*/data.parquet")):
        year = int(bars.parent.name.removeprefix("year="))
        if year > cut.year:
            continue
        out = target / "lake" / "bars_1d" / "asset=stock" / bars.parent.name / "data.parquet"
        out.parent.mkdir(parents=True, exist_ok=True)
        if year < cut.year:
            shutil.copy2(bars, out)
            continue
        duckdb.sql(
            f"COPY (SELECT * FROM read_parquet('{bars.as_posix()}') WHERE date <= DATE '{cut}') "
            f"TO '{out.as_posix()}' (FORMAT parquet, COMPRESSION zstd)"
        )
    return target


def same_result(whole: dict, truncated: dict, tolerance: float = 1e-9) -> list[str]:
    """Where two bundles of the same run differ in what was traded or what it was worth.
    Fill prices are not compared: they sit on today's share count, which a later split moves."""
    found = []
    if whole["weeks"] != truncated["weeks"]:
        found.append(f"weeks: {len(whole['weeks'])} against {len(truncated['weeks'])}")
    a, b = whole["orders"], truncated["orders"]
    if len(a) != len(b):
        found.append(f"orders: {len(a)} against {len(b)}")
    for i, (x, y) in enumerate(zip(a, b, strict=False)):
        same = (x["week"], x["action"], x["asset"]) == (y["week"], y["action"], y["asset"])
        if not same or abs(x["value"] - y["value"]) > tolerance * max(abs(x["value"]), 1e-12):
            found.append(f"order {i}: {x} against {y}")
            break
    for week, x, y in zip(
        whole["weeks"], whole["claims"]["equity"], truncated["claims"]["equity"], strict=False
    ):
        if abs(x / y - 1) > tolerance:
            found.append(f"equity on {week}: {x!r} against {y!r}")
            break
    return found
