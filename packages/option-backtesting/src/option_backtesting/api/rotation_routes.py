"""`/legwise/rotation/*`: the Rotation page's read layer (BL-058 Phase 4). The maths is
`rotation/readout.py` (the code behind `obt rotation readout`) and `rotation/overview.py`;
nothing here computes a figure. Read-only: no route writes to the journal or the results.

    GET /legwise/rotation/overview   data-health checks, the latest entry's baskets, the lists
    GET /legwise/rotation/summary    the read-out: lists against REF, the base and random baskets

Errors come back as `{"error": ...}` (what the dashboard's api.ts reads).
"""

from __future__ import annotations

import time
from datetime import date
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ..rotation import overview, readout
from ..rotation.journal import JournalCorrupt

router = APIRouter(prefix="/legwise/rotation")

MAX_CACHED = 16
CACHE_SECONDS = 30.0  # results are written nightly; a page refresh should not re-run 1,000 baskets
_cache: dict[tuple, tuple[float, Any]] = {}


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _day(raw: str | None, label: str) -> date | None | JSONResponse:
    if not raw:
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return _error(422, f"{label} must be YYYY-MM-DD")


def _cached(key: tuple, build):
    now = time.monotonic()
    hit = _cache.get(key)
    if hit is not None and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    value = build()
    if len(_cache) >= MAX_CACHED:  # a few dozen keys at most; drop the oldest rather than grow
        _cache.pop(min(_cache, key=lambda k: _cache[k][0]))
    _cache[key] = (now, value)
    return value


@router.get("/overview")
def get_overview(day: str | None = Query(default=None)):
    d = _day(day, "day")
    if isinstance(d, JSONResponse):
        return d
    from ..fyers.daily import data_dir

    root = data_dir()
    return _cached(
        ("overview", root, d),
        lambda: {
            "health": overview.health(root),
            "baskets": overview.baskets(root, d),
            "lists": overview.lists_spec(),
            "first_entry_day": overview.FIRST_ENTRY_DAY.isoformat(),
            "readout_days": overview.READOUT_DAYS,
        },
    )


@router.get("/summary")
def get_summary(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
):
    start = _day(from_, "from")
    if isinstance(start, JSONResponse):
        return start
    end = _day(to, "to")
    if isinstance(end, JSONResponse):
        return end
    from ..fyers.daily import data_dir

    root = data_dir()
    try:
        return _cached(("summary", root, start, end), lambda: readout.build(root, start, end))
    except JournalCorrupt as error:
        return _error(409, f"the journal cannot be read: {error}")
