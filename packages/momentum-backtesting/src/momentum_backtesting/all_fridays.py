"""Following a strategy on every rebalance Friday (BL-056).

A config that rebalances every K weeks has K possible trading calendars (`rebalance_offset`
0..K-1), and which one it trades is luck. Followed on all Fridays it becomes one *group* (BL-051)
of K sleeves, one per calendar, each the same config with `capital / K`. The group already knows
how to combine its sleeves into one weekly signal and one Telegram message, and weights them by
their value since the last April reset, the rule the backtest's blend uses
(`tranches.blend_reset`).

This module plans and writes the sleeves; running a sleeve's backtest is the caller's job
(`run_sleeve`, from `api.sleeve_summary`), so no catalog connection is open while it computes.
Nothing here deletes a saved run.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import duckdb

from . import runs_store

#: BacktestRequest.capital's default, for a config saved without one.
DEFAULT_CAPITAL = 1_000_000.0

#: `(dataset, config) -> {"kpis", "dates", "strategy", "versions"}`: one sleeve's finished run.
SleeveRunner = Callable[[str, dict[str, Any]], dict[str, Any]]


def every_of(config: dict[str, Any]) -> int:
    """Weeks between rebalances for a weekly config; 1 for a monthly or missing cadence."""
    if config.get("rebalance", "weekly") != "weekly":
        return 1
    try:
        return max(1, int(config.get("rebalance_every") or 1))
    except (TypeError, ValueError):
        return 1


def is_split(config: dict[str, Any]) -> bool:
    """A config run "All Fridays" (`split_fridays`) where that does something."""
    return config.get("split_fridays") is True and every_of(config) > 1


def is_single_friday(config: dict[str, Any]) -> bool:
    """A slower-cadence config on one Friday: what the migration moves to all Fridays."""
    return every_of(config) > 1 and config.get("split_fridays") is not True


def sleeve_configs(config: dict[str, Any]) -> list[dict[str, Any]]:
    """One config per calendar phase: the same settings, one Friday set, `capital / K`."""
    every = every_of(config)
    capital = float(config.get("capital") or DEFAULT_CAPITAL) / every
    return [
        {**config, "split_fridays": False, "rebalance_offset": offset, "capital": capital}
        for offset in range(every)
    ]


@dataclass(frozen=True)
class Plan:
    """What following one strategy on all Fridays would save."""

    run_id: str  # the strategy's anchor run
    dataset: str
    name: str  # the strategy's name; the group is "<name> · all Fridays"
    config: dict[str, Any]
    status: str | None  # its current favourite status, or None
    group: str | None = None  # the group already following it on all Fridays
    active: bool = False  # it is the headline favourite (a group then takes over as the headline)


def plan_for_new(con: duckdb.DuckDBPyConnection, run_id: str) -> Plan | None:
    """A strategy run "All Fridays": to follow (no `group`), or already followed (`group`: its
    group, so a second request changes that group instead of making another). None for anything
    else (not found, not a split run, already a favourite, a group or a group member)."""
    found = runs_store.strategy_anchor(con, run_id)
    if found is None:
        return None
    anchor_id, summary, config, dataset = found
    if runs_store.is_favourite(summary) or not is_split(config):
        return None
    group = summary.get("followed_by")
    still = group if group and runs_store.status_of(_summary(con, group) or {}) else None
    return Plan(anchor_id, dataset, str(summary.get("name") or anchor_id[:8]), config, None, still)


def _summary(con: duckdb.DuckDBPyConnection, run_id: str) -> dict[str, Any] | None:
    found = runs_store.strategy_anchor(con, run_id)
    return found[1] if found else None


def migration_plans(con: duckdb.DuckDBPyConnection) -> list[Plan]:
    """Every favourite that follows one Friday of a slower cadence: not a group, not a member,
    not already split."""
    return [
        Plan(
            record["id"],
            record["config"].get("dataset") or _dataset_of(con, record["id"]),
            str(record["name"]),
            record["config"],
            record["status"],
            active=bool(record["active"]),
        )
        for record in runs_store.list_favorites(con)
        if not record["member_of"] and is_single_friday(record["config"])
    ]


def _dataset_of(con: duckdb.DuckDBPyConnection, run_id: str) -> str:
    found = runs_store.strategy_anchor(con, run_id)
    return found[3] if found else ""


def group_name(plan: Plan, name: str | None = None) -> str:
    return (name or f"{plan.name} · all Fridays").strip()


def run_sleeves(
    plan: Plan, run_sleeve: SleeveRunner
) -> list[tuple[dict[str, Any], dict[str, Any]]]:
    """Every sleeve's config with its finished run. Holds no catalog connection."""
    return [(config, run_sleeve(plan.dataset, config)) for config in sleeve_configs(plan.config)]


def follow(
    con: duckdb.DuckDBPyConnection,
    plan: Plan,
    sleeves: list[tuple[dict[str, Any], dict[str, Any]]],
    *,
    status: str = "watching",
    active: bool = False,
    name: str | None = None,
    release: str | None = None,
) -> dict[str, Any]:
    """Save the sleeves and group them; returns the group's record. `release` is a single-Friday
    favourite this replaces: it stops being a favourite first (its saved run is kept), and is
    restored if the group cannot be made. A followed status that no slot is free for is refused
    before anything is written."""
    label = group_name(plan, name)
    if status in runs_store.FOLLOWED:
        runs_store.ensure_followed_slot(con, frozenset({release} if release else ()))
    released = None
    if release:
        released = runs_store.update_run(con, release, status="none")
    saved: list[str] = []
    try:
        for offset, (config, result) in enumerate(sleeves):
            record = runs_store.save_run(
                con,
                plan.dataset,
                name=f"{label} · Friday {offset + 1} of {len(sleeves)}",
                config=config,
                kpis=result["kpis"],
                dates=result["dates"],
                strategy=result["strategy"],
                versions=result.get("versions"),
            )
            saved.append(record["id"])
        group = runs_store.create_group(con, label, saved)
        if not release:  # the all-Fridays run itself stays a saved run; remember its group
            runs_store.annotate(con, plan.run_id, followed_by=group["id"])
        if status != "watching" or active:
            group = (
                runs_store.update_run(
                    con, group["id"], status=status, active=True if active else None
                )
                or group
            )
        return group
    except Exception:
        for run_id in saved:
            runs_store.delete_run(con, run_id)
        if release and released is not None:
            runs_store.update_run(
                con, release, status=released["status"] or plan.status or "watching"
            )
        raise
