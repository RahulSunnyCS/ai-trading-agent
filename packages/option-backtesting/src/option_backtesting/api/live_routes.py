"""`/legwise/live/*`: the Live page's data (BL-117 Phase 3). The maths is `live/session.py`;
nothing here computes a figure and no route writes anything.

    GET /legwise/live/days?underlying=NIFTY|SENSEX           collected days to replay, newest first
    GET /legwise/live/session?underlying=&day=YYYY-MM-DD     one day on the 1-minute grid
                                                              (day omitted = newest collected day)

Errors come back as `{"error": ...}`, as in `correlation_routes.py`.
"""

from __future__ import annotations

from datetime import date
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..live import session

router = APIRouter(prefix="/legwise/live")


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


@router.get("/days")
def get_days(underlying: str = "NIFTY") -> Any:
    from ..fyers.daily import data_dir

    try:
        days = session.recent_days(data_dir(), underlying)
    except session.LiveSessionError as error:
        return _error(422, str(error))
    return {"underlying": underlying, "days": [d.isoformat() for d in days]}


@router.get("/session")
def get_session(underlying: str = "NIFTY", day: str | None = None) -> Any:
    from ..fyers.daily import data_dir

    try:
        chosen = date.fromisoformat(day) if day else None
    except ValueError:
        return _error(422, "day must be YYYY-MM-DD")
    try:
        return session.build_session(data_dir(), underlying, chosen)
    except session.LiveSessionError as error:
        return _error(404 if "no " in str(error) else 422, str(error))
    except (FileNotFoundError, OSError) as error:
        return _error(500, f"the stored day cannot be read: {error}")
