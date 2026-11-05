"""`/legwise/rotation/beats`: the Rotation page's Books table columns "Last 60 sessions" and "Last 6
months" (owner, 2026-11-05). The maths is `rotation/beats.py`; nothing here computes a figure and
no route writes anything.

    GET /legwise/rotation/beats?book=core|t1|base
    GET /legwise/rotation/beats/compare        both Adaptive books against the fixed base on the
                                               days all three have: the gap in rupees per lot-day
                                               with its 90% range, days ahead, edge over random in
                                               standard deviations, and the 60-session drift alarm

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

CACHE_SECONDS = (
    3600.0  # a cap: the key holds the files' modified times, which change at 09:16 and nightly
)
_lock = threading.Lock()
_cache: dict[tuple, tuple[float, Any]] = {}


def _stamp(root: Any) -> tuple:
    """Modified times of what the answer is built from: the days list (a new result day) and both
    journals (a new entry)."""
    out = []
    for path in (
        store.days_path(root),
        store.journal_path(root),
        store.journal_path(root, "t1"),
    ):
        try:
            out.append(path.stat().st_mtime_ns)
        except OSError:
            out.append(0)
    return tuple(out)


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _answer(kind: str, book: str | None, fn: Any) -> Any:
    """`fn(root, day)` cached on the files it is built from, run through `warm.run_within`."""
    from ..fyers.daily import data_dir

    try:
        root = data_dir()
    except (RuntimeError, OSError, ValueError) as error:
        return _error(503, f"the data root is not available: {error}")
    # the day and the journal's and day list's modified times are the key: a cached answer never
    # carries over midnight or past a new entry or a stored day
    day = beats.today()
    key = (kind, str(root), book, day, _stamp(root), store.reading_slip())
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
    if hit is not None and now - hit[0] < CACHE_SECONDS:
        return hit[1]

    def work() -> dict:
        return fn(root, day)

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


@router.get("")
def get_beats(book: str = Query(default="t1")) -> Any:
    if book not in beats.BOOKS:
        return _error(422, f"book must be one of {', '.join(beats.BOOKS)}")
    return _answer("windows", book, lambda root, day: beats.windows(root, book, day))


@router.get("/compare")
def get_compare() -> Any:
    """Classic and Tuned against the fixed base per window, and the drift alarm."""
    return _answer("compare", None, beats.compare)
