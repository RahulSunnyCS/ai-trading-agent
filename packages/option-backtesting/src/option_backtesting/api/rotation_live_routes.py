"""`/legwise/rotation/live`: the Rotation page's "Live vs paper" card (BL-141 Phase 3). Each
captured day's live results beside the paper ones, running totals per platform + list and
slippage by shape. The maths is `rotation/live_compare.py`; nothing here computes a figure and no
route writes anything.

    GET /legwise/rotation/live?from=YYYY-MM-DD&to=YYYY-MM-DD   (both optional: every captured day)

Errors come back as `{"error": ...}`, as in the other rotation routes.
"""

from __future__ import annotations

import threading
import time
from datetime import date
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ..rotation import live_compare

router = APIRouter(prefix="/legwise/rotation/live")

CACHE_SECONDS = 30.0  # the capture files change at 15:40 and when a back-fill lands
CACHE_ENTRIES = 16  # the key holds caller-chosen days: keep only the newest few
_lock = threading.Lock()  # the route runs in worker threads: the cache is shared
_cache: dict[tuple, tuple[float, Any]] = {}


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _day(value: str | None) -> date | None:
    if value is None or value == "":
        return None
    return date.fromisoformat(value)


@router.get("")
def get_live(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
) -> Any:
    from ..fyers.daily import data_dir

    try:
        start = _day(from_)
        end = _day(to)
    except ValueError:
        return _error(422, "from and to must be days as YYYY-MM-DD")
    if start and end and start > end:
        return _error(422, "from is after to")
    try:
        root = data_dir()  # an unmounted data volume raises here: answer it as an error too
    except (RuntimeError, OSError, ValueError) as error:
        return _error(503, f"the data root is not available: {error}")
    key = (root, start, end)
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
    if hit is not None and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    try:
        value = live_compare.compare_range(start, end, root)
    except (ValueError, KeyError, OSError) as error:  # a torn stored file
        return _error(500, f"the stored live or rotation files cannot be read: {error}")
    with _lock:
        for k in [k for k, (t, _) in _cache.items() if now - t >= CACHE_SECONDS]:
            del _cache[k]
        while len(_cache) >= CACHE_ENTRIES:
            del _cache[min(_cache, key=lambda k: _cache[k][0])]
        _cache[key] = (now, value)
    return value
