"""
Momentum's saved backtest runs, in the shared trading-data catalog
(strategies / strategy_versions / backtest_runs — the same tables
`option_backtesting/legwise/store.py` uses with `package='options_legwise'`).

A "strategy" here is just a grouping key: one per dataset (`momentum:etf`,
`momentum:stock`, ...), matching how the dashboard already scopes saved runs
per-dataset. A "version" is the run's config, hashed — re-running the exact
same settings reuses the version row, but each run still gets its own
`backtest_runs` row since two runs of the same config on different data
snapshots are not the same result.

Momentum runs are weekly equity curves, not day-by-day trades, so nothing is
written to `backtest_days`/`backtest_trades` — the whole record (name, kpis,
dates, strategy series, overlay flag) lives in `backtest_runs.summary`, which
is already documented as free-form JSON. This mirrors what used to be a
`localStorage` array of `MomentumSavedRun` objects, just moved server-side so
saved runs survive a browser/device change (see TODO.md's P4 entry).

Capped at 10 ordinary runs per dataset, oldest dropped first. Favourited runs
are retained separately from that disposable comparison history because the
weekly scheduler must be able to evaluate them even after many ad-hoc runs.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

import duckdb

PACKAGE = "momentum"
MAX_RUNS_PER_DATASET = 10


def _strategy_id(dataset: str) -> str:
    return f"momentum:{dataset}"


def spec_hash(config: dict[str, Any]) -> str:
    canonical = json.dumps(config, sort_keys=True, default=str)
    return hashlib.sha256(canonical.encode()).hexdigest()[:12]


def _ensure_version(con: duckdb.DuckDBPyConnection, dataset: str, config: dict[str, Any]) -> str:
    strategy_id = _strategy_id(dataset)
    h = spec_hash(config)
    version_id = f"{strategy_id}:{h}"
    con.execute(
        "INSERT INTO strategies (strategy_id, package, name) VALUES (?, ?, ?) "
        "ON CONFLICT DO NOTHING",
        [strategy_id, PACKAGE, strategy_id],
    )
    con.execute(
        "INSERT INTO strategy_versions (version_id, strategy_id, spec_hash, spec) "
        "VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
        [version_id, strategy_id, h, json.dumps(config, default=str)],
    )
    return version_id


def _next_n(con: duckdb.DuckDBPyConnection, dataset: str) -> int:
    row = con.execute(
        "SELECT max((r.summary ->> 'n')::INT) FROM backtest_runs r "
        "JOIN strategy_versions v USING (version_id) "
        "WHERE v.strategy_id = ? AND r.kind = 'weekly'",
        [_strategy_id(dataset)],
    ).fetchone()
    return (row[0] or 0) + 1


def save_run(
    con: duckdb.DuckDBPyConnection,
    dataset: str,
    *,
    name: str,
    config: dict[str, Any],
    kpis: dict[str, Any],
    dates: list[str],
    strategy: list[float | None],
    overlay: bool = False,
) -> dict[str, Any]:
    version_id = _ensure_version(con, dataset, config)
    run_id = uuid.uuid4().hex
    n = _next_n(con, dataset)
    summary = {
        "name": name,
        "n": n,
        "kpis": kpis,
        "dates": dates,
        "strategy": strategy,
        "overlay": overlay,
        # A saved result can later be promoted to a scheduled strategy. Keep
        # that state with the immutable config snapshot rather than in the
        # browser, so launchd and the dashboard see the same favourites.
        "favorite": False,
        "active": False,
    }
    con.execute("BEGIN")
    try:
        con.execute(
            "INSERT INTO backtest_runs (run_id, version_id, kind, params, summary) "
            "VALUES (?, ?, 'weekly', ?, ?)",
            [run_id, version_id, json.dumps(config, default=str), json.dumps(summary, default=str)],
        )
        _prune(con, dataset)
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    created_at = con.execute(
        "SELECT strftime(created_at, '%Y-%m-%dT%H:%M:%S%z') "
        "FROM backtest_runs WHERE run_id = ?", [run_id]
    ).fetchone()[0]
    return _record(run_id, config, summary, created_at)


def _prune(con: duckdb.DuckDBPyConnection, dataset: str) -> None:
    """Keep only the newest ordinary runs; never prune scheduled favourites."""
    stale = con.execute(
        "SELECT r.run_id FROM backtest_runs r JOIN strategy_versions v USING (version_id) "
        "WHERE v.strategy_id = ? AND r.kind = 'weekly' "
        "AND COALESCE((r.summary ->> 'favorite')::BOOLEAN, FALSE) = FALSE "
        "ORDER BY r.created_at DESC OFFSET ?",
        [_strategy_id(dataset), MAX_RUNS_PER_DATASET],
    ).fetchall()
    for (run_id,) in stale:
        con.execute("DELETE FROM backtest_runs WHERE run_id = ?", [run_id])


def _record(run_id: str, config: dict[str, Any], summary: dict[str, Any], created_at: str) -> dict[str, Any]:
    return {
        "id": run_id,
        "created_at": created_at,
        "n": summary["n"],
        "name": summary["name"],
        "config": config,
        "kpis": summary["kpis"],
        "dates": summary["dates"],
        "strategy": summary["strategy"],
        "overlay": summary["overlay"],
        "favorite": bool(summary.get("favorite", False)),
        "active": bool(summary.get("active", False)),
    }


def list_runs(con: duckdb.DuckDBPyConnection, dataset: str) -> list[dict[str, Any]]:
    rows = con.execute(
        "SELECT r.run_id, v.spec, r.summary, "
        "strftime(r.created_at, '%Y-%m-%dT%H:%M:%S%z') FROM backtest_runs r "
        "JOIN strategy_versions v USING (version_id) "
        "WHERE v.strategy_id = ? AND r.kind = 'weekly' "
        "ORDER BY COALESCE((r.summary ->> 'favorite')::BOOLEAN, FALSE) DESC, r.created_at DESC",
        [_strategy_id(dataset)],
    ).fetchall()
    return [
        _record(run_id, json.loads(spec), json.loads(summary), created_at)
        for run_id, spec, summary, created_at in rows
    ]


def update_run(
    con: duckdb.DuckDBPyConnection,
    run_id: str,
    *,
    name: str | None = None,
    overlay: bool | None = None,
    favorite: bool | None = None,
    active: bool | None = None,
) -> dict[str, Any] | None:
    row = con.execute(
        "SELECT v.spec, r.summary, "
        "strftime(r.created_at, '%Y-%m-%dT%H:%M:%S%z') "
        "FROM backtest_runs r JOIN strategy_versions v USING (version_id) "
        "WHERE r.run_id = ? AND r.kind = 'weekly'",
        [run_id],
    ).fetchone()
    if row is None:
        return None
    spec, summary_json, created_at = row
    summary = json.loads(summary_json)
    if name is not None:
        summary["name"] = name
    if overlay is not None:
        summary["overlay"] = overlay
    if favorite is not None:
        summary["favorite"] = favorite
        # An inactive favourite is valid; an active non-favourite is not.
        if not favorite:
            summary["active"] = False
    if active is not None:
        summary["active"] = active
        if active:
            summary["favorite"] = True

    con.execute("BEGIN")
    try:
        if summary.get("active", False):
            # The Telegram job has exactly one source. Clear the global active
            # flag, not merely this dataset's flag, before promoting this run.
            active_rows = con.execute(
                "SELECT r.run_id, r.summary FROM backtest_runs r "
                "JOIN strategy_versions v USING (version_id) "
                "JOIN strategies s ON s.strategy_id = v.strategy_id "
                "WHERE s.package = ? AND r.kind = 'weekly' AND r.run_id <> ? "
                "AND COALESCE((r.summary ->> 'active')::BOOLEAN, FALSE) = TRUE",
                [PACKAGE, run_id],
            ).fetchall()
            for other_id, other_summary_json in active_rows:
                other_summary = json.loads(other_summary_json)
                other_summary["active"] = False
                con.execute(
                    "UPDATE backtest_runs SET summary = ? WHERE run_id = ?",
                    [json.dumps(other_summary, default=str), other_id],
                )
        con.execute(
            "UPDATE backtest_runs SET summary = ? WHERE run_id = ?",
            [json.dumps(summary, default=str), run_id],
        )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return _record(run_id, json.loads(spec), summary, created_at)


def list_favorites(con: duckdb.DuckDBPyConnection) -> list[dict[str, Any]]:
    """Return all scheduled momentum strategies, with the active one first.

    This is intentionally cross-dataset: the weekly orchestrator owns the
    eligibility decision while the dashboard needs one consolidated list.
    """
    rows = con.execute(
        "SELECT r.run_id, v.spec, r.summary, "
        "strftime(r.created_at, '%Y-%m-%dT%H:%M:%S%z') FROM backtest_runs r "
        "JOIN strategy_versions v USING (version_id) "
        "JOIN strategies s ON s.strategy_id = v.strategy_id "
        "WHERE s.package = ? AND r.kind = 'weekly' "
        "AND COALESCE((r.summary ->> 'favorite')::BOOLEAN, FALSE) = TRUE "
        "ORDER BY COALESCE((r.summary ->> 'active')::BOOLEAN, FALSE) DESC, r.created_at ASC",
        [PACKAGE],
    ).fetchall()
    return [
        _record(run_id, json.loads(spec), json.loads(summary), created_at)
        for run_id, spec, summary, created_at in rows
    ]


def delete_run(con: duckdb.DuckDBPyConnection, run_id: str) -> bool:
    before = con.execute(
        "SELECT count(*) FROM backtest_runs WHERE run_id = ? AND kind = 'weekly'", [run_id]
    ).fetchone()[0]
    con.execute("DELETE FROM backtest_runs WHERE run_id = ? AND kind = 'weekly'", [run_id])
    return before > 0
