"""`/legwise/mcx/*`: what the dashboard's Commodity Lab reads. Read-only; nothing here writes.

    GET /legwise/mcx/overview
        {"as_of", "roots": [{root, name, point_value, nearest_expiry, future, weekdays_to_expiry,
          upcoming, calendar_ends, days_collected, first_day, last_day, days_last_30}],
         "errors": [...]}
        The four mini contracts the BL-218 sweep covered: when each next expires, which future it
        settles on, and what the collector has put in the lake. Only GOLDM's contract calendar is
        extended past the sweep (the forward test does it), so another root shows no next expiry
        and says where its calendar ends, never a guess.

    GET /legwise/mcx/forward
        {"rule", "start_expiry", "pass_rule", "summary", "entries", "window", "spreads",
         "chain": {"ok", "problems"}}
        The BL-219 forward paper test of GOLDM Dir in the expiry week: the hash-chained journal as
        written (never edited), the running totals against the registered pass rule, the sessions
        of the coming expiry window (journaled / waiting for data / still to come) and the 18:00
        spread snapshots.

A root that cannot be read comes back with its reason in `errors`; the others still answer.
"""

from __future__ import annotations

import json
from datetime import date, datetime, timedelta
from pathlib import Path

from fastapi import APIRouter
from trading_data import db as tdb
from trading_data import lake

from .. import mcx_forward as mf
from ..fyers.symbols import IST
from ..legwise.market import mcx_calendar
from ..rotation import journal

router = APIRouter(prefix="/legwise/mcx")

#: The BL-218 universe: the four minis, with the rupees one point is worth on one lot.
ROOTS: tuple[tuple[str, str, float], ...] = (
    ("GOLDM", "Gold mini", 10.0),
    ("SILVERM", "Silver mini", 5.0),
    ("CRUDEOILM", "Crude oil mini", 10.0),
    ("NATGASMINI", "Natural gas mini", 250.0),
)

#: The registered pass rule (BL-219), shown beside the running totals.
PASS_RULE = {"expiries": 6, "expiries_up": 4, "slippage_pct": mf.SLIPPAGE_PCT}


def _weekdays_between(start: date, end: date) -> int:
    """Weekdays after `start` up to and including `end` (0 when `end` is not later)."""
    n, day = 0, start
    while day < end:
        day += timedelta(days=1)
        if day.weekday() < 5:
            n += 1
    return n


def _root_row(root_dir: Path, root: str, name: str, point_value: float, today: date) -> dict:
    cal = mcx_calendar(root_dir, root)["options"]
    expiries = sorted(date.fromisoformat(e) for e in cal)
    later = [e for e in expiries if e >= today]
    days = lake.available_days(root_dir, "option", root)
    nearest = later[0] if later else None
    return {
        "root": root,
        "name": name,
        "point_value": point_value,
        "nearest_expiry": nearest.isoformat() if nearest else None,
        "future": cal[nearest.isoformat()] if nearest else None,
        "weekdays_to_expiry": _weekdays_between(today, nearest) if nearest else None,
        "upcoming": [e.isoformat() for e in later[:4]],
        "calendar_ends": expiries[-1].isoformat() if expiries else None,
        "days_collected": len(days),
        "first_day": days[0].isoformat() if days else None,
        "last_day": days[-1].isoformat() if days else None,
        "days_last_30": sum(1 for d in days if (today - d).days <= 30),
    }


def overview(root_dir: Path, today: date) -> dict:
    rows, errors = [], []
    for root, name, point_value in ROOTS:
        try:
            rows.append(_root_row(root_dir, root, name, point_value, today))
        except Exception as error:  # noqa: BLE001 - the page says why; the other roots answer
            errors.append(f"{root}: {type(error).__name__}: {error}")
    return {"as_of": today.isoformat(), "roots": rows, "errors": errors}


def _entry_row(e: dict) -> dict:
    keep = (
        "day",
        "expiry",
        "k",
        "season",
        "gross",
        "charges",
        "net",
        "net_0.5pct",
        "net_0pct",
        "stopped_by",
        "future_at_18",
        "recorded_at",
        "trades",
        "notes",
    )
    return {k: e.get(k) for k in keep}


def _spreads(root_dir: Path) -> list[dict]:
    folder = mf.forward_dir(root_dir) / "spread"
    out = []
    for path in sorted(folder.glob("*.json")) if folder.exists() else []:
        try:
            out.append({"day": path.stem, **json.loads(path.read_text())})
        except (OSError, ValueError):
            out.append({"day": path.stem, "error": "unreadable"})
    return out


def _window(root_dir: Path, today: date, done: set[str]) -> dict | None:
    """The sessions of the nearest expiry's window from the first scored expiry on."""
    cal = mcx_calendar(root_dir, mf.ROOT)["options"]
    later = sorted(
        date.fromisoformat(e) for e in cal if date.fromisoformat(e) >= max(today, mf.START_EXPIRY)
    )
    if not later:
        return None
    expiry = later[0]
    collected = mf.option_days(root_dir)
    sessions = []
    for d in mf.window(expiry, collected, today):
        if d.isoformat() in done:
            state = "journaled"
        elif d > today:
            state = "to come"
        elif d in collected:
            state = "ready to score"
        elif d == today:
            state = "today"
        else:
            state = "waiting for data"
        sessions.append({"day": d.isoformat(), "state": state, "k": (expiry - d).days})
    return {"expiry": expiry.isoformat(), "sessions": sessions}


def forward(root_dir: Path, today: date) -> dict:
    path = mf.journal_path(root_dir)
    entries = journal.read(path)
    problems = journal.verify(path)
    return {
        "as_of": today.isoformat(),
        "rule": {
            "root": mf.ROOT,
            "cell": mf.CELL_ID,
            "grid_sha": mf.GRID_SHA,
            "window_sessions": mf.WINDOW,
            "exits": mf.EXITS,
        },
        "start_expiry": mf.START_EXPIRY.isoformat(),
        "pass_rule": PASS_RULE,
        "summary": mf.summary(root_dir),
        "entries": [_entry_row(e) for e in entries],
        "window": _window(root_dir, today, {e["day"] for e in entries}),
        "spreads": _spreads(root_dir),
        "chain": {"ok": not problems, "problems": problems},
    }


def _today() -> date:
    return datetime.now(IST).date()


@router.get("/overview")
def get_overview() -> dict:
    return overview(tdb.data_root(), _today())


@router.get("/forward")
def get_forward() -> dict:
    return forward(tdb.data_root(), _today())
