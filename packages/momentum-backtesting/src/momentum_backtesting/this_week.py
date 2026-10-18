"""Momentum › This week (BL-051): every favourite's signal for one week, from the journal.

The forward journal (BL-024) is the source: it holds what each favourite (and each group sleeve)
said, run by run, and survives restarts, which the in-memory weekly job does not. A group's card
is rebuilt from its sleeves' entries with `groups.combine`, the same function the Telegram message
uses. The message itself is kept by the weekly run (`save_message`), since the journal records
signals, not what was sent.

Pure apart from the message file: the API passes in the journal rows and the favourites.
"""

from __future__ import annotations

import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any

import pandas as pd

from . import groups as groups_mod
from .notify import IST

MESSAGES_FILE = "weekly_messages.json"
#: Overrides where the message and live-rules files live; the tests point it at a temp folder so
#: they never touch the real `data/`.
STATE_DIR_ENV = "MOMENTUM_STATE_DIR"
KEEP_MESSAGES = 40
#: The Friday the owner's own portfolio starts from nothing (a one-line JSON file in the state
#: folder): that week every held name is a buy, and each group's sleeves are numbered from it.
PAPER_START_FILE = "paper_start.json"
#: Names shown in each "at the edge" list.
EDGE_COUNT = 3


# --- the Friday message --------------------------------------------------------------------------


def state_dir() -> Path:
    """Where This week's small state files live: the package's `data/` folder."""
    import os

    from .config import DATA_DIR

    override = os.environ.get(STATE_DIR_ENV)
    return Path(override) if override else DATA_DIR


def paper_start(data_dir: Path | None = None) -> str | None:
    """The Friday ('YYYY-MM-DD') the owner's portfolio starts from nothing, or None."""
    try:
        week = json.loads(((data_dir or state_dir()) / PAPER_START_FILE).read_text()).get("week")
    except (FileNotFoundError, ValueError, AttributeError):
        return None
    return str(week) if week else None


def set_paper_start(week: str | None, data_dir: Path | None = None) -> str | None:
    """Record (or, with None, clear) the paper start Friday. Must be a Friday."""
    path = (data_dir or state_dir()) / PAPER_START_FILE
    if week is None:
        path.unlink(missing_ok=True)
        return None
    day = pd.Timestamp(week)
    if day.dayofweek != 4:
        raise ValueError(f"{week} is not a Friday.")
    path.write_text(json.dumps({"week": day.strftime("%Y-%m-%d")}))
    return day.strftime("%Y-%m-%d")


def save_message(
    data_dir: Path,
    *,
    week: str | None,
    run: str,
    title: str,
    body: str,
    sent: bool,
    headline: str | None,
    now: datetime | None = None,
) -> None:
    """Keep the message a weekly run produced for the headline (sent or not), newest last."""
    path = data_dir / MESSAGES_FILE
    messages = load_messages(data_dir)
    messages.append(
        {
            "week": week,
            "run": run,
            "title": title,
            "body": body,
            "sent": sent,
            "headline": headline,
            "at": (now or datetime.now(IST)).isoformat(timespec="seconds"),
        }
    )
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(messages[-KEEP_MESSAGES:], indent=1))
    tmp.replace(path)


def load_messages(data_dir: Path) -> list[dict[str, Any]]:
    try:
        messages = json.loads((data_dir / MESSAGES_FILE).read_text())
    except (FileNotFoundError, ValueError):
        return []
    return messages if isinstance(messages, list) else []


def message_for(messages: list[dict[str, Any]], week: str) -> dict[str, Any] | None:
    """The newest message for `week` that was sent, else the newest one at all."""
    for_week = [m for m in messages if m.get("week") == week]
    sent = [m for m in for_week if m.get("sent")]
    return (sent or for_week or [None])[-1]


# --- the week's view -----------------------------------------------------------------------------


def _latest(rows: list[dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    """The newest entry per (config, run) - a correction replaces what it corrects."""
    latest: dict[tuple[str, str], dict[str, Any]] = {}
    for row in sorted(rows, key=lambda r: r["entry_id"]):
        latest[(row["config_id"], row["run_kind"])] = row
    return latest


def _signal(row: dict[str, Any]) -> dict[str, Any]:
    signal = row["signal"]
    return json.loads(signal) if isinstance(signal, str) else signal


def _exit_rank(config: dict[str, Any]) -> int | None:
    """The single rank a held name is sold below, when the strategy has one. Broad in category
    mode sells on its category and pool ranks too, so no one number says how close a name is."""
    dataset = config.get("dataset", "etf")
    if dataset == "broad":
        if str(config.get("broad_category_mode", "off")) == "on":
            return None
        value = config.get("broad_off_exit_rank")
    else:
        value = config.get("exit_rank")
    return int(value) if isinstance(value, int | float) and value > 0 else None


def _held_after(signal: dict[str, Any]) -> set[str]:
    weights = signal["target_weights"] if "target_weights" in signal else signal.get("weights")
    return {k for k, v in (weights or {}).items() if k not in groups_mod.IDLE_NAMES and v}


def _rows(signal: dict[str, Any], previous: dict[str, Any] | None) -> list[dict[str, Any]]:
    """A favourite's actionable and held rows, with last week's rank beside this week's."""
    before = {
        r.get("asset"): r.get("rank") for r in (previous or {}).get("rows", []) if r.get("asset")
    }
    target = signal.get("target_weights") or signal.get("weights") or {}
    out = []
    for row in signal.get("rows", []):
        asset = row.get("asset")
        if asset is None or asset in groups_mod.IDLE_NAMES:
            continue
        raw_action = str(row.get("action") or "")
        action = raw_action.upper()
        held = bool(row.get("held"))
        if not action and not held and asset not in target:
            continue
        rank = row.get("rank")
        if action.startswith("SKIP"):
            # A gate label ("SKIP (premium)", BL-136) keeps its case: a sentence, not a verb.
            shown = raw_action
        elif action in groups_mod.QUIET_ACTIONS:
            shown = "HOLD" if held or asset in target else action
        else:
            shown = action
        out.append(
            {
                "asset": asset,
                "action": shown,
                "rank": None if rank is None or pd.isna(rank) else rank,
                "rank_prev": row.get("previous_rank", before.get(asset)),
                "held": held,
                "after": target.get(asset),
                "sleeves": None,
                # Why a name was not bought (a gate's row), and the ETF's premium to NAV.
                **{k: row[k] for k in ("reason", "premium", "premium_limit") if k in row},
            }
        )
    return out


def _edge(signal: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    """The weakest names held by rank, and the strongest not held: next week's likely trades."""
    rows = [r for r in signal.get("rows", []) if r.get("asset") not in groups_mod.IDLE_NAMES]
    ranked = [r for r in rows if r.get("rank") is not None and not pd.isna(r.get("rank"))]
    held = _held_after(signal)
    weakest = sorted((r for r in ranked if r["asset"] in held), key=lambda r: -r["rank"])
    strongest = sorted((r for r in ranked if r["asset"] not in held), key=lambda r: r["rank"])

    def brief(r: dict[str, Any]) -> dict[str, Any]:
        return {"asset": r["asset"], "rank": r["rank"], "rank_prev": r.get("previous_rank")}

    return {
        "weakest_held": [brief(r) for r in weakest[:EDGE_COUNT]],
        "strongest_not_held": [brief(r) for r in strongest[:EDGE_COUNT]],
    }


def _preview_diff(preview: dict[str, Any] | None, final: dict[str, Any]) -> dict | None:
    """What the final changed against the preview's trades (ETF favourites have a preview)."""
    if preview is None:
        return None

    def trades(signal: dict[str, Any]) -> dict[str, str]:
        return {
            r["asset"]: str(r.get("action")).upper()
            for r in signal.get("rows", [])
            if str(r.get("action") or "").upper() not in groups_mod.QUIET_ACTIONS
        }

    before, after = trades(preview), trades(final)
    return {
        "added": [{"asset": a, "action": act} for a, act in after.items() if before.get(a) != act],
        "dropped": [{"asset": a, "action": act} for a, act in before.items() if a not in after],
    }


_SLEEVE_NAME = re.compile(r"Friday \d+ of \d+$")
_SLEEVE_NUMBER = re.compile(r"Friday (\d+) of \d+$")


def sleeve_number(name: str) -> int | None:
    """The n of a sleeve's "Friday n of K" suffix, or None when it has none."""
    found = _SLEEVE_NUMBER.search(name)
    return int(found.group(1)) if found else None


def sort_sleeves(sleeves: list[dict[str, Any]]) -> None:
    """Order sleeve dicts by their "Friday n of K" number, those without one last."""
    sleeves.sort(key=lambda s: sleeve_number(str(s["name"])) or 99)


def sleeve_label(name: str, week: str, start: str, rebalance: dict[str, Any] | None) -> str | None:
    """A sleeve's name numbered from the paper start (None when it has no cadence or no
    "Friday n of K" suffix): the sleeve that trades on `start` is "Friday 1 of K". `rebalance` is
    the signal's cadence (`on_cadence`, `every`, `next`)."""
    every = (rebalance or {}).get("every")
    if not every or every <= 1 or not _SLEEVE_NAME.search(name):
        return None
    trades_on = week if rebalance.get("on_cadence") else rebalance.get("next")
    if not trades_on:
        return None
    gap = (pd.Timestamp(trades_on) - pd.Timestamp(start)).days // 7
    return _SLEEVE_NAME.sub(f"Friday {gap % every + 1} of {every}", name)


def _renumber_sleeves(card: dict[str, Any], week: str, start: str) -> None:
    """Number a group's sleeves from the paper start: the sleeve that trades on the start Friday
    is "Friday 1 of K", the one after it "Friday 2 of K". The saved runs keep their names (and
    ids, which the journal keys on); only what the page shows changes."""
    sleeves = card.get("sleeves") or []
    names: dict[str, str] = {}
    for sleeve in sleeves:
        label = sleeve_label(str(sleeve["name"]), week, start, sleeve)
        if label:
            names[sleeve["name"]] = label
            sleeve["name"] = label
    if names:
        sort_sleeves(sleeves)
    edge = card.get("edge")
    if edge and edge.get("sleeve") in names:
        edge["sleeve"] = names[edge["sleeve"]]


def first_week_actions(signal: dict[str, Any]) -> list[dict[str, Any]]:
    """The paper start Friday as a journal entry shows it: a buy for every name the signal holds
    afterwards, best rank first (nothing is held going into the first week)."""
    weights = signal.get("target_weights") or signal.get("weights") or {}
    ranks = {r.get("asset"): r.get("rank") for r in signal.get("rows", [])}
    held = [a for a, w in weights.items() if w and a not in groups_mod.IDLE_NAMES]
    held.sort(key=lambda a: (ranks.get(a) is None, ranks.get(a) or 0, a))
    return [{"asset": a, "action": "BUY", "rank": ranks.get(a)} for a in held]


def _start_from_cash(card: dict[str, Any]) -> None:
    """The first week of a portfolio: nothing is held, so every name the strategy holds after
    the week is a buy and nothing is sold (the rows' `after` weights are unchanged)."""
    rows = []
    for row in card["rows"]:
        if not (row.get("after") or 0) > 0:
            continue
        rows.append({**row, "action": "BUY", "held": False, "before": 0.0, "rank_prev": None})
    card["rows"] = rows
    card["first_week"] = True


def week_view(
    week: str,
    rows: list[dict[str, Any]],
    previous_rows: list[dict[str, Any]],
    favourites: list[dict[str, Any]],
    group_records: list[dict[str, Any]],
    start_week: str | None = None,
) -> list[dict[str, Any]]:
    """One card per favourite (groups and ungrouped favourites; sleeves appear inside their
    group), headline first, from the journal rows of `week` and of the week before. From
    `start_week` (the paper start) groups' sleeves are numbered from it, and on that Friday every
    card starts from nothing held."""
    latest, previous = _latest(rows), _latest(previous_rows)

    def entry(config_id: str) -> tuple[dict[str, Any] | None, str | None, str | None]:
        for kind in ("final", "preview"):
            row = latest.get((config_id, kind))
            if row is not None:
                return _signal(row), kind, row["recorded_at"]
        return None, None, None

    def prior(config_id: str) -> dict[str, Any] | None:
        row = previous.get((config_id, "final"))
        return _signal(row) if row is not None else None

    cards = []
    for group in group_records:
        member_signals = []
        missing = []
        kinds, recorded = set(), []
        for member in group.get("members", []):
            signal, kind, at = entry(member["id"])
            if signal is None:
                missing.append(member["name"])
                continue
            kinds.add(kind)
            recorded.append(at)
            member_signals.append({"id": member["id"], "name": member["name"], "signal": signal})
        card = _card(group, group["config"].get("dataset", "etf"))
        card["sleeves"] = [
            {"id": m["id"], "name": m["name"], "config": m["config"]} for m in group["members"]
        ]
        if missing:
            card["blocked"] = (
                f"Not recorded yet for {len(missing)} of {len(group['members'])} sleeves: "
                + ", ".join(missing)
            )
        elif member_signals:
            combined = groups_mod.combine(group, member_signals, week)
            card["run"] = "final" if kinds == {"final"} else "preview"
            card["recorded_at"] = max(recorded)
            card["sleeves"] = combined["sleeves"]
            card["rows"] = combined["rows"]
            card["cash"] = combined["cash"]
            card["held"] = sorted(r["asset"] for r in combined["rows"] if r["after"] > 0)
            # The sleeve(s) that trade next are the ones whose edge names matter next.
            upcoming = sorted(
                (s for s in combined["sleeves"] if s.get("next")), key=lambda s: s["next"]
            )
            if upcoming:
                nxt = next(m for m in member_signals if m["id"] == upcoming[0]["id"])
                card["edge"] = {
                    "sleeve": upcoming[0]["name"],
                    "on": upcoming[0]["next"],
                    **_edge(nxt["signal"]),
                }
        cards.append(card)

    for favourite in favourites:
        if favourite.get("member_of") or favourite.get("group"):
            continue
        card = _card(favourite, favourite["config"].get("dataset", "etf"))
        signal, kind, at = entry(favourite["id"])
        if signal is None:
            card["blocked"] = "Not recorded yet this week."
        else:
            card["run"], card["recorded_at"] = kind, at
            card["rows"] = _rows(signal, prior(favourite["id"]))
            card["held"] = sorted(_held_after(signal))
            card["exit_rank"] = _exit_rank(favourite["config"])
            card["explain"] = signal.get("explain")
            card["edge"] = {"sleeve": None, "on": None, **_edge(signal)}
            if kind == "final":
                preview = latest.get((favourite["id"], "preview"))
                card["since_preview"] = _preview_diff(
                    _signal(preview) if preview is not None else None, signal
                )
        cards.append(card)

    if start_week and week >= start_week:
        for card in cards:
            _renumber_sleeves(card, week, start_week)
            if week == start_week and not card["blocked"]:
                _start_from_cash(card)
    headline = next((c for c in cards if c["headline"]), None)
    shared = set(headline["held"]) if headline else set()
    for card in cards:
        card["trades"] = sum(1 for r in card["rows"] if r["action"] not in ("", "HOLD"))
        card["shared_with_headline"] = (
            None if card is headline or not headline else len(shared & set(card["held"]))
        )
    order = {"invested": 0, "paper": 1, "watching": 2, None: 3}
    cards.sort(key=lambda c: (not c["headline"], order.get(c["status"], 3), c["name"]))
    return cards


def _card(record: dict[str, Any], dataset: str) -> dict[str, Any]:
    return {
        "id": record["id"],
        "name": record["name"],
        "status": record.get("status"),
        "headline": bool(record.get("active")),
        "dataset": dataset,
        "group": bool(record.get("group")),
        "sleeves": None,
        "run": None,
        "recorded_at": None,
        "blocked": None,
        "rows": [],
        "held": [],
        "cash": None,
        "exit_rank": None,
        "explain": None,
        "edge": None,
        "since_preview": None,
        "first_week": False,
    }
