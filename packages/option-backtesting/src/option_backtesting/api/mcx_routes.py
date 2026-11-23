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
        {"as_of", "rules": [{"rule", "start_expiry", "pass_rule", "summary", "entries", "window",
         "spreads", "entry_contracts", "chain": {"ok", "problems"}}]}
        The forward paper tests, one block per frozen rule (BL-219 gold Dir in the expiry week,
        BL-242 silver Dir in the week before): the hash-chained journal as written (never edited),
        the running totals against the registered pass rule, the sessions of the coming window
        (journaled / waiting for data / still to come) and the entry-minute spread snapshots.

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


def _entry_row(e: dict, rule: mf.Rule) -> dict:
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
        "recorded_at",
        "trades",
        "notes",
    )
    return {**{k: e.get(k) for k in keep}, "future_at_entry": e.get(rule.spot_key)}


def _spreads(root_dir: Path, rule: mf.Rule) -> list[dict]:
    folder = mf.forward_dir(root_dir, rule) / "spread"
    out = []
    for path in sorted(folder.glob("*.json")) if folder.exists() else []:
        try:
            out.append({"day": path.stem, **json.loads(path.read_text())})
        except (OSError, ValueError):
            out.append({"day": path.stem, "error": "unreadable"})
    return out


def _window(root_dir: Path, today: date, done: set[str], rule: mf.Rule) -> dict | None:
    """The sessions of the nearest expiry's window from the rule's first scored expiry on."""
    cal = mcx_calendar(root_dir, rule.root)["options"]
    later = sorted(
        date.fromisoformat(e) for e in cal if date.fromisoformat(e) >= max(today, rule.start_expiry)
    )
    # the week-before window of an expiry ends before the expiry: once it has passed, the next
    # expiry's window is the one to show
    for expiry in later:
        collected = mf.option_days(root_dir, rule)
        days = mf.window(expiry, collected, today, rule)
        if days and days[-1] >= today:
            break
    else:
        return None
    sessions = []
    for d in days:
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


def forward_rule(root_dir: Path, today: date, rule: mf.Rule) -> dict:
    path = mf.journal_path(root_dir, rule)
    entries = journal.read(path)
    problems = journal.verify(path)
    return {
        "rule": {
            "key": rule.key,
            "root": rule.root,
            "label": rule.label,
            "cell": rule.cell_id,
            "grid_sha": mf.GRID_SHA,
            "entry": rule.entry,
            "strike": rule.strike,
            "sl": rule.sl,
            "reentry": rule.reentry,
            "week": "week before expiry" if rule.week_offset else "expiry week",
            "window_sessions": mf.WINDOW,
            "exits": mf.EXITS,
        },
        "start_expiry": rule.start_expiry.isoformat(),
        "pass_rule": {
            "expiries": rule.expiries_needed,
            "expiries_up": rule.expiries_up_needed,
            "slippage_pct": mf.SLIPPAGE_PCT,
        },
        "summary": mf.summary(root_dir, rule),
        "entries": [_entry_row(e, rule) for e in entries],
        "window": _window(root_dir, today, {e["day"] for e in entries}, rule),
        "spreads": _spreads(root_dir, rule),
        "entry_contracts": [f"{rule.strike}_CE", f"{rule.strike}_PE"],
        "chain": {"ok": not problems, "problems": problems},
    }


def forward(root_dir: Path, today: date) -> dict:
    return {
        "as_of": today.isoformat(),
        "rules": [forward_rule(root_dir, today, rule) for rule in mf.RULES.values()],
    }


def _today() -> date:
    return datetime.now(IST).date()


@router.get("/overview")
def get_overview() -> dict:
    return overview(tdb.data_root(), _today())


@router.get("/forward")
def get_forward() -> dict:
    return forward(tdb.data_root(), _today())
