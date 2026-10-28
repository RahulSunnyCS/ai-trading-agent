"""Where each trip came from: the tool's lists, the owner's own algos, or a manual trade.

The 15:40 live capture (BL-141, `rotation/live/<day>.jsonl`) lists every strategy that ran on
each platform and broker, the tool's (`source: tool`, with its `book`) and the owner's own
(`discretionary`). Where a strategy carries its fills (AlgoTest), a trip is matched to a fill of
the same broker, underlying, strike, CE/PE, expiry (when the symbol gives it) and side (a short
trip's opening fill is a sell), entered within `ENTRY_SLACK_MIN` of the trip's entry. A fill
labels one trip at most.

- `adaptive-core` / `t1`: a tool strategy of that book;
- `own-algo`: one of the owner's own strategies;
- `manual`: nothing matches, and every strategy that traded on the broker that day carried its
  fills and its capture section read cleanly (so a match would have been found);
- `unattributed`: no match, and something could hide one — a strategy with no fills (Quantiply
  gives only its P&L), a capture section that failed, or a trip with no entry time (summary rows);
- `unknown`: no capture for the day the trip opened (before 2026-10-19, or a day it missed).

The capture file is read afresh on every call (no cache: a back-fill must be seen).
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from .trips import Trip

ENTRY_SLACK_MIN = 2
IST = ZoneInfo("Asia/Kolkata")
# NIFTY26O2722400PE (weekly: YY, month 1-9/O/N/D, DD) or NIFTY26OCT22400PE (monthly).
SYMBOL = re.compile(r"^([A-Z]+?)(\d{2})([1-9OND])(\d{2})(\d+)(CE|PE)$")
MONTHLY = re.compile(r"^([A-Z]+?)(\d{2})([A-Z]{3})(\d+)(CE|PE)$")
MONTH_CODE = {**{str(i): i for i in range(1, 10)}, "O": 10, "N": 11, "D": 12}
MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]


def _read(root: Path, day: date) -> tuple[list[dict], set[str]] | None:
    """The day's traded strategies, and the brokers whose capture section failed."""
    path = root / "rotation" / "live" / f"{day}.jsonl"
    if not path.exists():
        return None
    strategies, failed = [], set()
    for text in path.read_text(encoding="utf-8").splitlines():
        try:
            row = json.loads(text)
        except json.JSONDecodeError:
            continue
        if row.get("kind") == "section" and not row.get("ok"):
            failed.add(row.get("broker"))
        elif row.get("kind") == "strategy" and row.get("traded"):
            strategies.append(row)
    return strategies, failed


def parse_symbol(symbol: str) -> dict | None:
    """A platform's option symbol → underlying, strike, kind and (weekly) expiry."""
    m = SYMBOL.match(symbol)
    if m:
        und, yy, mon, dd, strike, kind = m.groups()
        try:
            expiry = date(2000 + int(yy), MONTH_CODE[mon], int(dd))
        except ValueError:
            expiry = None
        return {"underlying": und, "strike": float(strike), "kind": kind, "expiry": expiry}
    m = MONTHLY.match(symbol)
    if m and m.group(3) in MONTHS:
        und, _yy, _mon, strike, kind = m.groups()
        return {"underlying": und, "strike": float(strike), "kind": kind, "expiry": None}
    return None


def _minutes(at: str) -> int | None:
    try:
        t = datetime.fromisoformat(str(at).replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo is not None:
        t = t.astimezone(IST)
    return t.hour * 60 + t.minute


def _label(strategy: dict) -> str:
    if strategy.get("source") == "tool":
        return {"core": "adaptive-core", "t1": "t1"}.get(strategy.get("book"), "adaptive-core")
    return "own-algo"


def _hhmm(text: str | None) -> int | None:
    if not text:
        return None
    h, m, *_ = (int(x) for x in text.split(":"))
    return h * 60 + m


def label(root: Path, trip_list: list[Trip]) -> list[dict]:
    """`{source, strategy}` for each trip, in order. A fill labels one trip at most."""
    captures: dict[date, tuple | None] = {}
    used: set[tuple] = set()
    out = []
    for t in trip_list:
        day = t.entry_day
        if day not in captures:
            captures[day] = _read(root, day)
        cap = captures[day]
        if cap is None:
            out.append({"source": "unknown", "strategy": None})
            continue
        strategies, failed = cap
        mine = [s for s in strategies if s.get("broker") == t.broker]
        entry = _hhmm(t.entry_time)
        found = None
        if entry is not None:
            for si, s in enumerate(mine):
                for fi, f in enumerate(s.get("fills") or []):
                    key = (day, t.broker, si, fi)
                    p = parse_symbol(str(f.get("symbol", "")))
                    if key in used or p is None:
                        continue
                    if (p["underlying"], p["kind"]) != (t.underlying, t.kind):
                        continue
                    if t.strike is None or p["strike"] != t.strike:
                        continue
                    if p["expiry"] is not None and t.expiry is not None and p["expiry"] != t.expiry:
                        continue
                    want = {"short": "S", "long": "B"}.get(t.direction or "")
                    if want and f.get("side") != want:
                        continue
                    at = _minutes((f.get("entry") or {}).get("at", ""))
                    if at is None or abs(at - entry) > ENTRY_SLACK_MIN:
                        continue
                    found = (key, s)
                    break
                if found:
                    break
        if found:
            used.add(found[0])
            out.append({"source": _label(found[1]), "strategy": found[1].get("name")})
        elif entry is None or t.broker in failed or any(not s.get("fills") for s in mine):
            out.append({"source": "unattributed", "strategy": None})
        else:
            out.append({"source": "manual", "strategy": None})
    return out


def source_of(root: Path, trip: Trip) -> dict:
    """One trip's source (see `label` for a list, where a fill labels one trip only)."""
    return label(root, [trip])[0]
