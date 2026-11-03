"""`/legwise/rotation/lot-plans`: the Rotation page's "Lot plans" card (BL-135). As picked, Dir
Boost and Duo for one book's Adaptive picks, forward from Mon 2026-10-19. The maths is
`rotation/lot_plans.py`; nothing here computes a figure and no route writes anything.

    GET /legwise/rotation/lot-plans?book=core|t1

Errors come back as `{"error": ...}`, as in the other rotation routes.
"""

from __future__ import annotations

import threading
import time
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ..rotation import journal, lot_plans, store

router = APIRouter(prefix="/legwise/rotation/lot-plans")

CACHE_SECONDS = 30.0  # the files change once a night and at 09:16
_lock = threading.Lock()  # the route runs in worker threads: the cache is shared
_cache: dict[tuple, tuple[float, Any]] = {}


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


@router.get("")
def get_lot_plans(book: str = Query(default="core")) -> Any:
    from ..fyers.daily import data_dir

    if book not in lot_plans.BOOKS:
        return _error(422, f"book must be one of {', '.join(lot_plans.BOOKS)}")
    try:
        root = data_dir()  # an unmounted data volume raises here: answer it as an error too
    except (RuntimeError, OSError, ValueError) as error:
        return _error(503, f"the data root is not available: {error}")
    key = (root, book, store.reading_slip())
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
    if hit is not None and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    try:
        value = lot_plans.build(book, root)
    except journal.JournalCorrupt as error:
        return _error(500, f"the journal cannot be read: {error}")
    except (ValueError, KeyError, OSError) as error:  # a torn stored file
        return _error(500, f"the stored rotation files cannot be read: {error}")
    with _lock:
        _cache[key] = (now, value)
    return value
