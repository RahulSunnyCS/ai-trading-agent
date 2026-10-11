"""`/legwise/rotation/matrix*`: the Options Lab's Strategy Matrix (read-only). The maths is
`rotation/matrix.py`; nothing here computes a figure and nothing writes to the rotation store.

    GET /legwise/rotation/matrix        a grid of cells for one view, period (or two, compared)
    GET /legwise/rotation/matrix/cell   the daily values, curve and variants behind one cell

Query (both routes): `view` family_slot | date_slot | dte_slot | vix_family | weekday_family |
pulse; `metric` avg | win_rate | stop_rate | worst | selection; `period` P1 | P2 | P3 | forward |
custom (`from` / `to` alone mean custom); `compare` two period ids ("P1,P2": shared colour
scale and a difference); filters `index` NIFTY | SENSEX | both, `family` (comma tags or
`widesl` / `dirs`), `slot` HHMM list, `weekday`, `dte`, `vix_band`; `min_n` (default 20);
`list` A | B | C | REF and `basis` all | selected for the selection overlay.

A period whose data is not in the store (P3, or forward before the first entry) is returned with
`status: "unavailable"` and a reason, never as an error. Errors are `{"error": ...}`.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ..rotation import matrix as m

router = APIRouter(prefix="/legwise/rotation/matrix")

_KEY_RE = re.compile(r"^[A-Za-z0-9_:.+<>\- ]{1,40}$")


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _day(raw: str | None, label: str) -> date | None:
    if not raw:
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError as error:
        raise m.MatrixError(f"{label} must be YYYY-MM-DD") from error


def _period(period: str | None, lo: date | None, hi: date | None) -> str:
    return period or ("custom" if lo or hi else "P1")


@router.get("")
def matrix(
    view: str = "family_slot",
    metric: str = "avg",
    period: str | None = None,
    compare: str | None = None,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    index: str | None = None,
    family: str | None = None,
    slot: str | None = None,
    weekday: str | None = None,
    dte: str | None = None,
    vix_band: str | None = None,
    min_n: int = Query(default=m.DEFAULT_MIN_N, ge=1, le=1000),
    list_: str | None = Query(default=None, alias="list"),
    basis: str = "all",
) -> Any:
    try:
        lo, hi = _day(from_, "from"), _day(to, "to")
        pair = tuple(p.strip() for p in compare.split(",")) if compare else None
        if pair is not None and len(pair) != 2:
            raise m.MatrixError("compare takes two period ids, e.g. P1,P2")
        out = m.compute(
            m.load_cube(),
            m.load_journal(),
            view=view,
            metric=metric,
            period=_period(period, lo, hi),
            compare=pair,  # type: ignore[arg-type]
            lo=lo,
            hi=hi,
            filters=m.parse_filters(index, family, slot, weekday, dte, vix_band),
            min_n=min_n,
            list_id=list_,
            basis=basis,
        )
    except m.MatrixError as error:
        return _error(422, str(error))
    return out


@router.get("/cell")
def cell(
    view: str = "family_slot",
    row: str = Query(..., min_length=1),
    col: str = Query(..., min_length=1),
    period: str | None = None,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    index: str | None = None,
    family: str | None = None,
    slot: str | None = None,
    weekday: str | None = None,
    dte: str | None = None,
    vix_band: str | None = None,
    list_: str | None = Query(default=None, alias="list"),
    basis: str = "all",
) -> Any:
    if not (_KEY_RE.match(row) and _KEY_RE.match(col)):
        return _error(422, "row and col must be keys the matrix returned")
    try:
        lo, hi = _day(from_, "from"), _day(to, "to")
        return m.drill(
            m.load_cube(),
            m.load_journal(),
            view=view,
            row=row,
            col=col,
            period=_period(period, lo, hi),
            lo=lo,
            hi=hi,
            filters=m.parse_filters(index, family, slot, weekday, dte, vix_band),
            list_id=list_,
            basis=basis,
        )
    except m.MatrixError as error:
        return _error(422, str(error))
