"""
SQLite run registry — plain stdlib `sqlite3`, no new dependency (per the
plan: numpy was already needed for bootstrap_ci, sqlite3 needs nothing).
Each `obt run` records one row; `obt registry` lists past runs.
"""

from __future__ import annotations

import hashlib
import sqlite3
import uuid
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

from ..strategy.schema import StrategySpec
from .result import AggregateResult

DEFAULT_REGISTRY_DB = Path(__file__).parent.parent.parent.parent / "data" / "registry.sqlite"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY,
    strategy_id TEXT NOT NULL,
    strategy_version INTEGER NOT NULL,
    strategy_hash TEXT NOT NULL,
    strategy_yaml TEXT,
    date_from TEXT NOT NULL,
    date_to TEXT NOT NULL,
    created_at TEXT NOT NULL,
    net_inr REAL,
    win_days INTEGER,
    worst_day REAL,
    sum_peak_loss REAL,
    lot_days REAL,
    inr_per_lot_day REAL,
    n_sessions INTEGER
)
"""

_COLUMNS = (
    "run_id, strategy_id, strategy_version, strategy_hash, strategy_yaml, date_from, date_to, "
    "created_at, net_inr, win_days, worst_day, sum_peak_loss, lot_days, "
    "inr_per_lot_day, n_sessions"
)


@dataclass(frozen=True)
class RunRecord:
    run_id: str
    strategy_id: str
    strategy_version: int
    strategy_hash: str
    # None only for rows written before this column existed (pre-M-5).
    strategy_yaml: str | None
    date_from: str
    date_to: str
    created_at: str
    net_inr: float
    win_days: int
    worst_day: float
    sum_peak_loss: float
    lot_days: float
    inr_per_lot_day: float
    n_sessions: int


def strategy_hash(strategy: StrategySpec) -> str:
    """First 16 hex chars of a SHA-256 over the strategy's canonical JSON —
    changes whenever the strategy's fields change, independent of the
    `version` field the author controls by hand."""
    payload = strategy.model_dump_json().encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:16]


def _connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db_path)
    con.execute(_SCHEMA)
    _migrate(con)
    return con


def _migrate(con: sqlite3.Connection) -> None:
    """`CREATE TABLE IF NOT EXISTS` is a no-op against a pre-existing
    database from an earlier milestone — a column added since then (e.g.
    `strategy_yaml`, M-5) would silently never appear, and every INSERT/
    SELECT referencing it would fail with "no such column". Add any
    missing column by hand, once, idempotently."""
    existing = {row[1] for row in con.execute("PRAGMA table_info(runs)").fetchall()}
    if "strategy_yaml" not in existing:
        con.execute("ALTER TABLE runs ADD COLUMN strategy_yaml TEXT")
        con.commit()


def record_run(
    db_path: Path,
    strategy: StrategySpec,
    date_from: date,
    date_to: date,
    result: AggregateResult,
    strategy_yaml: str | None = None,
) -> str:
    """`strategy_yaml` (the original YAML text the strategy was loaded
    from) is stored alongside the headline metrics so a later
    `obt export-personality <run_id>` can reconstruct the exact strategy —
    the `strategy_hash` alone is only a fingerprint, not enough to rebuild
    the definition. Optional (defaults to None) so existing callers that
    don't have the source text handy keep working; a run recorded without
    it simply can't be exported later."""
    run_id = uuid.uuid4().hex[:12]
    con = _connect(db_path)
    try:
        con.execute(
            f"INSERT INTO runs ({_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                run_id,
                strategy.id,
                strategy.version,
                strategy_hash(strategy),
                strategy_yaml,
                date_from.isoformat(),
                date_to.isoformat(),
                datetime.now().isoformat(),
                result.net_inr,
                result.win_days,
                result.worst_day,
                result.sum_peak_loss,
                result.lot_days,
                result.inr_per_lot_day,
                len(result.sessions),
            ),
        )
        con.commit()
    finally:
        con.close()
    return run_id


def get_run(db_path: Path, run_id: str) -> RunRecord | None:
    if not db_path.exists():
        return None
    con = _connect(db_path)
    try:
        row = con.execute(f"SELECT {_COLUMNS} FROM runs WHERE run_id = ?", (run_id,)).fetchone()
    finally:
        con.close()
    return RunRecord(*row) if row is not None else None


def list_runs(db_path: Path, limit: int = 20) -> list[RunRecord]:
    if not db_path.exists():
        return []
    con = _connect(db_path)
    try:
        rows = con.execute(
            f"SELECT {_COLUMNS} FROM runs ORDER BY created_at DESC LIMIT ?", (limit,)
        ).fetchall()
    finally:
        con.close()
    return [RunRecord(*row) for row in rows]
