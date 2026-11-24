"""Since your start: what each followed favourite has returned, and how far it has fallen, if its
lots had been put in the way yours were (Momentum › This week's Favourites table).

The model portfolio behind a favourite's weekly signal runs from 2017 and carries its own history,
so its holdings, and any return read off its curve, say nothing about money that began this
autumn. This module measures the start that matters instead: lot k is put in from cash on the
k-th Friday from `live_rules.toml`'s `stage.paper_start` as the sleeve that trades that Friday
(`live_rules.lot_sleeves`), each lot is its sleeve's backtest started that Friday, and the lots'
time-weighted index (`live_rules.twr_index`: a new lot adds money, not return) gives the return
and the fall from its peak. It is the same construction the BL-025 rules check uses for the
followed strategy, applied to every Paper and Invested favourite so they can be read side by side.

Model figures after the backtest's costs and tax rules, not fills. Nothing here trades or sends.
The result is stored (`since_start.json`, the state folder) by `mbt since-start refresh`, which the
Friday 21:30 rules job runs after its check; the week view only reads the file.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pandas as pd

from . import live_rules

FILE = "since_start.json"
FOLLOWED = ("paper", "invested")


def stats(index: pd.Series) -> dict[str, Any]:
    """Return since the first value and the worst fall from a running peak, of one index curve."""
    index = index.dropna()
    peak = index.cummax()
    return {
        "return": float(index.iloc[-1] / index.iloc[0] - 1),
        "max_drawdown": float((index / peak - 1).min()),
        "weeks": max(len(index) - 1, 0),
        "as_of": index.index[-1].date().isoformat(),
    }


def _curve(summary: dict) -> pd.Series:
    return pd.Series(
        summary["strategy"], index=pd.to_datetime(summary["dates"]), dtype="float64"
    ).dropna()


def favourite_stats(
    record: dict, members: list[dict], paper_start: str, run: Callable[[str, dict], dict]
) -> dict[str, Any]:
    """One favourite's since-start figures. `members` are a group's sleeves (their saved records),
    empty for a single saved run, which is one portfolio from `paper_start`. `run(dataset, config)`
    is `api.sleeve_summary`. A favourite that cannot be measured is `{"error": reason}`, never a
    figure."""
    dataset = (record.get("config") or members[0]["config"]).get("dataset", "broad")
    if not members:
        starts = [pd.Timestamp(live_rules.lot_starts(paper_start, 1)[0])]
        configs = [{"config": record["config"]}]
    else:
        configs = [
            {
                "config": m["config"],
                "rebalance_every": m["config"].get("rebalance_every") or 1,
                "rebalance_offset": m["config"].get("rebalance_offset") or 0,
            }
            for m in members
        ]
        starts = live_rules.lot_starts(paper_start, len(configs))
        try:
            configs = live_rules.lot_sleeves(starts, configs)  # type: ignore[assignment]
        except RuntimeError as error:
            return {"error": str(error)}
    lots: list[pd.Series] = []
    for start, cfg in zip(starts, configs, strict=True):
        body = {**cfg["config"], "start": str(start.date()), "split_fridays": False}
        try:
            curve = _curve(run(dataset, body))
        except Exception as error:  # the engine refuses a start with no week to show yet
            if "history" not in str(error).lower() and "no week" not in str(error).lower():
                return {"error": f"{type(error).__name__}: {error}"[:200]}
            continue  # put in this week: still cash
        if len(curve) >= 1:
            lots.append(curve / curve.iloc[0])
    if not lots:
        return {"error": "no lot has started yet"}
    return {"start": paper_start, **stats(live_rules.twr_index(lots))}


def compute(
    favourites: list[dict],
    groups: list[dict],
    paper_start: str,
    run: Callable[[str, dict], dict],
    echo: Callable[[str], None] = lambda _m: None,
) -> dict[str, Any]:
    """Every Paper and Invested favourite's figures, keyed by its saved-run id."""
    by_group = {g["id"]: g for g in groups}
    items: dict[str, Any] = {}
    for record in favourites:
        if record.get("status") not in FOLLOWED or record.get("member_of"):
            continue
        group = by_group.get(record["id"])
        members = group["members"] if group else []
        echo(f"{record.get('name')} ...")
        items[record["id"]] = {
            "name": record.get("name"),
            **favourite_stats(record, members, paper_start, run),
        }
    return {
        "paper_start": paper_start,
        "computed_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "items": items,
    }


def save(result: dict, state_dir: Path) -> None:
    state_dir.mkdir(parents=True, exist_ok=True)
    tmp = state_dir / (FILE + ".tmp")
    tmp.write_text(json.dumps(result, indent=2))
    tmp.replace(state_dir / FILE)


def load(state_dir: Path) -> dict | None:
    path = state_dir / FILE
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


def refresh(echo: Callable[[str], None] = print) -> dict[str, Any]:
    """Run every followed favourite and store the result: the body of `mbt since-start refresh`."""
    from . import api, runs_store
    from .db_read import read_catalog
    from .this_week import state_dir

    with read_catalog() as con:
        favourites = runs_store.list_favorites(con, include_groups=True)
        groups = runs_store.list_groups(con)
    result = compute(
        favourites, groups, live_rules.load()["stage"]["paper_start"], api.sleeve_summary, echo
    )
    save(result, state_dir())
    return result
