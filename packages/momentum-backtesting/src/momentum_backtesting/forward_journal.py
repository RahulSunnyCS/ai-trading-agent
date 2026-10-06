"""
BL-024: the forward-signal journal — every weekly signal, recorded when it is produced and never
changed afterwards, so it can later be scored against what actually happened.

A backtest can be fitted to the past; a signal written down *before* its week cannot. That only
holds if the record cannot be quietly rewritten, so:

- `record` is the only writer, and it only inserts. A rerun that produces the identical signal
  writes nothing; a rerun that produces a different one writes a new row whose `supersedes`
  points at the old one. Phase 2 scores the earliest row recorded before the fill.
- DuckDB has no triggers, so the database cannot refuse an UPDATE or DELETE. Each row instead
  stores the hash of the previous row and of itself (a hash chain over the exact stored text):
  `verify` finds an edited row, a removed row, or a reordered one. Removing the *newest* rows
  leaves a valid shorter chain, which is why the weekly run sends the chain head to Telegram —
  Telegram's timestamp is the outside witness of how long the chain was and when.

What a row holds: the signal as produced (its BUY/SELL/HOLD rows) and `holdings_before`, the
model portfolio at the signal's close *before* those actions — the engine never trades its own
newest week, so the post-trade portfolio does not exist yet when the signal is recorded. Next
week's row holds it (as its own `holdings_before`); Phase 2 checks that every recorded BUY
appears there and every SELL is gone before scoring the week.

Table: `momentum_forward_journal` (`packages/trading-data`, migration 007).
"""

from __future__ import annotations

import hashlib
import json
import math
import subprocess
from dataclasses import dataclass
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import pandas as pd

TABLE = "momentum_forward_journal"
GENESIS = "0" * 64

#: Every column the row hash covers, in hashing order (all but row_hash itself).
_HASHED = (
    "entry_id",
    "recorded_at",
    "week",
    "run_kind",
    "source",
    "config_id",
    "config_name",
    "dataset",
    "settings_hash",
    "settings",
    "code_commit",
    "data_fingerprint",
    "holdings_before",
    "signal",
    "supersedes",
    "prev_hash",
)


@dataclass(frozen=True)
class Entry:
    week: str  # the signal week, YYYY-MM-DD
    run_kind: str  # preview | final
    source: str  # favourite | benchmark
    config_id: str
    config_name: str
    dataset: str
    settings: dict
    holdings_before: dict  # model portfolio at the signal close, before the signal's actions
    signal: dict  # the signal as produced, including its BUY/SELL/HOLD rows
    data_fingerprint: str
    code_commit: str


def _plain(value: Any) -> Any:
    """JSON-safe and deterministic: NaN/inf become null, numpy and pandas scalars become plain
    Python, dates become ISO strings. json.dumps would otherwise write NaN, which is not JSON."""
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_plain(v) for v in value]
    if value is None or value is pd.NaT:
        return None
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, float):
        return None if math.isnan(value) or math.isinf(value) else value
    if isinstance(value, pd.Timestamp | datetime | date):
        return value.isoformat()
    if isinstance(value, str | int | bool):
        return value
    return str(value)


def canonical(value: Any) -> str:
    return json.dumps(_plain(value), sort_keys=True, separators=(",", ":"), allow_nan=False)


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _row_hash(row: dict) -> str:
    return _sha256(canonical({name: row[name] for name in _HASHED}))


def week_string(week: Any) -> str:
    return pd.Timestamp(week).strftime("%Y-%m-%d")


def code_commit() -> str:
    """git HEAD of this checkout, with '+dirty' when the momentum or trading-data code had
    uncommitted changes — a signal from uncommitted code cannot be reproduced from history."""
    package = Path(__file__).resolve().parents[2]

    def git(*args: str) -> str:
        done = subprocess.run(
            ["git", *args], cwd=package, capture_output=True, text=True, timeout=20, check=False
        )
        return done.stdout.strip() if done.returncode == 0 else ""

    commit = git("rev-parse", "HEAD")
    if not commit:
        return "unknown"
    dirty = git("status", "--porcelain", "--", "src", "../trading-data/src")
    return f"{commit}+dirty" if dirty else commit


def file_fingerprint(path: Path) -> str:
    if not path.exists():
        return "missing"
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def frame_fingerprint(frame: pd.DataFrame) -> str:
    digest = hashlib.sha256(canonical([str(c) for c in frame.columns]).encode())
    digest.update(pd.util.hash_pandas_object(frame, index=True).to_numpy().tobytes())
    return "sha256:" + digest.hexdigest()


def record(con: duckdb.DuckDBPyConnection, entry: Entry, now: datetime | None = None) -> int | None:
    """Append `entry`; return its entry_id, or None when the latest row for the same week, run
    and config already holds exactly this signal (a rerun on unchanged data)."""
    settings = canonical(entry.settings)
    holdings = canonical(entry.holdings_before)
    signal = canonical(entry.signal)
    settings_hash = _sha256(settings)[:16]
    week = week_string(entry.week)
    con.execute("BEGIN TRANSACTION")
    try:
        latest = con.execute(
            f"SELECT entry_id, settings_hash, holdings_before, signal FROM {TABLE} "
            "WHERE week = ? AND run_kind = ? AND config_id = ? ORDER BY entry_id DESC LIMIT 1",
            [week, entry.run_kind, entry.config_id],
        ).fetchone()
        if latest is not None and tuple(latest[1:]) == (settings_hash, holdings, signal):
            con.execute("ROLLBACK")
            return None
        head = con.execute(
            f"SELECT entry_id, row_hash FROM {TABLE} ORDER BY entry_id DESC LIMIT 1"
        ).fetchone()
        row = {
            "entry_id": (head[0] + 1) if head else 1,
            "recorded_at": (now or datetime.now(UTC))
            .astimezone(UTC)
            .strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            "week": week,
            "run_kind": entry.run_kind,
            "source": entry.source,
            "config_id": entry.config_id,
            "config_name": entry.config_name,
            "dataset": entry.dataset,
            "settings_hash": settings_hash,
            "settings": settings,
            "code_commit": entry.code_commit,
            "data_fingerprint": entry.data_fingerprint,
            "holdings_before": holdings,
            "signal": signal,
            "supersedes": latest[0] if latest is not None else None,
            "prev_hash": head[1] if head else GENESIS,
        }
        row["row_hash"] = _row_hash(row)
        columns = (*_HASHED, "row_hash")
        con.execute(
            f"INSERT INTO {TABLE} ({', '.join(columns)}) VALUES ({', '.join('?' * len(columns))})",
            [row[c] for c in columns],
        )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return row["entry_id"]


def _rows(con: duckdb.DuckDBPyConnection, where: str = "", params: list | None = None) -> list:
    cursor = con.execute(
        f"SELECT {', '.join(_HASHED)}, row_hash FROM ("
        f"SELECT * REPLACE (strftime(week, '%Y-%m-%d') AS week) FROM {TABLE}) {where} "
        "ORDER BY entry_id",
        params or [],
    )
    names = [d[0] for d in cursor.description]
    return [dict(zip(names, values, strict=True)) for values in cursor.fetchall()]


def entries(con: duckdb.DuckDBPyConnection, week: str | None = None) -> list[dict]:
    if week is None:
        return _rows(con)
    return _rows(con, "WHERE week = ?", [week_string(week)])


def verify(con: duckdb.DuckDBPyConnection) -> list[str]:
    """Every way the stored chain differs from an untouched one; empty means intact."""
    problems = []
    previous_hash = GENESIS
    for expected_id, row in enumerate(_rows(con), start=1):
        if row["entry_id"] != expected_id:
            problems.append(
                f"entry {expected_id} is missing (next stored entry is {row['entry_id']})"
            )
        if row["prev_hash"] != previous_hash:
            problems.append(f"entry {row['entry_id']}: does not follow the entry before it")
        if _row_hash(row) != row["row_hash"]:
            problems.append(f"entry {row['entry_id']}: its contents were changed after recording")
        previous_hash = row["row_hash"]
    return problems


def head(con: duckdb.DuckDBPyConnection) -> tuple[int, str] | None:
    """(number of entries, newest row_hash) — what the weekly Telegram message witnesses."""
    row = con.execute(
        f"SELECT entry_id, row_hash FROM {TABLE} ORDER BY entry_id DESC LIMIT 1"
    ).fetchone()
    return (int(row[0]), row[1]) if row else None
