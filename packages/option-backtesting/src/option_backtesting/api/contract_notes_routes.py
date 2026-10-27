"""`/legwise/contract-notes/*`: the Trade book page's reads (BL-168), over the contract-notes
store in `TRADING_DATA_ROOT/contract-notes/`. The maths is `realised/`; nothing here computes a
figure. One route writes: `PUT /inputs/{day}`, the owner's Algos and Capital for a day.

    GET /legwise/contract-notes/summary?from=&to=&account=   headline, ratios, FY, accounts
    GET /legwise/contract-notes/days?from=&to=&account=      one row per session
    GET /legwise/contract-notes/months?from=&to=&account=    the monthly tab
    GET /legwise/contract-notes/trips?from=&to=&account=&extremes=1   round trips, sources
    GET /legwise/contract-notes/day/{day}                    one session in full
    GET /legwise/contract-notes/money?from=&to=              ledger events
    GET /legwise/contract-notes/momentum?from=&to=           the Zerodha notes
    PUT /legwise/contract-notes/inputs/{day}                 {algos?, capital_total?, capital?}

Errors come back as `{"error": ...}`, as in the rotation routes.
"""

from __future__ import annotations

import threading
import time
from datetime import date
from typing import Any

from fastapi import APIRouter, Body, Query
from fastapi.responses import JSONResponse

router = APIRouter(prefix="/legwise/contract-notes")

CACHE_SECONDS = 20.0  # the store changes at night, at 15:50 and when inputs are saved
CACHE_ENTRIES = 32
_lock = threading.Lock()
_cache: dict[tuple, tuple[float, Any]] = {}


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _day(value: str | None) -> date | None:
    if value is None or value == "":
        return None
    return date.fromisoformat(value)


def _root():
    from ..fyers.daily import data_dir

    return data_dir()


def _cached(key: tuple, compute):
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_SECONDS:
            return hit[1]
    value = compute()
    with _lock:
        _cache[key] = (now, value)
        while len(_cache) > CACHE_ENTRIES:
            _cache.pop(min(_cache, key=lambda k: _cache[k][0]))
    return value


def _clear() -> None:
    with _lock:
        _cache.clear()


def _read(name: str, fn, start, end, **extra) -> Any:
    try:
        s, e = _day(start), _day(end)
    except ValueError:
        return _error(422, "from and to must be days as YYYY-MM-DD")
    if s and e and s > e:
        return _error(422, "from is after to")
    try:
        root = _root()
    except (RuntimeError, OSError, ValueError) as error:
        return _error(503, f"the data root is not available: {error}")
    key = (name, root, s, e, tuple(sorted(extra.items())))
    return _cached(key, lambda: fn(root, start=s, end=e, **extra))


@router.get("/summary")
def get_summary(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    account: str | None = Query(default=None),
) -> Any:
    from ..realised import views

    return _read("summary", views.summary, from_, to, account=account)


@router.get("/days")
def get_days(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    account: str | None = Query(default=None),
) -> Any:
    from ..realised import views

    return _read("days", views.days, from_, to, account=account)


@router.get("/months")
def get_months(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    account: str | None = Query(default=None),
) -> Any:
    from ..realised import views

    return _read("months", views.months, from_, to, account=account)


@router.get("/trips")
def get_trips(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    account: str | None = Query(default=None),
    extremes: bool = Query(default=False),
) -> Any:
    from ..realised import views

    return _read("trips", views.trip_rows, from_, to, account=account, extremes=extremes)


@router.get("/money")
def get_money(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
) -> Any:
    from ..realised import views

    return _read("money", views.money, from_, to)


@router.get("/momentum")
def get_momentum(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
) -> Any:
    from ..realised import views

    return _read("momentum", views.momentum, from_, to)


@router.get("/day/{day}")
def get_day(day: str) -> Any:
    from ..realised import views

    try:
        d = date.fromisoformat(day)
    except ValueError:
        return _error(422, "the day must be YYYY-MM-DD")
    try:
        root = _root()
    except (RuntimeError, OSError, ValueError) as error:
        return _error(503, f"the data root is not available: {error}")
    return _cached(("day", root, d), lambda: views.day_detail(root, d))


@router.put("/inputs/{day}")
def put_inputs(day: str, body: dict = Body(...)) -> Any:  # noqa: B008 - FastAPI's own idiom
    """The owner's inputs for a day: `algos` (a whole number, 0-200), `capital_total` and
    `capital` (`{finvasia, angelone}`, rupees, 0-10 crore). A field sent as null is removed.
    Writes only `manual/<day>.json`, stamped `source: page`."""
    from ..realised.capital import write_manual

    try:
        d = date.fromisoformat(day)
    except ValueError:
        return _error(422, "the day must be YYYY-MM-DD")
    allowed = {"algos", "capital_total", "capital"}
    unknown = set(body) - allowed
    if unknown:
        return _error(422, f"unknown field(s): {', '.join(sorted(unknown))}")

    def money(v: Any) -> bool:
        return v is None or (isinstance(v, int | float) and 0 <= v <= 100_000_000)

    if (
        "algos" in body
        and body["algos"] is not None
        and (not isinstance(body["algos"], int) or not 0 <= body["algos"] <= 200)
    ):
        return _error(422, "algos must be a whole number 0-200")
    if "capital_total" in body and not money(body["capital_total"]):
        return _error(422, "capital_total must be rupees, 0 to 10 crore")
    if "capital" in body and body["capital"] is not None:
        cap = body["capital"]
        if not isinstance(cap, dict) or set(cap) - {"finvasia", "angelone"}:
            return _error(422, "capital must be {finvasia, angelone}")
        if not all(money(v) for v in cap.values()):
            return _error(422, "capital must be rupees, 0 to 10 crore")
    try:
        root = _root()
    except (RuntimeError, OSError, ValueError) as error:
        return _error(503, f"the data root is not available: {error}")

    def update(m: dict) -> dict:
        m.setdefault("day", d.isoformat())
        for k, v in body.items():
            if v is None:
                m.pop(k, None)
            elif k == "capital":
                m["capital"] = {**(m.get("capital") or {}), **v}
            else:
                m[k] = v
        m["source"] = "page"
        if isinstance(m.get("from_sheet"), list):
            m["from_sheet"] = [f for f in m["from_sheet"] if f not in body]
        return m

    saved = write_manual(root, d, update)
    _clear()
    return {"ok": True, "manual": saved}
