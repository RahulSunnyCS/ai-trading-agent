"""`/legwise/rotation/drift`: what a list has been holding, by family, index, strike method and
start band, against its own past, for the Rotation page's "Selection drift" card (BL-058 Phase 4,
widget 9). The maths is `rotation/drift.py`; nothing here computes a figure and no route writes
anything.

    GET /legwise/rotation/drift?list=A|B|C|REF

Errors come back as `{"error": ...}`, as in `correlation_routes.py`.
"""

from __future__ import annotations

import threading
import time
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ..rotation import drift, journal, store

router = APIRouter(prefix="/legwise/rotation/drift")

CACHE_SECONDS = 30.0  # the files change once a night and at 09:16
_lock = threading.Lock()  # the route runs in worker threads: the cache is shared
_cache: dict[tuple, tuple[float, Any]] = {}


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


@router.get("")
def get_drift(list_: str = Query(default="A", alias="list")) -> Any:
    from ..fyers.daily import data_dir

    root = data_dir()
    key = (root, list_, store.reading_slip())
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
    if hit is not None and now - hit[0] < CACHE_SECONDS:
        return hit[1]
    try:
        value = drift.build(list_, root)
    except drift.DriftError as error:
        return _error(error.status, str(error))
    except journal.JournalCorrupt as error:
        return _error(500, f"the journal cannot be read: {error}")
    except (ValueError, KeyError, OSError) as error:  # a torn stored file
        return _error(500, f"the stored rotation files cannot be read: {error}")
    with _lock:
        _cache[key] = (now, value)
    return value
