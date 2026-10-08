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

**One strategy per set of settings (BL-052).** A version is now the run's *normalised* settings
(`saved_identity.fingerprint`), so every run of the same settings belongs to one version: the
strategy. Each run records its fingerprints (`summary.versions`: data and code) and an
`outcome` against the strategy's previous run: `new`, `repeat` (the same result, whatever the
data version) or `new_result`, which also appends a row to `momentum_result_changes` saying why it
moved (`saved_identity.explain`). The strategy's name, notes and favourite state live on its
*anchor* run (the favourite run if there is one, else the oldest), so a favourite's run id, which
the journal and the weekly job key on, never changes. A run's own config is `backtest_runs.params`
(what it was saved with). The version's `spec` is a runnable config of the strategy (its anchor's
raw config), never the normalised settings: code from before BL-052 reads a run's config from
`spec`, and normalised Broad settings have no `universe`, which the request model requires.

Pruning: each strategy keeps every result change and its newest `MAX_REPEATS` repeats; each
dataset keeps its newest `MAX_STRATEGIES_PER_DATASET` strategies that nothing keeps (a favourite,
a group member or an overlay keeps a strategy, never pruned). Only an explicit delete, or
un-marking (which returns it to the capped pool), removes a kept one.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

import duckdb

from . import saved_identity

PACKAGE = "momentum"
MAX_STRATEGIES_PER_DATASET = 10
#: Repeat runs (same settings, same result) a strategy keeps, newest first (owner, 2026-10-08).
MAX_REPEATS = 3
#: The name the dashboard gives a run it saves; a strategy with such a name shows an auto name.
_PLACEHOLDER = re.compile(r"^Run \d+$")
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
    """The raw-text hash versions were keyed on before BL-052 (still used for groups)."""
    return saved_identity.raw_hash(config)


def _ensure_version(
    con: duckdb.DuckDBPyConnection, dataset: str, h: str, spec: dict[str, Any]
) -> str:
    strategy_id = _strategy_id(dataset)
    version_id = f"{strategy_id}:{h}"
    con.execute(
        "INSERT INTO strategies (strategy_id, package, name) VALUES (?, ?, ?) "
        "ON CONFLICT DO NOTHING",
        [strategy_id, PACKAGE, strategy_id],
    )
    con.execute(
        "INSERT INTO strategy_versions (version_id, strategy_id, spec_hash, spec) "
        "VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
        [version_id, strategy_id, h, json.dumps(spec, default=str)],
    )
    return version_id


def _normalised_version(
    con: duckdb.DuckDBPyConnection, dataset: str, config: dict[str, Any]
) -> tuple[str, str]:
    """(version_id, fingerprint) of the strategy this config belongs to."""
    _, fp = saved_identity.identity(dataset, config)
    return _ensure_version(con, dataset, fp, config), fp


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
    versions: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Save a finished run under its strategy. The record carries `outcome` (`new`, `repeat`,
    `new_result`), the strategy it joined (`strategy_ref`: anchor id, name, whether it is a
    favourite; `strategy` stays the equity curve) and, for a moved result, the `change` row
    written with it."""
    version_id, fp = _normalised_version(con, dataset, config)
    previous = _latest_run(con, version_id)
    anchor = _anchor(con, version_id)
    run_id = uuid.uuid4().hex
    summary = {
        "name": name,
        "n": _next_n(con, dataset),
        "kpis": kpis,
        "dates": dates,
        "strategy": strategy,
        "overlay": overlay,
        # A saved result can later be promoted to a scheduled strategy. Keep
        # that state with the immutable config snapshot rather than in the
        # browser, so launchd and the dashboard see the same favourites.
        "favorite": False,
        "active": False,
        "fingerprint": fp,
        "versions": versions,
        "data_through": dates[-1] if dates else None,
        "name_typed": not _PLACEHOLDER.match(name),
    }
    explained = None
    if previous is None:
        summary["outcome"] = "new"
    elif saved_identity.same_result(previous[1], summary):
        summary["outcome"] = "repeat"
    else:
        summary["outcome"] = "new_result"
        explained = saved_identity.explain(dataset, previous[1], summary)
    anchor_id = anchor[0] if anchor else run_id
    change = None
    con.execute("BEGIN")
    try:
        con.execute(
            "INSERT INTO backtest_runs (run_id, version_id, kind, params, summary) "
            "VALUES (?, ?, 'weekly', ?, ?)",
            [run_id, version_id, json.dumps(config, default=str), json.dumps(summary, default=str)],
        )
        if explained is not None:
            change = _insert_change(
                con, dataset, version_id, anchor_id, previous, (run_id, summary), explained
            )
        _prune_repeats(con, version_id)
        _prune(con, dataset)
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    created_at = con.execute(
        "SELECT strftime(created_at, '%Y-%m-%dT%H:%M:%S%z') FROM backtest_runs WHERE run_id = ?",
        [run_id],
    ).fetchone()[0]
    record = _record(run_id, config, summary, created_at)
    anchor_summary = anchor[1] if anchor else summary
    record["strategy_ref"] = {
        "id": anchor_id,
        "name": anchor_summary.get("name"),
        "favourite": _is_favourite(anchor_summary),
    }
    record["change"] = change
    return record


# --- strategies: anchor, latest run, pruning --------------------------------------------------


def _is_favourite(summary: dict[str, Any]) -> bool:
    """A favourite, a group or a group member: what the weekly job runs (an overlay is not)."""
    return bool(summary.get("favorite") or summary.get("member_of") or summary.get("group"))


def _keeps(summary: dict[str, Any]) -> bool:
    """A run whose strategy is never pruned: a favourite, a group member, a group, an overlay."""
    return _is_favourite(summary) or bool(summary.get("overlay"))


_FLAG_SQL = (
    "(COALESCE((r.summary ->> 'favorite')::BOOLEAN, FALSE) "
    "OR (r.summary ->> 'member_of') IS NOT NULL "
    "OR (r.summary ->> 'group') IS NOT NULL)"
)
_ORDER = "r.created_at, (r.summary ->> 'n')::INT"


def _anchor(con: duckdb.DuckDBPyConnection, version_id: str) -> tuple[str, dict[str, Any]] | None:
    """The run holding the strategy's name and favourite state: its favourite run if any, else
    its oldest run."""
    row = con.execute(
        "SELECT r.run_id, r.summary FROM backtest_runs r "
        "WHERE r.version_id = ? AND r.kind = 'weekly' "
        f"ORDER BY {_FLAG_SQL} DESC, {_ORDER} LIMIT 1",
        [version_id],
    ).fetchone()
    return (row[0], json.loads(row[1])) if row else None


def _latest_run(
    con: duckdb.DuckDBPyConnection, version_id: str
) -> tuple[str, dict[str, Any]] | None:
    row = con.execute(
        "SELECT r.run_id, r.summary FROM backtest_runs r "
        "WHERE r.version_id = ? AND r.kind = 'weekly' "
        "ORDER BY r.created_at DESC, (r.summary ->> 'n')::INT DESC LIMIT 1",
        [version_id],
    ).fetchone()
    return (row[0], json.loads(row[1])) if row else None


def _insert_change(
    con: duckdb.DuckDBPyConnection,
    dataset: str,
    version_id: str,
    anchor_id: str,
    previous: tuple[str, dict[str, Any]],
    run: tuple[str, dict[str, Any]],
    explained: dict[str, Any],
) -> dict[str, Any]:
    """Append one row to the result-change log (inside the caller's transaction)."""
    (prev_id, before), (run_id, after) = previous, run
    own = ("label", "first_difference", "changed")
    detail = {k: v for k, v in explained.items() if k not in own}
    row = {
        "change_id": uuid.uuid4().hex,
        "dataset": dataset,
        "version_id": version_id,
        "anchor_run_id": anchor_id,
        "prev_run_id": prev_id,
        "run_id": run_id,
        "label": explained["label"],
        "prev_versions": before.get("versions"),
        "versions": after.get("versions"),
        "changed": explained.get("changed"),
        "first_difference": explained.get("first_difference"),
        "kpis_before": before.get("kpis") or {},
        "kpis_after": after.get("kpis") or {},
        "detail": detail or None,
    }
    con.execute(
        "INSERT INTO momentum_result_changes (change_id, dataset, version_id, anchor_run_id, "
        "prev_run_id, run_id, label, prev_versions, versions, changed, first_difference, "
        "kpis_before, kpis_after, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            row["change_id"],
            dataset,
            version_id,
            anchor_id,
            prev_id,
            run_id,
            row["label"],
            _json_or_null(row["prev_versions"]),
            _json_or_null(row["versions"]),
            _json_or_null(row["changed"]),
            row["first_difference"],
            json.dumps(row["kpis_before"], default=str),
            json.dumps(row["kpis_after"], default=str),
            _json_or_null(row["detail"]),
        ],
    )
    # One line in the service log per change: the same record, for whoever reads the logs.
    print(json.dumps({"event": "momentum_result_change", **row}, default=str), flush=True)
    return {**row, "reviewed_at": None, "reviewed_by": None}


def _json_or_null(value: Any) -> str | None:
    return None if value is None else json.dumps(value, default=str)


def _prune_repeats(con: duckdb.DuckDBPyConnection, version_id: str) -> None:
    """Keep the strategy's newest `MAX_REPEATS` repeat runs; every other outcome is kept, and so
    is any repeat that holds state (the anchor, a favourite, an overlay)."""
    rows = con.execute(
        "SELECT r.run_id, r.summary FROM backtest_runs r "
        "WHERE r.version_id = ? AND r.kind = 'weekly' AND (r.summary ->> 'outcome') = 'repeat' "
        "ORDER BY r.created_at DESC, (r.summary ->> 'n')::INT DESC",
        [version_id],
    ).fetchall()
    anchor = _anchor(con, version_id)
    stale = [
        run_id
        for run_id, summary in rows[MAX_REPEATS:]
        if not _keeps(json.loads(summary)) and (anchor is None or run_id != anchor[0])
    ]
    for run_id in stale:
        con.execute("DELETE FROM backtest_runs WHERE run_id = ?", [run_id])


def _prune(con: duckdb.DuckDBPyConnection, dataset: str) -> None:
    """Keep the newest `MAX_STRATEGIES_PER_DATASET` strategies nothing keeps; a strategy with a
    favourite, group, group member or overlay run is never pruned."""
    rows = con.execute(
        "SELECT r.version_id, "
        f"bool_or({_FLAG_SQL} OR COALESCE((r.summary ->> 'overlay')::BOOLEAN, FALSE)) AS kept "
        "FROM backtest_runs r JOIN strategy_versions v USING (version_id) "
        "WHERE v.strategy_id = ? AND r.kind = 'weekly' GROUP BY r.version_id "
        "ORDER BY max(r.created_at) DESC, max((r.summary ->> 'n')::INT) DESC",
        [_strategy_id(dataset)],
    ).fetchall()
    ordinary = [version_id for version_id, kept in rows if not kept]
    for version_id in ordinary[MAX_STRATEGIES_PER_DATASET:]:
        con.execute(
            "DELETE FROM backtest_runs WHERE version_id = ? AND kind = 'weekly'", [version_id]
        )


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
        "fingerprint": summary.get("fingerprint"),
        "versions": summary.get("versions"),
        "data_through": summary.get("data_through"),
        "outcome": summary.get("outcome"),
    }


def list_runs(con: duckdb.DuckDBPyConnection, dataset: str) -> list[dict[str, Any]]:
    rows = con.execute(
        "SELECT r.run_id, r.params, r.summary, "
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


def _package_rows(con: duckdb.DuckDBPyConnection, flag: str) -> list[tuple[str, dict[str, Any]]]:
    """Every run whose summary has `flag` ("favorite" or "active") set, parsed. Filtered in SQL:
    a summary carries the run's whole weekly curve, so parsing every run would be wasted work."""
    rows = con.execute(
        "SELECT r.run_id, r.summary FROM backtest_runs r "
        "JOIN strategy_versions v USING (version_id) "
        "JOIN strategies s ON s.strategy_id = v.strategy_id "
        "WHERE s.package = ? AND r.kind = 'weekly' "
        f"AND COALESCE((r.summary ->> '{flag}')::BOOLEAN, FALSE) = TRUE",
        [PACKAGE],
    ).fetchall()
    return [(run_id, json.loads(summary)) for run_id, summary in rows]


def followed_count(
    con: duckdb.DuckDBPyConnection, exclude: set[str] | frozenset = frozenset()
) -> int:
    """Paper + Invested favourites across every dataset; a group counts once, its members not."""
    return sum(
        1
        for run_id, summary in _package_rows(con, "favorite")
        if run_id not in exclude and status_of(summary) in FOLLOWED
    )


def _limit_message() -> str:
    return f"{MAX_FOLLOWED} favourites are already Paper or Invested. Set one to Watching first."


def _write_summaries(
    con: duckdb.DuckDBPyConnection,
    summaries: dict[str, dict[str, Any]],
    statement: tuple[str, list] | None = None,
) -> None:
    """Write several summaries in one transaction, with `statement` (a new group's INSERT, a
    deleted group's DELETE) run first in the same one; a new headline clears every other one."""
    con.execute("BEGIN")
    try:
        if statement is not None:
            con.execute(*statement)
        if any(summary.get("active", False) for summary in summaries.values()):
            # The Telegram job has exactly one source. Clear the global active flag, not
            # merely this dataset's flag, before promoting this run.
            for other_id, other in _package_rows(con, "active"):
                if other_id not in summaries:
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
        "SELECT r.params, r.summary, strftime(r.created_at, '%Y-%m-%dT%H:%M:%S%z'), v.strategy_id "
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
    notes: str | None = None,
) -> dict[str, Any] | None:
    """Rename, add notes, overlay, or change a run's favourite state. `status` is one of
    `STATUSES`, or "none" to stop following it; `favorite` is the older on/off switch (on =
    Watching). `active` makes it the headline, which must be Paper or Invested (Watching is
    promoted to Paper). Raises `FavouriteError` for a change the rules refuse."""
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
        summary["name_typed"] = True
    if notes is not None:
        summary["notes"] = notes.strip() or None
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
    version_id = _ensure_version(con, dataset, spec_hash(config), config)
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
        "SELECT r.run_id, r.params, r.summary, "
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
    # One transaction: a group is never left pointing at runs that no longer name it.
    _write_summaries(
        con, updates, ("DELETE FROM backtest_runs WHERE run_id = ? AND kind = 'weekly'", [run_id])
    )
    return True


# --- strategies (BL-052) ----------------------------------------------------------------------


def _all_runs(con: duckdb.DuckDBPyConnection, dataset: str | None = None) -> list[dict[str, Any]]:
    """Every momentum run with what a strategy needs, oldest first."""
    rows = con.execute(
        "SELECT r.run_id, r.version_id, v.strategy_id, r.params, r.summary, "
        "strftime(r.created_at, '%Y-%m-%dT%H:%M:%S%z') FROM backtest_runs r "
        "JOIN strategy_versions v USING (version_id) "
        "JOIN strategies s ON s.strategy_id = v.strategy_id "
        "WHERE s.package = ? AND r.kind = 'weekly' "
        + ("AND v.strategy_id = ? " if dataset else "")
        + f"ORDER BY {_ORDER}",
        [PACKAGE, _strategy_id(dataset)] if dataset else [PACKAGE],
    ).fetchall()
    return [
        {
            "id": run_id,
            "version_id": version_id,
            "dataset": strategy_id.removeprefix("momentum:"),
            "config": json.loads(params) if params else {},
            "summary": json.loads(summary),
            "created_at": created_at,
        }
        for run_id, version_id, strategy_id, params, summary, created_at in rows
    ]


_CHANGE_KEYS = (
    "change_id",
    "created_at",
    "dataset",
    "version_id",
    "anchor_run_id",
    "prev_run_id",
    "run_id",
    "label",
    "prev_versions",
    "versions",
    "changed",
    "first_difference",
    "kpis_before",
    "kpis_after",
    "detail",
    "reviewed_at",
    "reviewed_by",
)


def _changes(con: duckdb.DuckDBPyConnection, where: str = "", args: list | None = None) -> list:
    rows = con.execute(
        "SELECT change_id, strftime(created_at, '%Y-%m-%dT%H:%M:%S%z'), dataset, version_id, "
        "anchor_run_id, prev_run_id, run_id, label, prev_versions, versions, changed, "
        "strftime(first_difference, '%Y-%m-%d'), kpis_before, kpis_after, detail, "
        "strftime(reviewed_at, '%Y-%m-%dT%H:%M:%S%z'), reviewed_by "
        f"FROM momentum_result_changes {where} ORDER BY created_at DESC",
        args or [],
    ).fetchall()
    keys = _CHANGE_KEYS
    out = []
    for row in rows:
        item = dict(zip(keys, row, strict=True))
        for key in ("prev_versions", "versions", "changed", "kpis_before", "kpis_after", "detail"):
            if isinstance(item[key], str):
                item[key] = json.loads(item[key])
        item["needs_review"] = (
            item["label"] in saved_identity.NEEDS_REVIEW and item["reviewed_at"] is None
        )
        out.append(item)
    return out


def list_changes(
    con: duckdb.DuckDBPyConnection, *, unreviewed: bool = False, version_id: str | None = None
) -> list[dict[str, Any]]:
    """The result-change log, newest first. `unreviewed`: only Check / Not reproducible changes
    nobody has marked reviewed yet (the Saved runs tab's count)."""
    clauses, args = [], []
    if unreviewed:
        labels = ", ".join(f"'{label}'" for label in sorted(saved_identity.NEEDS_REVIEW))
        clauses.append(f"label IN ({labels}) AND reviewed_at IS NULL")
    if version_id:
        clauses.append("version_id = ?")
        args.append(version_id)
    return _changes(con, ("WHERE " + " AND ".join(clauses)) if clauses else "", args)


def mark_reviewed(con: duckdb.DuckDBPyConnection, change_id: str, by: str) -> dict[str, Any] | None:
    """Mark one change reviewed (once; a second call keeps the first reviewer and time)."""
    found = con.execute(
        "SELECT count(*) FROM momentum_result_changes WHERE change_id = ?", [change_id]
    ).fetchone()[0]
    if not found:
        return None
    con.execute(
        "UPDATE momentum_result_changes SET reviewed_at = now(), reviewed_by = ? "
        "WHERE change_id = ? AND reviewed_at IS NULL",
        [by, change_id],
    )
    return _changes(con, "WHERE change_id = ?", [change_id])[0]


_frozen_memo: tuple[float, frozenset[str]] | None = None


def _frozen_fingerprints() -> frozenset[str]:
    """Fingerprints of the BL-010 Phase 6 frozen configs: the only validated strategies.
    Recomputed only when the frozen file changes."""
    global _frozen_memo
    from . import live_rules, phase6

    try:
        mtime = live_rules.FROZEN_PATH.stat().st_mtime
        if _frozen_memo is None or _frozen_memo[0] != mtime:
            requests = phase6.favourite_requests(json.loads(live_rules.FROZEN_PATH.read_text()))
            fps = frozenset(saved_identity.fingerprint("broad", r) for r in requests)
            _frozen_memo = (mtime, fps)
    except (OSError, ValueError, KeyError):
        return frozenset()
    return _frozen_memo[1]


def _trust(strategy: dict[str, Any], validated: frozenset[str], newest: str | None) -> str:
    """How far the strategy's result can be trusted: validated (passed BL-010), not tradable
    (Broad with the liquidity filter or the circuit rule off), old data (more than a week behind
    the newest saved data), else in-sample (the best of what was tried on the same data)."""
    if strategy["fingerprint"] in validated:
        return "validated"
    config = strategy["config"]
    if strategy["dataset"] == "broad" and not (
        config.get("broad_liquidity_filter", False) and config.get("broad_respect_circuits", False)
    ):
        return "not_tradable"
    through = strategy["latest"]["data_through"]
    if through and newest:
        from datetime import date

        if (date.fromisoformat(newest) - date.fromisoformat(through)).days > 7:
            return "old_data"
    return "in_sample"


def _strategy(runs: list[dict[str, Any]], changes: list[dict[str, Any]]) -> dict[str, Any]:
    """One strategy from its runs (oldest first) and its change rows (newest first)."""
    anchor = next((r for r in runs if _is_favourite(r["summary"])), runs[0])
    latest = runs[-1]
    summary, last = anchor["summary"], latest["summary"]
    change = changes[0] if changes and changes[0]["run_id"] == latest["id"] else None
    return {
        "id": anchor["id"],
        "version_id": anchor["version_id"],
        "dataset": anchor["dataset"],
        "fingerprint": summary.get("fingerprint")
        or saved_identity.fingerprint(anchor["dataset"], anchor["config"]),
        "name": summary.get("name"),
        "name_typed": bool(
            summary.get("name_typed", not _PLACEHOLDER.match(summary.get("name") or ""))
        ),
        "notes": summary.get("notes"),
        "config": anchor["config"],
        "favorite": bool(summary.get("favorite", False)),
        "active": bool(summary.get("active", False)),
        "status": status_of(summary),
        "group": summary.get("group"),
        "member_of": summary.get("member_of"),
        "overlay": any(bool(r["summary"].get("overlay")) for r in runs),
        "runs": len(runs),
        "repeats": sum(1 for r in runs if r["summary"].get("outcome") == "repeat"),
        "first_saved": runs[0]["created_at"],
        "last_run": latest["created_at"],
        "latest": {
            "id": latest["id"],
            "created_at": latest["created_at"],
            "kpis": last.get("kpis") or {},
            "dates": last.get("dates") or [],
            "strategy": last.get("strategy") or [],
            "data_through": last.get("data_through") or ((last.get("dates") or [None])[-1]),
            "versions": last.get("versions"),
            "outcome": last.get("outcome"),
        },
        "change": change,
        "unreviewed": sum(1 for c in changes if c["needs_review"]),
    }


def list_strategies(
    con: duckdb.DuckDBPyConnection, dataset: str | None = None
) -> list[dict[str, Any]]:
    """One record per strategy (every dataset unless `dataset` is given), followed first, then
    newest run first. A group carries its members' strategies under `members` and they are not
    listed again at the top level."""
    runs = _all_runs(con, dataset)
    by_version: dict[str, list[dict[str, Any]]] = {}
    for run in runs:
        by_version.setdefault(run["version_id"], []).append(run)
    changes: dict[str, list[dict[str, Any]]] = {}
    for change in list_changes(con):
        changes.setdefault(change["version_id"], []).append(change)
    strategies = [_strategy(v, changes.get(k, [])) for k, v in by_version.items()]
    validated = _frozen_fingerprints()
    dated = [s["latest"]["data_through"] for s in strategies if s["latest"]["data_through"]]
    newest = max(dated) if dated else None
    for strategy in strategies:
        strategy["trust"] = None if strategy["group"] else _trust(strategy, validated, newest)
    by_anchor = {s["id"]: s for s in strategies}
    for strategy in strategies:
        if strategy["group"]:
            strategy["members"] = [by_anchor[m] for m in strategy["group"] if m in by_anchor]
    top = [s for s in strategies if not s["member_of"]]
    top.sort(key=lambda s: s["last_run"], reverse=True)
    top.sort(key=lambda s: s["status"] not in FOLLOWED)
    return top


def _strategy_runs(con: duckdb.DuckDBPyConnection, run_id: str) -> list[dict[str, Any]] | None:
    row = con.execute(
        "SELECT version_id, v.strategy_id FROM backtest_runs r "
        "JOIN strategy_versions v USING (version_id) WHERE r.run_id = ? AND r.kind = 'weekly'",
        [run_id],
    ).fetchone()
    if row is None:
        return None
    version_id, strategy_id = row
    return [
        r
        for r in _all_runs(con, strategy_id.removeprefix("momentum:"))
        if r["version_id"] == version_id
    ]


def _newest_data(con: duckdb.DuckDBPyConnection) -> str | None:
    """The newest `data_through` of any saved run: what "old data" is measured against."""
    row = con.execute(
        "SELECT max(COALESCE(r.summary ->> 'data_through', "
        "json_extract_string(r.summary, '$.dates[#-1]'))) FROM backtest_runs r "
        "JOIN strategy_versions v USING (version_id) JOIN strategies s USING (strategy_id) "
        "WHERE s.package = ? AND r.kind = 'weekly'",
        [PACKAGE],
    ).fetchone()
    return row[0] if row else None


def get_strategy(con: duckdb.DuckDBPyConnection, run_id: str) -> dict[str, Any] | None:
    """The strategy any of its runs belongs to, with its run history (newest first): each run's
    numbers, data and code fingerprints, outcome and, for a moved result, why it moved."""
    runs = _strategy_runs(con, run_id)
    if not runs:
        return None
    changes = list_changes(con, version_id=runs[0]["version_id"])
    strategy = _strategy(runs, changes)
    strategy["trust"] = (
        None if strategy["group"] else _trust(strategy, _frozen_fingerprints(), _newest_data(con))
    )
    if strategy["group"]:
        members = [get_strategy(con, member) for member in strategy["group"]]
        strategy["members"] = [m for m in members if m is not None]
    by_run = {c["run_id"]: c for c in changes}
    strategy["history"] = [
        {
            "id": r["id"],
            "created_at": r["created_at"],
            "n": r["summary"].get("n"),
            "name": r["summary"].get("name"),
            "kpis": r["summary"].get("kpis") or {},
            "data_through": r["summary"].get("data_through"),
            "versions": r["summary"].get("versions"),
            "outcome": r["summary"].get("outcome"),
            "change": by_run.get(r["id"]),
        }
        for r in reversed(runs)
    ]
    return strategy


def update_strategy(
    con: duckdb.DuckDBPyConnection, run_id: str, **changes: Any
) -> dict[str, Any] | None:
    """Rename, note, overlay or change the favourite state of the strategy `run_id` belongs to
    (applied to its anchor run, so the BL-051 rules hold unchanged)."""
    runs = _strategy_runs(con, run_id)
    if runs is None:
        return None
    anchor = _anchor(con, runs[0]["version_id"])
    if update_run(con, anchor[0], **changes) is None:
        return None
    return get_strategy(con, anchor[0])


def delete_strategy(con: duckdb.DuckDBPyConnection, run_id: str) -> bool:
    """Delete every run of the strategy. A group member cannot be deleted while its group
    exists; deleting a group keeps its members (`delete_run`'s rules)."""
    runs = _strategy_runs(con, run_id)
    if runs is None:
        return False
    version_id = runs[0]["version_id"]
    anchor = _anchor(con, version_id)
    if anchor[1].get("group"):
        return delete_run(con, anchor[0])
    for run in runs:  # any run in a group, not only the anchor: the group would name a lost run
        if run["summary"].get("member_of"):
            return delete_run(con, run["id"])  # refuses, naming the group
    con.execute("DELETE FROM backtest_runs WHERE version_id = ? AND kind = 'weekly'", [version_id])
    return True


# --- the one-time merge (BL-052) --------------------------------------------------------------


def merge_plan(con: duckdb.DuckDBPyConnection) -> dict[str, Any]:
    """What `apply_merge` would do: each strategy whose runs are spread over several versions
    (saved before versions were normalised), or whose runs lack an outcome. Nothing is written."""
    targets: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for run in _all_runs(con):
        summary = run["summary"]
        if summary.get("group"):
            continue
        fp = saved_identity.fingerprint(run["dataset"], run["config"])
        targets.setdefault((run["dataset"], fp), []).append(run)
    merges, conflicts = [], []
    for (dataset, fp), runs in targets.items():
        target = f"{_strategy_id(dataset)}:{fp}"
        moving = [r for r in runs if r["version_id"] != target]
        unscored = [r for r in runs[1:] if r["summary"].get("outcome") in (None, "new")]
        unscored += [r for r in runs[:1] if "outcome" not in r["summary"]]
        if not moving and not unscored:
            continue
        favourites = [r for r in runs if _is_favourite(r["summary"])]
        item = {
            "dataset": dataset,
            "fingerprint": fp,
            "version_id": target,
            "runs": [
                {"id": r["id"], "name": r["summary"].get("name"), "created_at": r["created_at"]}
                for r in runs
            ],
            "results": len(_results(runs)),
        }
        (conflicts if len(favourites) > 1 else merges).append(item)
    return {
        "merges": merges,
        "conflicts": conflicts,
        "runs": sum(len(m["runs"]) for m in merges),
        "strategies": len(merges),
    }


def _results(runs: list[dict[str, Any]]) -> list[int]:
    """Indexes of the runs (oldest first) whose result differs from the run before."""
    return [
        i
        for i, run in enumerate(runs)
        if i == 0 or not saved_identity.same_result(runs[i - 1]["summary"], run["summary"])
    ]


def apply_merge(con: duckdb.DuckDBPyConnection) -> dict[str, Any]:
    """Fold every strategy's runs into its normalised version, oldest first: give each run an
    outcome, a moved result a change row (label `unknown`: these runs recorded no fingerprints),
    and a placeholder name (`Run N`) an auto name. Deletes nothing; a strategy with two favourite
    runs is left as it is and reported. Running it again changes nothing."""
    plan = merge_plan(con)
    con.execute("BEGIN")
    try:
        for item in plan["merges"]:
            dataset = item["dataset"]
            ids = [r["id"] for r in item["runs"]]
            runs = [r for r in _all_runs(con, dataset) if r["id"] in ids]
            anchor = next((r for r in runs if _is_favourite(r["summary"])), runs[0])
            version_id = _ensure_version(con, dataset, item["fingerprint"], anchor["config"])
            # The anchor's own config, even if the version existed already: an older reader
            # (pre-BL-052 code still running) takes every run's config from here.
            con.execute(
                "UPDATE strategy_versions SET spec = ? WHERE version_id = ?",
                [json.dumps(anchor["config"], default=str), version_id],
            )
            previous = None
            for run in runs:
                summary = run["summary"]
                summary["fingerprint"] = item["fingerprint"]
                summary.setdefault("data_through", (summary.get("dates") or [None])[-1])
                summary.setdefault("name_typed", not _PLACEHOLDER.match(summary.get("name") or ""))
                # A run saved after BL-052 is "new" in its own version; once older runs join it,
                # it is compared like the rest.
                if "outcome" not in summary or (
                    summary["outcome"] == "new" and previous is not None
                ):
                    if previous is None:
                        summary["outcome"] = "new"
                    elif saved_identity.same_result(previous[1], summary):
                        summary["outcome"] = "repeat"
                    else:
                        summary["outcome"] = "new_result"
                        _insert_change(
                            con,
                            dataset,
                            version_id,
                            anchor["id"],
                            previous,
                            (run["id"], summary),
                            saved_identity.explain(dataset, previous[1], summary),
                        )
                con.execute(
                    "UPDATE backtest_runs SET version_id = ?, summary = ? WHERE run_id = ?",
                    [version_id, json.dumps(summary, default=str), run["id"]],
                )
                previous = (run["id"], summary)
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return plan
