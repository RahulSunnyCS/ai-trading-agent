"""Where each trip came from: the tool's lists, the owner's own algos, or a manual trade.

The 15:40 live capture (BL-141, `rotation/live/<day>.jsonl`) lists every strategy that ran on
each platform and broker, the tool's (`source: tool`, with its `book`) and the owner's own
(`discretionary`). Where a strategy carries its fills (AlgoTest), a trip is matched to it by
contract and entry minute (within `ENTRY_SLACK_MIN`):

- `adaptive-core` / `t1`: a tool strategy of that book;
- `own-algo`: one of the owner's own strategies;
- `manual`: nothing on any platform matches, and every strategy that traded on the broker that
  day carried its fills (so a match would have been found);
- `unattributed`: no match, but some strategy that traded on the broker shows no fills (Quantiply
  gives only its P&L), so the trip may be that strategy's;
- `unknown`: no capture for the day (before 2026-10-19, or a day it missed).
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime
from functools import lru_cache
from pathlib import Path

from .trips import Trip

ENTRY_SLACK_MIN = 2
SYMBOL = re.compile(r"^([A-Z]+?)\d{2}[A-Z0-9]{3}(\d+)(CE|PE)$")


@lru_cache(maxsize=64)
def _capture(root: Path, day: date) -> tuple[dict, ...] | None:
    path = root / "rotation" / "live" / f"{day}.jsonl"
    if not path.exists():
        return None
    out = []
    for text in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(text)
        except json.JSONDecodeError:
            continue
        if row.get("kind") == "strategy" and row.get("traded"):
            out.append(row)
    return tuple(out)


def _minutes(at: str) -> int | None:
    try:
        t = datetime.fromisoformat(at.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None
    if t.tzinfo is not None:
        from zoneinfo import ZoneInfo

        t = t.astimezone(ZoneInfo("Asia/Kolkata"))
    return t.hour * 60 + t.minute


def _label(strategy: dict) -> str:
    if strategy.get("source") == "tool":
        return {"core": "adaptive-core", "t1": "t1"}.get(strategy.get("book"), "adaptive-core")
    return "own-algo"


def source_of(root: Path, trip: Trip) -> dict:
    strategies = _capture(root, trip.day)
    if strategies is None:
        return {"source": "unknown", "strategy": None}
    mine = [s for s in strategies if s.get("broker") == trip.broker]
    entry = None
    if trip.entry_time:
        h, m, *_ = (int(x) for x in trip.entry_time.split(":"))
        entry = h * 60 + m
    for s in mine:
        for f in s.get("fills") or []:
            m = SYMBOL.match(str(f.get("symbol", "")))
            if not m or m.group(1) != trip.underlying or m.group(3) != trip.kind:
                continue
            if trip.strike is None or float(m.group(2)) != trip.strike:
                continue
            at = _minutes((f.get("entry") or {}).get("at", ""))
            if entry is not None and at is not None and abs(at - entry) > ENTRY_SLACK_MIN:
                continue
            return {"source": _label(s), "strategy": s.get("name")}
    if any(not s.get("fills") for s in mine):
        return {"source": "unattributed", "strategy": None}
    return {"source": "manual", "strategy": None}
