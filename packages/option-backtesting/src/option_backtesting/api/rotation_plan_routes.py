"""`/legwise/rotation/plan`: the Today page's baskets with what the platforms hold (dashboard
review, 2026-10-28). Each Adaptive book's picks for the latest recorded session and for the next
session (the evening's tentative list), with their settings in words and, per account Settings ›
Automation has uploading, whether each pick is uploaded and was switched on. The maths is
`rotation/plan.py`; nothing here computes a figure and no route writes anything.

    GET /legwise/rotation/plan

Errors come back as `{"error": ...}`, as in the other rotation routes.
"""

from __future__ import annotations

import threading
import time
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..rotation import journal, plan, store

router = APIRouter(prefix="/legwise/rotation/plan")

CACHE_SECONDS = 20.0  # the ledgers change at 16:40-16:55, 09:16-09:21 and 15:40
_lock = threading.Lock()
_cache: dict[str, tuple[float, Any]] = {}


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


@router.get("")
def get_plan() -> Any:
    from ..fyers.daily import data_dir

    try:
        root = data_dir()
    except (RuntimeError, OSError, ValueError) as error:
        return _error(503, f"the data root is not available: {error}")
    key = (str(root), store.reading_slip())
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
    if hit is not None and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    try:
        value = plan.build(root)
    except journal.JournalCorrupt as error:
        return _error(500, f"the journal cannot be read: {error}")
    except (ValueError, KeyError, OSError) as error:
        return _error(500, f"the stored rotation files cannot be read: {error}")
    with _lock:
        _cache[key] = (now, value)
    return value
