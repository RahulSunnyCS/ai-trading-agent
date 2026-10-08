"""A favourite group's weekly signal, combined from its members' signals (BL-051).

A group (e.g. the Phase 6 ensemble) is several configs of one dataset, each a *sleeve* with its
own capital. They follow `choose.ensemble_curve`'s convention: equal capital at the last reset
(the last week before 1 April), never rebalanced against each other until the next reset. So the
group's portfolio weights a sleeve by its value since that reset, not by a flat 1/K.

Every member is still run and journalled on its own; this module only reads their signals and
writes the one message Telegram sends when the group is the headline. Pure: no I/O.
"""

from __future__ import annotations

from typing import Any

import pandas as pd

from .engine import CASH, IDLE
from .notify import Notification

#: The engine's parked-cash and liquid-fund assets: cash, never a holding.
IDLE_NAMES = frozenset({IDLE, CASH})
EPS = 5e-4
#: Engine actions that do not trade.
QUIET_ACTIONS = frozenset({"", "HOLD", "AT CAP", "WAIT"})


def reset_weeks(weeks: pd.DatetimeIndex) -> list[pd.Timestamp]:
    """Where equal capital is restored: the first week, then the last week before each 1 April."""
    aprils = [pd.Timestamp(f"{y}-04-01") for y in range(weeks[0].year, weeks[-1].year + 1)]
    resets = [weeks[0]] + [weeks[weeks < a][-1] for a in aprils if weeks[0] < a <= weeks[-1]]
    return sorted(set(resets))


def sleeve_value(dates: list[str], equity: list[float | None]) -> float | None:
    """A sleeve's value now relative to its last reset (1.0 = unchanged), from a payload's
    weekly `dates` and strategy curve. None if the curve is empty or does not line up with the
    dates (the group then weights this sleeve as unchanged)."""
    if not dates or len(dates) != len(equity):
        return None
    series = pd.Series(equity, index=pd.to_datetime(dates), dtype=float).dropna()
    if series.empty:
        return None
    start = reset_weeks(series.index)[-1]
    return float(series.iloc[-1] / series.loc[start])


def _held(weights: dict[str, float]) -> dict[str, float]:
    return {k: float(v) for k, v in (weights or {}).items() if k not in IDLE_NAMES and v}


def _target(signal: dict[str, Any]) -> dict[str, float]:
    """A sleeve's portfolio after this week's trades; `weights` when the dataset's signal does
    not say (an empty dict means it sold everything, so test for the key, not truthiness)."""
    return _held(signal["target_weights"] if "target_weights" in signal else signal.get("weights"))


def _mix(parts: list[tuple[float, dict[str, float]]]) -> dict[str, float]:
    total = sum(v for v, _ in parts)
    out: dict[str, float] = {}
    for value, weights in parts:
        for name, weight in weights.items():
            out[name] = out.get(name, 0.0) + value * weight / total
    return out


def combine(group: dict[str, Any], members: list[dict[str, Any]], week: str) -> dict[str, Any]:
    """The group's signal from its members' (`members`: each `{"id", "name", "signal"}`).

    `signal["weights"]` is a sleeve's portfolio before this week's trades, `target_weights` after
    them (Broad's engine signal; other datasets fall back to `weights`), `sleeve_value` its value
    since the last reset (missing = 1.0), `rebalance` its cadence. Returns the same shape as a
    member signal (`week`, `label`, `rows`, `weights`, `target_weights`) plus `sleeves`."""
    values = [float(m["signal"].get("sleeve_value") or 1.0) for m in members]
    before = _mix(
        [(v, _held(m["signal"].get("weights", {}))) for v, m in zip(values, members, strict=True)]
    )
    after = _mix([(v, _target(m["signal"])) for v, m in zip(values, members, strict=True)])
    acted: dict[str, list[str]] = {}
    # Each sleeve ranks within its own configuration (Broad: within its categories), so ranks
    # from different sleeves are not comparable: keep the best one from the sleeves that acted
    # on a name, else from any sleeve that ranks it.
    ranks: dict[str, float] = {}
    acted_ranks: dict[str, float] = {}
    for member in members:
        for row in member["signal"].get("rows", []):
            asset = row.get("asset")
            if asset is None or asset in IDLE_NAMES:
                continue
            rank = row.get("rank")
            has_rank = rank is not None and not pd.isna(rank)
            if has_rank:
                ranks[asset] = min(ranks.get(asset, rank), rank)
            if str(row.get("action") or "").upper() not in QUIET_ACTIONS:
                acted.setdefault(asset, []).append(member["id"])
                if has_rank:
                    acted_ranks[asset] = min(acted_ranks.get(asset, rank), rank)

    rows = []
    for asset in sorted(set(before) | set(after) | set(acted)):
        b, a = before.get(asset, 0.0), after.get(asset, 0.0)
        if asset in acted:
            if b <= EPS and a > EPS:
                action = "BUY"
            elif b > EPS and a <= EPS:
                action = "SELL"
            else:
                action = "ADD" if a > b else "TRIM"
        elif a > EPS:
            action = "HOLD"
        else:
            continue
        holders = [m["id"] for m in members if asset in _target(m["signal"])]
        rows.append(
            {
                "asset": asset,
                "action": action,
                "rank": acted_ranks.get(asset, ranks.get(asset)),
                # Held going into this week, as a member signal's rows say (Scores' Held mark).
                "held": b > EPS,
                "before": round(b, 4),
                "after": round(a, 4),
                "sleeves": sorted(set(holders) | set(acted.get(asset, []))),
            }
        )
    order = {"SELL": 0, "TRIM": 1, "BUY": 2, "ADD": 3, "HOLD": 4}
    rows.sort(key=lambda r: (order[r["action"]], r["rank"] if r["rank"] is not None else 1e9))
    sleeves = [
        {
            "id": m["id"],
            "name": m["name"],
            "value": round(v, 4),
            **(m["signal"].get("rebalance") or {"on_cadence": True, "every": 1, "next": None}),
        }
        for v, m in zip(values, members, strict=True)
    ]
    return {
        "week": week,
        "label": group["name"],
        "group": [m["id"] for m in members],
        "rows": rows,
        "weights": {k: round(v, 4) for k, v in before.items()},
        "target_weights": {k: round(v, 4) for k, v in after.items()},
        "cash": round(max(0.0, 1 - sum(after.values())), 4),
        "sleeves": sleeves,
    }


def _day(value: str | None) -> str:
    return pd.Timestamp(value).strftime("%d %b") if value else "?"


def _sleeve_label(sleeve: dict[str, Any], group_label: str) -> str:
    """A sleeve's name without the group's own name in front ("08c4307d (4w, ph1)")."""
    name = str(sleeve["name"])
    short = name.removeprefix(group_label).strip(" ·-") if name.startswith(group_label) else name
    if short == name and sleeve.get("every"):
        return f"{name} (every {sleeve['every']} wk)"
    return short or name


def notification(signal: dict[str, Any], run: str = "final") -> Notification:
    """The one Telegram message for a group headline: which sleeves trade, the combined trades
    with each name's share of the whole group after them, and what is held. A week no sleeve
    rebalances says so and when the next one does. No ranks: each sleeve ranks within its own
    configuration, so a rank is not comparable across the group."""
    label = signal["label"]
    trading = [s for s in signal["sleeves"] if s.get("on_cadence")]
    trades = [r for r in signal["rows"] if r["action"] != "HOLD"]
    held_after = [r for r in signal["rows"] if r["after"] > EPS]
    lines = [f"{label} · {len(signal['sleeves'])} sleeves"]
    if trading:
        lines.append("Sleeves trading: " + ", ".join(_sleeve_label(s, label) for s in trading))
    else:
        upcoming = sorted((s for s in signal["sleeves"] if s.get("next")), key=lambda s: s["next"])
        lines.append(
            "No sleeve rebalances this week."
            + (
                f" Next: {_sleeve_label(upcoming[0], label)} on {_day(upcoming[0]['next'])}."
                if upcoming
                else ""
            )
        )
    for row in trades:
        if row["action"] == "SELL":
            lines.append(f"• {row['asset']} — SELL (was {row['before']:.1%})")
        elif row["action"] == "BUY":
            lines.append(f"• {row['asset']} — BUY → {row['after']:.1%}")
        else:
            lines.append(
                f"• {row['asset']} — {row['action']} {row['before']:.1%} → {row['after']:.1%}"
            )
    if trading and not trades:
        lines.append("No trades this week.")
    held = f"{len(held_after)} name{'' if len(held_after) == 1 else 's'}"
    lines.append(f"Holds {held} after these trades · cash {signal['cash']:.1%}")
    return Notification(
        "momentum-weekly",
        "action_required" if trades else "info",
        f"Momentum {run.upper()} — {label} — week of {_day(signal['week'])} "
        f"{pd.Timestamp(signal['week']):%Y}",
        "\n".join(lines),
        type=f"momentum.{run}",
    )
