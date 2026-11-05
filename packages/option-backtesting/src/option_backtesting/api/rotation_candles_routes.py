"""`/legwise/rotation/candles`: the Rotation page's daily candle card (owner, 2026-11-04). The maths
is `rotation/candles.py`; nothing here computes a figure and no route writes anything.

    GET /legwise/rotation/candles?book=t1|core|base&from=YYYY-MM-DD&to=YYYY-MM-DD&lots=1..10&stop=

`from` / `to` default to the last two years; `lots` to 1; `stop` (rupees at one lot a strategy) to
the book's own (T1 ₹9k, Classic ₹8k, base ₹8k), empty or 0 for none. The `slippage` parameter is
read by the slippage middleware, as on every rotation route. A cold request replays hundreds of
book-days: it answers `202 {"status": "warming"}` within 20 s and carries on (`rotation/warm.py`);
the page asks again. Errors are `{"error": ...}`.
"""

from __future__ import annotations

import math
import threading
import time
from datetime import date
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ..rotation import candles, journal, store, warm

router = APIRouter(prefix="/legwise/rotation/candles")

CACHE_SECONDS = 60.0  # the files change once a night and at 09:16
_lock = threading.Lock()
_cache: dict[tuple, tuple[float, Any]] = {}


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _day(raw: str | None, label: str) -> date | None:
    if raw in (None, ""):
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError as error:
        raise ValueError(f"{label} must be YYYY-MM-DD") from error


@router.get("")
def get_candles(
    book: str = Query(default="t1"),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    lots: int = Query(default=1),
    stop: str | None = Query(default=None),
) -> Any:
    from ..fyers.daily import data_dir

    try:
        start, end = _day(from_, "from"), _day(to, "to")
        stop_inr = None if stop in (None, "") else float(stop)
    except ValueError as error:
        return _error(422, str(error))
    if stop_inr is not None and not math.isfinite(stop_inr):
        return _error(422, "stop must be a number of rupees")
    if book not in candles.BOOKS:
        return _error(422, f"book must be one of {', '.join(candles.BOOKS)}")
    if not 1 <= lots <= candles.MAX_LOTS:
        return _error(422, f"lots must be 1 to {candles.MAX_LOTS}")
    try:
        root = data_dir()
    except (RuntimeError, OSError, ValueError) as error:
        return _error(503, f"the data root is not available: {error}")
    explicit = stop is not None  # `stop=` (empty) asks for no stop; leaving it out, the default
    key = (str(root), book, start, end, lots, stop_inr, explicit, store.reading_slip())
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
    if hit is not None and now - hit[0] < CACHE_SECONDS:
        return hit[1]

    def work() -> dict:
        return candles.build(book, root, start, end, lots, stop_inr, use_default_stop=not explicit)

    try:
        done, value = warm.run_within(("candles", *key), work)
    except candles.CandlesError as error:
        return _error(422, str(error))
    except journal.JournalCorrupt as error:
        return _error(500, f"the journal cannot be read: {error}")
    except (ValueError, KeyError, OSError) as error:
        return _error(500, f"the stored rotation files cannot be read: {error}")
    if not done:
        return JSONResponse(status_code=202, content={"status": "warming"})
    with _lock:
        stamp = time.monotonic()
        for old in [k for k, (at, _) in _cache.items() if stamp - at >= CACHE_SECONDS]:
            del _cache[old]  # keep only fresh answers: a long-running API asks many windows
        _cache[key] = (stamp, value)
    return value
