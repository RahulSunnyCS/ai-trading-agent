"""
Local replacement for `store.py`'s Postgres (Neon) price/signal storage — writes into the
shared `trading_data` catalog instead, so the weekly job needs no `MOMENTUM_DATABASE_URL`
(TODO.md 3.11.5). Same three calls `weekly.py` makes against `store.py` (`push_dir`,
`save_signal`, `load_signal`), same argument order, so `run_weekly()` didn't need to change
its call sites — only which module it imports.

Price history reuses `db_migrate.import_momentum_prices` (a DELETE+INSERT wholesale replace
of `momentum_prices` from `data/`'s CSVs, already exercised by `mbt local migrate`) rather
than a new incremental upsert path — the table is small (~140K rows, per TODO 3.11.4), so a
full re-read after every weekly refresh is cheap and keeps exactly one writer of that table.
`since` is accepted only for call-site parity with `store.push_dir`; unused, since the
wholesale replace already re-reads everything.

`momentum_signals` didn't have a local writer before this — `002_momentum.sql` created the
table (D-4) but nothing populated it (D-5's job, this module). Delete-then-insert on the
same primary key `store.save_signal`'s Postgres upsert used, rather than relying on DuckDB's
`ON CONFLICT ... DO UPDATE` for a JSON column.
"""

from __future__ import annotations

import json
from pathlib import Path

import duckdb

from . import db_migrate
from .config import DATA_DIR


def push_dir(con: duckdb.DuckDBPyConnection, data_dir: Path = DATA_DIR, since=None) -> int:
    return db_migrate.import_momentum_prices(con, data_dir)


def pull_dir(con: duckdb.DuckDBPyConnection, data_dir: Path = DATA_DIR) -> int:
    """Rebuild `data_dir`'s CSVs from `momentum_prices` — the safety net `weekly()` falls
    back to if `data/` is missing (e.g. a fresh checkout on a new laptop). Reuses
    `store.write_dir`, the exact inverse of the `rows_from_dir` reader `push_dir` writes
    through — same file layout, so this and `push_dir` round-trip losslessly."""
    from . import store

    rows = con.execute("SELECT instrument, kind, date, open, close FROM momentum_prices").fetchall()
    store.write_dir(rows, data_dir)
    return len(rows)


def save_signal(
    con: duckdb.DuckDBPyConnection, week: str, run_kind: str, label: str, payload: dict
) -> None:
    con.execute(
        "DELETE FROM momentum_signals WHERE week = ? AND run_kind = ? AND config_label = ?",
        [week, run_kind, label],
    )
    con.execute(
        "INSERT INTO momentum_signals (week, run_kind, config_label, payload) VALUES (?, ?, ?, ?)",
        [week, run_kind, label, json.dumps(payload)],
    )


def load_signal(
    con: duckdb.DuckDBPyConnection, week: str, run_kind: str, label: str
) -> dict | None:
    row = con.execute(
        "SELECT payload FROM momentum_signals WHERE week = ? AND run_kind = ? AND config_label = ?",
        [week, run_kind, label],
    ).fetchone()
    return json.loads(row[0]) if row is not None else None
