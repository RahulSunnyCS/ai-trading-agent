"""`/legwise/rotation/beats`: the Rotation page's Books table columns "Last 60 days" and "Last 6
months" (owner, 2026-11-05). The maths is `rotation/beats.py`; nothing here computes a figure and
no route writes anything.

    GET /legwise/rotation/beats?book=core|t1|base

Answers the share of random same-shape baskets the book's cumulative gross beat over each window
(`sessions60`, `months6`, `year1`, `years2`, the whole record `all`, and `recorded`: only the days
the journal recorded at 09:16), with the book's total, the random baskets' 10th / 50th / 90th
percentile and the days behind each. The `slippage` parameter is read by the slippage middleware,
as on every rotation route. A cold request re-derives about 440 days of picks: it answers
`202 {"status": "warming"}` within 20 s and carries on (`rotation/warm.py`); the page asks again.
"""

from __future__ import annotations

import threading
import time
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ..rotation import beats, journal, store, warm

router = APIRouter(prefix="/legwise/rotation/beats")

CACHE_SECONDS = 300.0  # the files change once a night and at 09:16
_lock = threading.Lock()
_cache: dict[tuple, tuple[float, Any]] = {}


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


@router.get("")
def get_beats(book: str = Query(default="t1")) -> Any:
    from ..fyers.daily import data_dir

    if book not in beats.BOOKS:
        return _error(422, f"book must be one of {', '.join(beats.BOOKS)}")
    try:
        root = data_dir()
    except (RuntimeError, OSError, ValueError) as error:
        return _error(503, f"the data root is not available: {error}")
    # the day is part of the key: a cached answer never carries over midnight
    day = beats.today()
    key = (str(root), book, day, store.reading_slip())
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
    if hit is not None and now - hit[0] < CACHE_SECONDS:
        return hit[1]

    def work() -> dict:
        return beats.windows(root, book, day)

    try:
        done, value = warm.run_within(("beats", *key), work)
    except journal.JournalCorrupt as error:
        return _error(500, f"the journal cannot be read: {error}")
    except (ValueError, KeyError, OSError) as error:
        return _error(500, f"the stored rotation files cannot be read: {error}")
    if not done:
        return JSONResponse(status_code=202, content={"status": "warming"})
    with _lock:
        stamp = time.monotonic()
        for old in [k for k, (at, _) in _cache.items() if stamp - at >= CACHE_SECONDS]:
            del _cache[old]
        _cache[key] = (stamp, value)
    return value
