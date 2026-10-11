"""`/legwise/rotation/drawdowns`: a list's drawdown episodes against the fixed base, for the
Rotation page's "Drawdown episodes" card (BL-058 Phase 4, widget 8). The maths is
`rotation/drawdowns.py` over `rotation/daylog.py`; nothing here computes a figure and no route
writes anything.

    GET /legwise/rotation/drawdowns?list=A|B|C|REF&window=P1|P2|last63|forward&min_depth=500
        [&stop=10000&trail=sl:1000,500]

`stop` / `trail` (BL-092) also run the series through the portfolio stop and return it under
`with_stop` beside the registered figures; empty, 0 or below is no stop.

`min_depth` is rupees per lot below the running peak (default 500). Errors come back as
`{"error": ...}`, as in `correlation_routes.py`.
"""

from __future__ import annotations

import threading
import time
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ..rotation import drawdowns
from ..rotation.portfolio import PortfolioStopError, settings_from_query

router = APIRouter(prefix="/legwise/rotation/drawdowns")

CACHE_SECONDS = 30.0  # the files change once a night
MAX_CACHED = 32
_lock = threading.Lock()  # the route runs in worker threads: the cache is shared
_cache: dict[tuple, tuple[float, Any]] = {}


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


@router.get("")
def get_drawdowns(
    list_: str = Query(default="A", alias="list"),
    window: str = "P1",
    min_depth: float = Query(default=drawdowns.DEFAULT_MIN_DEPTH),
    stop: str | None = None,
    trail: str | None = None,
) -> Any:
    from ..fyers.daily import data_dir

    try:
        setting = settings_from_query(stop, trail)
    except PortfolioStopError as error:
        return _error(422, str(error))
    pf = setting if (setting[0] is not None and setting[0] > 0) or setting[1] else None
    root = data_dir()
    key = (root, list_, window, min_depth, None if pf is None else (pf[0], pf[1]))
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
    if hit is not None and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    try:
        value = drawdowns.build(list_, window, min_depth, root, portfolio=pf)
    except drawdowns.DrawdownError as error:
        return _error(error.status, str(error))
    except (ValueError, KeyError, OSError) as error:  # a torn stored file
        return _error(500, f"the stored rotation files cannot be read: {error}")
    with _lock:
        if len(_cache) >= MAX_CACHED:  # bounded: a script looping over depths must not grow it
            _cache.pop(min(_cache, key=lambda k: _cache[k][0]))
        _cache[key] = (now, value)
    return value
