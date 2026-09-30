"""ingest_runs bookkeeping — one row per download run (replaces manifest/*.json)."""

from __future__ import annotations

import json
import uuid
from datetime import date
from typing import Any

import duckdb


def start_run(
    con: duckdb.DuckDBPyConnection, source: str, dataset: str, day: date | None, scope: str
) -> str:
    run_id = uuid.uuid4().hex
    con.execute(
        "INSERT INTO ingest_runs (run_id, source, dataset, trading_day, scope) VALUES (?,?,?,?,?)",
        [run_id, source, dataset, day, scope],
    )
    return run_id


def finish_run(
    con: duckdb.DuckDBPyConnection,
    run_id: str,
    *,
    requests: int,
    rows_written: int,
    errors: int,
    details: dict[str, Any],
    failed: bool = False,
) -> None:
    status = "failed" if failed else ("partial" if errors else "ok")
    con.execute(
        "UPDATE ingest_runs SET finished_at = now(), status = ?, requests = ?, "
        "rows_written = ?, errors = ?, details = ? WHERE run_id = ?",
        [status, requests, rows_written, errors, json.dumps(details, default=str), run_id],
    )


def add_issue(
    con: duckdb.DuckDBPyConnection,
    run_id: str,
    check_name: str,
    detail: str,
    *,
    instrument_id: int | None = None,
    day: date | None = None,
) -> None:
    con.execute(
        "INSERT INTO quality_issues (run_id, instrument_id, trading_day, check_name, detail) "
        "VALUES (?,?,?,?,?)",
        [run_id, instrument_id, day, check_name, detail],
    )
