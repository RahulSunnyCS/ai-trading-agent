"""`/legwise/rotation/shadow`: the Shadow scoreboard's read layer (BL-083 triggers and the pick they
would have replaced, BL-081's forward candidates). The maths is `rotation/shadow.py` over
`rotation/triggers.py`; nothing here computes a figure and no route writes anything.

    GET /legwise/rotation/shadow?from=&to=   trigger table, override vs displaced pick, candidates

`from` / `to` (YYYY-MM-DD) narrow the forward window; a `from` before 2026-10-12 is raised to it,
because nothing earlier is forward. Errors come back as `{"error": ...}`.
"""

from __future__ import annotations

import time
from datetime import date
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ..rotation import shadow

router = APIRouter(prefix="/legwise/rotation/shadow")

CACHE_SECONDS = 30.0  # the files change once a night; a page refresh should not re-read them
MAX_CACHED = 16
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


@router.get("")
def get_shadow(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
) -> Any:
    start, end = _day(from_, "from"), _day(to, "to")
    for bound in (start, end):
        if isinstance(bound, JSONResponse):
            return bound
    if start and end and start > end:
        return _error(422, "from must not be after to")
    from ..fyers.daily import data_dir

    root = data_dir()
    key = (root, start, end)
    now = time.monotonic()
    hit = _cache.get(key)
    if hit is not None and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    value = shadow.report(root, start, end)
    if len(_cache) >= MAX_CACHED:  # bounded: a script looping over dates must not grow it
        _cache.pop(min(_cache, key=lambda k: _cache[k][0]))
    _cache[key] = (now, value)
    return value
