"""`/legwise/rotation/portfolio/*`: what a list's basket did under a portfolio MTM stop (BL-095).

    GET /legwise/rotation/portfolio/day?day=YYYY-MM-DD&list=A|B|C|REF&stop=10000&trail=sl:1000,500
    GET /legwise/rotation/portfolio/days?from=&to=&source=recorded|reconstructed&stop=&trail=

Both also take `track=t1` (the T1 journal; list C only, no reconstructed days) and `lots=1..10`
(every pick booked at that many lots, display only; default the entry's recorded lots). Anything
else in either is a 422.

`/day` filters by `source` (`recorded`, `reconstructed` or the default `all`): a day that exists
only as the other kind is a 404. `/days` answers `202 {"status": "warming"}` while a cold replay
is still running (it carries on in the background; ask again).

`stop` empty, missing, 0 or below is no portfolio stop. `trail` is `sl:X,Y`, `lock:A,B` or
`locktrail:A,B,X,Y`; a malformed one is a 422, never ignored. The maths is `rotation/portfolio.py`
and the log wiring `rotation/portfolio_log.py`; nothing here writes anything and no stored result
or registered read-out figure changes.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ..rotation import daylog, journal, portfolio_log, warm
from ..rotation.portfolio import PortfolioStopError, settings_from_query
from .rotation_routes import track_and_lots

router = APIRouter(prefix="/legwise/rotation/portfolio")


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _day(raw: str | None, label: str) -> date | None:
    if raw is None or raw == "":
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError as error:
        raise PortfolioStopError(f"{label} must be YYYY-MM-DD") from error


@router.get("/day")
def get_day(
    day: str,
    list_: str = Query(default="A", alias="list"),
    stop: str | None = None,
    trail: str | None = None,
    source: str = "all",
    track: str | None = None,
    lots: str | None = None,
) -> Any:
    if source not in daylog.SOURCES:
        return _error(422, f"source must be one of {', '.join(daylog.SOURCES)}")
    try:
        track_, lots_ = track_and_lots(track, lots)
    except ValueError as error:
        return _error(422, str(error))
    try:
        parsed = _day(day, "day")
        amount, trailing = settings_from_query(stop, trail)
        if parsed is None:
            raise PortfolioStopError("day is required, YYYY-MM-DD")
        return portfolio_log.list_day(
            parsed, list_, amount, trailing, source, track=track_, lots_per=lots_
        )
    except PortfolioStopError as error:
        return _error(422, str(error))
    except portfolio_log.LogBookError as error:
        return _error(error.status, str(error))
    except journal.JournalCorrupt as error:
        return _error(500, f"the journal cannot be read: {error}")


@router.get("/days")
def get_days(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    source: str = "recorded",
    stop: str | None = None,
    trail: str | None = None,
    track: str | None = None,
    lots: str | None = None,
) -> Any:
    if source not in daylog.SOURCES:
        return _error(422, f"source must be one of {', '.join(daylog.SOURCES)}")
    try:
        track_, lots_ = track_and_lots(track, lots)
    except ValueError as error:
        return _error(422, str(error))
    try:
        start, end = _day(from_, "from"), _day(to, "to")
        amount, trailing = settings_from_query(stop, trail)
        if start and end and start > end:
            raise PortfolioStopError("from must not be after to")
        # A cold replay of the whole history outlasts the proxy's 30 s: answer 202 within the
        # wait and let the page ask again (rotation/warm.py); the work fills the path cache.
        done, value = warm.run_within(
            ("days", start, end, amount, trailing, source, track_, lots_),
            lambda: portfolio_log.days(
                start, end, amount, trailing, source, track=track_, lots_per=lots_
            ),
        )
        if not done:
            return JSONResponse(status_code=202, content={"status": "warming"})
        return value
    except PortfolioStopError as error:
        return _error(422, str(error))
    except portfolio_log.LogBookError as error:
        return _error(error.status, str(error))
    except journal.JournalCorrupt as error:
        return _error(500, f"the journal cannot be read: {error}")
