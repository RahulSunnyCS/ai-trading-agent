"""`/legwise/rotation/basket`: one list's picks for one day (or the fixed base), correlated over a
window, for the Correlation tab's "Today's basket" preset (BL-058 Phase 4, widget 6). The maths is
`rotation/basket.py` over `analytics/correlation.py`; nothing here computes a figure and no route
writes anything.

    GET /legwise/rotation/basket?list=A|B|C|REF|BASE&day=&window=&from=&to=

`window` is P1, P2, last63, forward or custom (custom uses `from` / `to`).
`day` defaults to the latest on-time entry (else the latest day the history can re-score). Errors
come back as `{"error": ...}`, as in `correlation_routes.py`.
"""

from __future__ import annotations

import time
from datetime import date
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ..rotation import basket

router = APIRouter(prefix="/legwise/rotation/basket")

CACHE_SECONDS = 30.0  # the files change once a night
MAX_CACHED = 32
_cache: dict[tuple, tuple[float, Any]] = {}


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _day(raw: str | None, label: str) -> date | None | JSONResponse:
    if not raw:
        return None
    try:
        parsed = date.fromisoformat(raw)
    except ValueError:
        return _error(422, f"{label} must be YYYY-MM-DD")
    return parsed if parsed.isoformat() == raw else _error(422, f"{label} must be YYYY-MM-DD")


@router.get("")
def get_basket(
    list_: str = Query(default="A", alias="list"),
    day: str | None = None,
    window: str = "P1",
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
) -> Any:
    parsed = [_day(day, "day"), _day(from_, "from"), _day(to, "to")]
    for p in parsed:
        if isinstance(p, JSONResponse):
            return p
    d, start, end = parsed
    assert not isinstance(d, JSONResponse)
    assert not isinstance(start, JSONResponse) and not isinstance(end, JSONResponse)
    if start and end and start > end:
        return _error(422, "from must not be after to")
    from ..fyers.daily import data_dir

    root = data_dir()
    key = (root, list_, d, window, start, end)
    now = time.monotonic()
    hit = _cache.get(key)
    if hit is not None and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    try:
        value = basket.build(list_, d, window, start, end, root)
    except basket.BasketError as error:
        return _error(error.status, str(error))
    if len(_cache) >= MAX_CACHED:  # bounded: a script looping over dates must not grow it
        _cache.pop(min(_cache, key=lambda k: _cache[k][0]))
    _cache[key] = (now, value)
    return value
