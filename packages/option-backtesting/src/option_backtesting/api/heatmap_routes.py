"""`/legwise/heatmap*`: the ATM short-straddle heatmap for the Options Lab (BL-094). The numbers
are `heatmap/view.py`'s, read from the grids `obt heatmap build` stores; nothing here simulates.

    GET /legwise/heatmap/available   underlyings with a grid, their day ranges, times, SLs, exits
    GET /legwise/heatmap             one view: time_sl | date_time | date_sl

Errors come back as `{"error": ...}` (what the dashboard's api.ts reads).
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ..heatmap import grid, store, view

router = APIRouter(prefix="/legwise/heatmap")

_UNDERLYING_RE = re.compile(r"^[A-Z0-9&-]{1,20}$")
_TIME_RE = re.compile(r"^\d\d:\d\d$")
_WEEKS_RE = re.compile(r"^\d{1,2}(,\d{1,2}){0,7}$")


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _day(raw: str | None, label: str) -> date | None | JSONResponse:
    if not raw:
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return _error(422, f"{label} must be YYYY-MM-DD")


@router.get("/available")
def available() -> Any:
    return {
        "underlyings": store.available(),
        "times": list(grid.ENTRY_TIMES),
        "stop_losses": list(grid.STOP_LOSSES),
        "no_sl": grid.NO_SL,
        "sl_levels": list(grid.SL_LEVELS),
        "exit_times": list(grid.EXIT_TIMES),
        "views": list(view.VIEWS),
        "metrics": list(view.METRICS),
    }


@router.get("")
def heatmap(
    underlying: str = Query("NIFTY"),
    view_name: str = Query("time_sl", alias="view"),
    day: str | None = Query(None, alias="date"),
    from_: str | None = Query(None, alias="from"),
    to: str | None = Query(None),
    sl: int | None = Query(None),
    time: str | None = Query(None),
    exit_time: str = Query(grid.EXIT_TIME, alias="exit"),
    weeks: str | None = Query(
        None, description="weeks to expiry, comma-separated; 0 = expiry week"
    ),
    metric: str = Query("value"),
) -> Any:
    if not _UNDERLYING_RE.match(underlying):
        return _error(422, "unusable underlying")
    if time is not None and not _TIME_RE.match(time):
        return _error(422, "time must be HH:MM")
    if weeks is not None and not _WEEKS_RE.match(weeks):
        return _error(422, "weeks must be comma-separated integers")
    parsed = {}
    for label, raw in (("date", day), ("from", from_), ("to", to)):
        got = _day(raw, label)
        if isinstance(got, JSONResponse):
            return got
        parsed[label] = got
    try:
        return view.build_view(
            underlying,
            view_name,
            day=parsed["date"],
            start=parsed["from"],
            end=parsed["to"],
            sl=sl,
            time=time,
            exit_time=exit_time,
            weeks={int(w) for w in weeks.split(",")} if weeks else None,
            metric=metric,
        )
    except view.HeatmapError as error:
        return _error(422, str(error))
