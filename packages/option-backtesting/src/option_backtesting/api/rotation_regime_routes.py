"""`/legwise/rotation/regime`: the forward window's market mix beside P1, P2 and P3, for the
Rotation page's "Forward days vs research periods" card (BL-058 Phase 4, widget 7). The maths is
`rotation/regime.py`; nothing here computes a figure and no route writes anything.

    GET /legwise/rotation/regime     the periods' mixes, the distances, and what is unavailable

Errors come back as `{"error": ...}`, as in `correlation_routes.py`.
"""

from __future__ import annotations

import threading
import time
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..rotation import journal, regime

router = APIRouter(prefix="/legwise/rotation/regime")

CACHE_SECONDS = 60.0  # the files change once a night
_lock = threading.Lock()  # the route runs in worker threads: the cache is shared
_cache: dict[str, Any] = {"at": 0.0, "root": None, "value": None}


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


@router.get("")
def get_regime() -> Any:
    from ..fyers.daily import data_dir

    root = data_dir()
    now = time.monotonic()
    with _lock:
        if (
            _cache["value"] is not None
            and _cache["root"] == root
            and now - _cache["at"] < CACHE_SECONDS
        ):
            return _cache["value"]
    try:
        value = regime.build(root)
    except journal.JournalCorrupt as error:
        return _error(500, f"the journal cannot be read: {error}")
    with _lock:
        _cache.update(at=now, root=root, value=value)
    return value
