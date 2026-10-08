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

Favourites (BL-051) carry a status: "watching" (journalled every Friday), "paper" (tracked
against the live-money rules as if it had money) or "invested" (real money follows it). Paper +
Invested together are capped at `MAX_FOLLOWED`; Watching is unlimited. Exactly one followed
favourite is the *headline* (`active`, kept under its old name so every existing reader keeps
working): Telegram sends it and This week puts it first. Several runs of one dataset can form a
*group* (e.g. the Phase 6 ensemble's four configs): one favourite with one status and one slot,
whose members are still run and journalled one by one (`summary.member_of`).

Capped at 10 ordinary runs per dataset, oldest dropped first. Favourited and
overlay runs are retained separately from that disposable comparison history:
the weekly scheduler must be able to evaluate favourites, and an overlay is a
curve the user chose to keep on the chart. Neither is ever pruned; only an
explicit delete (or un-marking, which returns the run to the capped pool)
removes them.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

import duckdb

PACKAGE = "momentum"
MAX_RUNS_PER_DATASET = 10
STATUSES = ("watching", "paper", "invested")
FOLLOWED = ("paper", "invested")
MAX_FOLLOWED = 8


class FavouriteError(ValueError):
    """A favourite change the rules refuse (HTTP 409); the message is shown to the owner."""


def status_of(summary: dict[str, Any]) -> str | None:
    """A run's favourite status. None for a non-favourite and for a group member (it follows its
    group). Favourites saved before statuses existed read as Paper if they were the Telegram one,
    Watching otherwise."""
    if summary.get("member_of") or not summary.get("favorite", False):
        return None
    status = summary.get("status")
    if status in STATUSES:
        return status
    return "paper" if summary.get("active", False) else "watching"


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
        "SELECT strftime(created_at, '%Y-%m-%dT%H:%M:%S%z') FROM backtest_runs WHERE run_id = ?",
        [run_id],
    ).fetchone()[0]
    return _record(run_id, config, summary, created_at)


def _prune(con: duckdb.DuckDBPyConnection, dataset: str) -> None:
    """Keep only the newest ordinary runs; never prune favourites or overlays."""
    stale = con.execute(
        "SELECT r.run_id FROM backtest_runs r JOIN strategy_versions v USING (version_id) "
        "WHERE v.strategy_id = ? AND r.kind = 'weekly' "
        "AND COALESCE((r.summary ->> 'favorite')::BOOLEAN, FALSE) = FALSE "
        "AND COALESCE((r.summary ->> 'overlay')::BOOLEAN, FALSE) = FALSE "
        "ORDER BY r.created_at DESC OFFSET ?",
        [_strategy_id(dataset), MAX_RUNS_PER_DATASET],
    ).fetchall()
    for (run_id,) in stale:
        con.execute("DELETE FROM backtest_runs WHERE run_id = ?", [run_id])


def _record(
    run_id: str, config: dict[str, Any], summary: dict[str, Any], created_at: str
) -> dict[str, Any]:
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
        "status": status_of(summary),
        "group": summary.get("group"),
        "member_of": summary.get("member_of"),
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


def _package_rows(con: duckdb.DuckDBPyConnection) -> list[tuple[str, dict[str, Any]]]:
    rows = con.execute(
        "SELECT r.run_id, r.summary FROM backtest_runs r "
        "JOIN strategy_versions v USING (version_id) "
        "JOIN strategies s ON s.strategy_id = v.strategy_id "
        "WHERE s.package = ? AND r.kind = 'weekly'",
        [PACKAGE],
    ).fetchall()
    return [(run_id, json.loads(summary)) for run_id, summary in rows]


def followed_count(
    con: duckdb.DuckDBPyConnection, exclude: set[str] | frozenset = frozenset()
) -> int:
    """Paper + Invested favourites across every dataset; a group counts once, its members not."""
    return sum(
        1
        for run_id, summary in _package_rows(con)
        if run_id not in exclude and status_of(summary) in FOLLOWED
    )


def _limit_message() -> str:
    return f"{MAX_FOLLOWED} favourites are already Paper or Invested. Set one to Watching first."


def _write_summaries(
    con: duckdb.DuckDBPyConnection,
    summaries: dict[str, dict[str, Any]],
    insert: tuple[str, list] | None = None,
) -> None:
    """Write several summaries in one transaction (after `insert`, a new row's statement, when
    given); a new headline clears every other one."""
    con.execute("BEGIN")
    try:
        if insert is not None:
            con.execute(*insert)
        if any(summary.get("active", False) for summary in summaries.values()):
            # The Telegram job has exactly one source. Clear the global active flag, not
            # merely this dataset's flag, before promoting this run.
            for other_id, other in _package_rows(con):
                if other_id not in summaries and other.get("active", False):
                    other["active"] = False
                    con.execute(
                        "UPDATE backtest_runs SET summary = ? WHERE run_id = ?",
                        [json.dumps(other, default=str), other_id],
                    )
        for run_id, summary in summaries.items():
            con.execute(
                "UPDATE backtest_runs SET summary = ? WHERE run_id = ?",
                [json.dumps(summary, default=str), run_id],
            )
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise


def _load(
    con: duckdb.DuckDBPyConnection, run_id: str
) -> tuple[str, dict[str, Any], str, str] | None:
    row = con.execute(
        "SELECT v.spec, r.summary, strftime(r.created_at, '%Y-%m-%dT%H:%M:%S%z'), v.strategy_id "
        "FROM backtest_runs r JOIN strategy_versions v USING (version_id) "
        "WHERE r.run_id = ? AND r.kind = 'weekly'",
        [run_id],
    ).fetchone()
    if row is None:
        return None
    spec, summary_json, created_at, strategy_id = row
    return spec, json.loads(summary_json), created_at, strategy_id


def update_run(
    con: duckdb.DuckDBPyConnection,
    run_id: str,
    *,
    name: str | None = None,
    overlay: bool | None = None,
    favorite: bool | None = None,
    active: bool | None = None,
    status: str | None = None,
) -> dict[str, Any] | None:
    """Rename, overlay, or change a run's favourite state. `status` is one of `STATUSES`, or
    "none" to stop following it; `favorite` is the older on/off switch (on = Watching).
    `active` makes it the headline, which must be Paper or Invested (Watching is promoted to
    Paper). Raises `FavouriteError` for a change the rules refuse."""
    loaded = _load(con, run_id)
    if loaded is None:
        return None
    spec, summary, created_at, _ = loaded
    before = status_of(summary)
    favourite_change = favorite is not None or active is not None or status is not None
    if favourite_change and summary.get("member_of"):
        group = _load(con, summary["member_of"])
        group_name = group[1].get("name", "its group") if group else "its group"
        raise FavouriteError(
            f"“{summary.get('name')}” is part of the group “{group_name}”: "
            "change the group's status instead."
        )
    if name is not None:
        summary["name"] = name
    if overlay is not None:
        summary["overlay"] = overlay
    if favorite is not None and status is None:
        status = ("watching" if before is None else before) if favorite else "none"
    if status is not None:
        if status == "none":
            if summary.get("group"):
                raise FavouriteError(
                    "A group is always a favourite. Delete the group to stop following it "
                    "(its runs are kept)."
                )
            summary["favorite"] = False
            summary["active"] = False
            summary.pop("status", None)
        elif status in STATUSES:
            summary["favorite"] = True
            summary["status"] = status
            if status == "watching":
                summary["active"] = False
        else:
            raise FavouriteError(f"Unknown status {status!r}.")
    if active is not None:
        summary["active"] = active
        if active:
            summary["favorite"] = True
            if status_of(summary) not in FOLLOWED:
                summary["status"] = "paper"
    after = status_of(summary)
    if (
        after in FOLLOWED
        and before not in FOLLOWED
        and followed_count(con, {run_id}) >= MAX_FOLLOWED
    ):
        raise FavouriteError(_limit_message())
    _write_summaries(con, {run_id: summary})
    return _record(run_id, json.loads(spec), summary, created_at)


def create_group(
    con: duckdb.DuckDBPyConnection, name: str, member_ids: list[str]
) -> dict[str, Any]:
    """Make several saved runs of one dataset into one favourite. Each member stays a favourite
    (it is still run and journalled every Friday) but takes the group's status; the group takes
    the highest status among them, and the headline if one of them had it."""
    member_ids = list(dict.fromkeys(member_ids))
    if len(member_ids) < 2:
        raise FavouriteError("A group needs at least two saved runs.")
    members: dict[str, dict[str, Any]] = {}
    datasets = set()
    for member_id in member_ids:
        loaded = _load(con, member_id)
        if loaded is None:
            raise FavouriteError(f"Saved run {member_id} was not found.")
        _, summary, _, strategy_id = loaded
        if summary.get("group"):
            raise FavouriteError(f"“{summary.get('name')}” is a group; groups cannot be nested.")
        if summary.get("member_of"):
            raise FavouriteError(f"“{summary.get('name')}” is already in a group.")
        members[member_id] = summary
        datasets.add(strategy_id.removeprefix("momentum:"))
    if len(datasets) != 1:
        raise FavouriteError("Every run in a group must be from the same dataset.")
    dataset = datasets.pop()
    statuses = [status_of(summary) for summary in members.values()]
    status = next((s for s in reversed(STATUSES) if s in statuses), "watching")
    headline = any(summary.get("active", False) for summary in members.values())
    if status in FOLLOWED and followed_count(con, set(member_ids)) >= MAX_FOLLOWED:
        raise FavouriteError(_limit_message())

    config = {"dataset": dataset, "group": member_ids}
    version_id = _ensure_version(con, dataset, config)
    group_id = uuid.uuid4().hex
    summary = {
        "name": name,
        "n": _next_n(con, dataset),
        "kpis": {},
        "dates": [],
        "strategy": [],
        "overlay": False,
        "favorite": True,
        "status": status,
        "active": headline,
        "group": member_ids,
    }
    insert = (
        "INSERT INTO backtest_runs (run_id, version_id, kind, params, summary) "
        "VALUES (?, ?, 'weekly', ?, ?)",
        [group_id, version_id, json.dumps(config), json.dumps(summary, default=str)],
    )
    updates = {group_id: summary}
    for member_id, member in members.items():
        member.update({"favorite": True, "active": False, "member_of": group_id})
        member.pop("status", None)
        updates[member_id] = member
    _write_summaries(con, updates, insert)
    created_at = _load(con, group_id)[2]
    return _record(group_id, config, summary, created_at)


def list_favorites(
    con: duckdb.DuckDBPyConnection, *, include_groups: bool = False
) -> list[dict[str, Any]]:
    """Return all scheduled momentum strategies, with the active one first.

    This is intentionally cross-dataset: the weekly orchestrator owns the
    eligibility decision while the dashboard needs one consolidated list.
    Groups are left out unless asked for: they have no config of their own to run, and their
    members are listed (and run, and journalled) as ordinary favourites.
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
    records = [
        _record(run_id, json.loads(spec), json.loads(summary), created_at)
        for run_id, spec, summary, created_at in rows
    ]
    return records if include_groups else [record for record in records if not record["group"]]


def list_groups(con: duckdb.DuckDBPyConnection) -> list[dict[str, Any]]:
    """Every group, each with its members' full records under `members`."""
    favourites = list_favorites(con, include_groups=True)
    by_id = {record["id"]: record for record in favourites}
    return [
        {**record, "members": [by_id[m] for m in record["group"] if m in by_id]}
        for record in favourites
        if record["group"]
    ]


def delete_run(con: duckdb.DuckDBPyConnection, run_id: str) -> bool:
    """Delete a saved run. Deleting a group keeps its members, as Watching favourites; a member
    cannot be deleted while its group exists."""
    loaded = _load(con, run_id)
    if loaded is None:
        return False
    summary = loaded[1]
    if summary.get("member_of"):
        group = _load(con, summary["member_of"])
        group_name = group[1].get("name", "its group") if group else "its group"
        raise FavouriteError(
            f"“{summary.get('name')}” is part of the group “{group_name}”. "
            "Delete the group first (its runs are kept)."
        )
    updates = {}
    for member_id in summary.get("group") or []:
        member = _load(con, member_id)
        if member is not None:
            member_summary = member[1]
            member_summary.pop("member_of", None)
            member_summary["favorite"] = True
            member_summary["status"] = "watching"
            updates[member_id] = member_summary
    if updates:
        _write_summaries(con, updates)
    con.execute("DELETE FROM backtest_runs WHERE run_id = ? AND kind = 'weekly'", [run_id])
    return True
