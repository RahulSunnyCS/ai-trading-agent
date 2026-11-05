"""The day type of a session (BL-211): its weekday and the weekdays to expiry of each index, the
facts a day-type rule in Settings › Automation is written on.

The labels are `live.listed_dte_labels`, the one source the 09:16 pick, the evening's expected
picks and the exports already use (weekday basis, BL-109), so a rule and a message can never read
two different days to expiry. `for_day` computes them; `write` keeps a copy at
`TRADING_DATA_ROOT/rotation/day-type/<day>.json` so the TypeScript jobs, which do not compute
expiries, read the same facts (`packages/broker-login/src/day-type.ts`)."""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from . import store

INDICES = ("NIFTY", "SENSEX")
#: how long a day type read from the calendar (the master was unreachable) is kept before the
#: listed contracts are asked again
CALENDAR_RETRY_S = 15 * 60
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri")


@dataclass(frozen=True)
class DayType:
    day: date
    weekday: str
    #: {'NIFTY': '0'..'6' | '7+' | 'unknown', 'SENSEX': ...}, weekdays to the nearest expiry
    dte: dict[str, str]
    #: where the labels came from: 'master' (Fyers' listed contracts) or 'calendar'
    source: str

    def as_json(self) -> dict:
        return {
            "day": self.day.isoformat(),
            "weekday": self.weekday,
            "dte": dict(self.dte),
            "source": self.source,
        }


def from_json(data: dict) -> DayType:
    return DayType(
        date.fromisoformat(str(data["day"])),
        str(data["weekday"]),
        {i: str(data["dte"].get(i, "unknown")) for i in INDICES},
        str(data.get("source", "")),
    )


def for_day(day: date) -> DayType:
    """The day type of `day` from the listed contracts (the calendar if the master cannot be read,
    as the pick does)."""
    from .live import listed_dte_labels

    labels, source = listed_dte_labels(day)
    return DayType(
        day,
        day.strftime("%a"),
        {"NIFTY": str(labels["dte_n"]), "SENSEX": str(labels["dte_s"])},
        source,
    )


def path(day: date, root: Path | None = None) -> Path:
    return store.rotation_dir(root) / "day-type" / f"{day.isoformat()}.json"


def write(dt: DayType, root: Path | None = None) -> Path:
    target = path(dt.day, root)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(dt.as_json(), indent=2) + "\n")
    tmp.replace(target)
    return target


def read(day: date, root: Path | None = None) -> DayType | None:
    """The stored day type of `day`, or None when none was written (or it is for another day)."""
    target = path(day, root)
    if not target.exists():
        return None
    data = json.loads(target.read_text())
    dt = from_json(data)
    return dt if dt.day == day else None


def ensure(day: date, root: Path | None = None) -> DayType:
    """The day type of `day`, computed and written. A file already there for the day is kept only
    when it was read from the listed contracts and has no unknown label; a calendar fallback or an
    unknown is read again, since the master may answer now."""
    stored = read(day, root)
    if stored is not None and "unknown" not in stored.dte.values():
        if stored.source == "master":
            return stored
        # A calendar fallback is tried again, but not on every call: while the master is
        # unreachable each retry costs two multi-MB download attempts (the live board asks every
        # 5 minutes), so a fallback read within the last CALENDAR_RETRY_S is kept.
        age = time.time() - path(day, root).stat().st_mtime
        if age < CALENDAR_RETRY_S:
            return stored
    dt = for_day(day)
    write(dt, root)
    return dt
