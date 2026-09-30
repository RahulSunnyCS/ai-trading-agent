"""
DSL engine run history, in the shared trading-data catalog
(strategies / strategy_versions / backtest_runs — the same tables
`legwise/store.py` uses with `package='options_legwise'` and
`momentum_backtesting/runs_store.py` uses with `package='momentum'`).

Superseded 2026-09-30: this used to be a standalone `data/registry.sqlite`
(plain stdlib `sqlite3`). See `packages/trading-data/DECISIONS.md` for why —
`RunRecord`'s shape and `strategy_hash()` are unchanged, so every caller
(cli.py, api/routes.py, mcp/server.py) only had to swap a `Path` for a
`duckdb.DuckDBPyConnection`.

`strategies.strategy_id` is prefixed `dsl:` (`_strategy_key`) because that
column is a global primary key across every package sharing this catalog —
without a prefix, a DSL strategy id could collide with a legwise or momentum
one that happens to reuse the same string.

The DSL engine's Parquet bar cache (`data/cache/`, AlgoTest-sourced,
strike-rule-resolved) is a **separate, deliberately untouched** concern —
see `packages/trading-data/DECISIONS.md`'s entry on why only the run
registry moved, not the bar cache.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from dataclasses import dataclass
from datetime import date

import duckdb

from ..strategy.schema import StrategySpec
from .result import AggregateResult

PACKAGE = "options_dsl"


@dataclass(frozen=True)
class RunRecord:
    run_id: str
    strategy_id: str
    strategy_version: int
    strategy_hash: str
    # None only for rows written before this field existed (pre-M-5, sqlite era).
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


def _strategy_key(strategy_id: str) -> str:
    return f"dsl:{strategy_id}"


def _ensure_version(
    con: duckdb.DuckDBPyConnection, strategy: StrategySpec, strategy_yaml: str | None
) -> str:
    key = _strategy_key(strategy.id)
    h = strategy_hash(strategy)
    version_id = f"{key}:{h}"
    con.execute(
        "INSERT INTO strategies (strategy_id, package, name) VALUES (?, ?, ?) "
        "ON CONFLICT DO NOTHING",
        [key, PACKAGE, strategy.id],
    )
    spec = {
        "strategy": json.loads(strategy.model_dump_json()),
        "version": strategy.version,
        "yaml": strategy_yaml,
    }
    con.execute(
        "INSERT INTO strategy_versions (version_id, strategy_id, spec_hash, spec) "
        "VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
        [version_id, key, h, json.dumps(spec)],
    )
    return version_id


def record_run(
    con: duckdb.DuckDBPyConnection,
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
    version_id = _ensure_version(con, strategy, strategy_yaml)
    run_id = uuid.uuid4().hex[:12]
    summary = {
        "net_inr": result.net_inr,
        "win_days": result.win_days,
        "worst_day": result.worst_day,
        "sum_peak_loss": result.sum_peak_loss,
        "lot_days": result.lot_days,
        "inr_per_lot_day": result.inr_per_lot_day,
        "n_sessions": len(result.sessions),
    }
    con.execute(
        "INSERT INTO backtest_runs (run_id, version_id, kind, date_from, date_to, summary) "
        "VALUES (?, ?, 'dsl', ?, ?, ?)",
        [run_id, version_id, date_from, date_to, json.dumps(summary)],
    )
    return run_id


# CAST(created_at AS VARCHAR) rather than selecting the TIMESTAMPTZ column directly —
# DuckDB's python binding needs the optional `pytz` package to materialise a TIMESTAMPTZ
# value into a python object, which this package does not depend on. A text cast sidesteps
# that entirely; RunRecord.created_at is a string anyway (it was ISO text under sqlite too).
_SELECT = (
    "SELECT r.run_id, v.spec, v.spec_hash, r.summary, CAST(r.created_at AS VARCHAR), "
    "r.date_from, r.date_to "
    "FROM backtest_runs r JOIN strategy_versions v USING (version_id) WHERE r.kind = 'dsl'"
)


def _to_record(row: tuple) -> RunRecord:
    run_id, spec_json, spec_hash_value, summary_json, created_at, date_from, date_to = row
    spec = json.loads(spec_json)
    summary = json.loads(summary_json)
    return RunRecord(
        run_id=run_id,
        strategy_id=spec["strategy"]["id"],
        strategy_version=spec["version"],
        strategy_hash=spec_hash_value,
        strategy_yaml=spec["yaml"],
        date_from=date_from.isoformat(),
        date_to=date_to.isoformat(),
        created_at=str(created_at),
        net_inr=summary["net_inr"],
        win_days=summary["win_days"],
        worst_day=summary["worst_day"],
        sum_peak_loss=summary["sum_peak_loss"],
        lot_days=summary["lot_days"],
        inr_per_lot_day=summary["inr_per_lot_day"],
        n_sessions=summary["n_sessions"],
    )


def get_run(con: duckdb.DuckDBPyConnection, run_id: str) -> RunRecord | None:
    row = con.execute(f"{_SELECT} AND r.run_id = ?", [run_id]).fetchone()
    return _to_record(row) if row is not None else None


def list_runs(con: duckdb.DuckDBPyConnection, limit: int = 20) -> list[RunRecord]:
    rows = con.execute(f"{_SELECT} ORDER BY r.created_at DESC LIMIT ?", [limit]).fetchall()
    return [_to_record(row) for row in rows]
