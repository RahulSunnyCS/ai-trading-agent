"""`/legwise/rotation/day-type`: today's and the next session's day type (weekday and each index's
weekdays to expiry), for the Settings › Automation page's day-type rules (BL-211): its "What
trades" preview resolves the draft rules against these. The maths is `rotation/day_type.py`; no
route writes anything the jobs do not also write (the same per-day file `obt rotation daytype
--write` keeps).

    GET /legwise/rotation/day-type
        {"today": {...} | null, "tomorrow": {...} | null, "errors": [...]}

A day that cannot be read comes back null with the reason in `errors`; the other still answers.
"""

from __future__ import annotations

import threading
import time

from fastapi import APIRouter

from ..rotation import day_type
from ..rotation.live_board import now_ist
from ..rotation.tomorrow import next_session

router = APIRouter(prefix="/legwise/rotation/day-type")

CACHE_SECONDS = 300.0  # the labels of a session do not change within the day
_lock = threading.Lock()
_cache: dict[str, tuple[float, dict]] = {}


def _one(day) -> dict:
    key = day.isoformat()
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_SECONDS:
            return hit[1]
    value = day_type.ensure(day).as_json()
    with _lock:
        _cache[key] = (now, value)
    return value


@router.get("")
def get_day_types() -> dict:
    today = now_ist().date()
    errors: list[str] = []
    out: dict[str, dict | None] = {}
    for name, day in (("today", today), ("tomorrow", next_session(today))):
        try:
            out[name] = _one(day)
        except Exception as error:  # noqa: BLE001 - the page says why; the other day still answers
            out[name] = None
            errors.append(f"{name}: {type(error).__name__}: {error}")
    return {**out, "errors": errors}
