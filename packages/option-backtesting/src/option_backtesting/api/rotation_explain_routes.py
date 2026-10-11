"""`/legwise/rotation/explain` and `/legwise/rotation/ic`: why a list picked what it picked, and
whether the ranking predicts the day's results (Options Lab rotation workspace). Read-only over
`TRADING_DATA_ROOT/rotation/`; the maths is `rotation/explain.py` and `rotation/rankic.py`.

    GET /legwise/rotation/explain?day=&list=&top=      the breakdown of one list's picks on one day
    GET /legwise/rotation/ic?from=&to=&list=&mode=     the daily rank correlation of the ranking

`explain` rebuilds the ranking from the stored results before the day and says whether it
reproduces the journal entry; without `day` it uses the latest recorded day, else the latest day
that can be reconstructed. Errors come back as `{"error": ...}` (what the dashboard's api.ts reads).
"""

from __future__ import annotations

import time
from datetime import date
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ..rotation import explain as ex
from ..rotation import rankic
from ..rotation.lists import LISTS
from ..rotation.variants import variant_names

router = APIRouter(prefix="/legwise/rotation")

CACHE_SECONDS = 30.0  # results are written nightly; a picker should not re-read 298 files a click
MAX_TOP = 50

_cache: dict[str, Any] = {"at": 0.0, "root": None, "value": None}

_STATUS = {
    "bad_list": 422,
    "no_universe": 404,
    "no_day": 404,
    "short_history": 404,
    "decomposition": 500,
}


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _snapshot() -> ex.Snapshot:
    from ..fyers.daily import data_dir

    root = data_dir()
    now = time.monotonic()
    if (
        _cache["value"] is not None
        and _cache["root"] == root
        and now - _cache["at"] < CACHE_SECONDS
    ):
        return _cache["value"]
    value = ex.load_snapshot(root, variant_names())
    _cache.update(at=now, root=root, value=value)
    return value


def _day(raw: str | None, label: str) -> date | None | JSONResponse:
    if not raw:
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return _error(422, f"{label} must be YYYY-MM-DD")


def _list_key(raw: str | None) -> str | JSONResponse:
    key = (raw or "A").upper()
    if key not in LISTS:
        return _error(422, f"list must be one of {', '.join(LISTS)}")
    return key


@router.get("/explain")
def explain(day: str | None = None, list: str | None = None, top: str | None = None) -> Any:  # noqa: A002
    key = _list_key(list)
    if isinstance(key, JSONResponse):
        return key
    chosen = _day(day, "day")
    if isinstance(chosen, JSONResponse):
        return chosen
    try:
        n_top = 10 if top in (None, "") else int(top)
    except ValueError:
        return _error(422, "top must be a whole number")
    if not 0 <= n_top <= MAX_TOP:
        return _error(422, f"top must be between 0 and {MAX_TOP}")
    try:
        snap = _snapshot()
    except ex.ExplainError as error:
        return _error(_STATUS.get(error.code, 422), error.message)
    if not snap.days:
        return _error(404, "no rotation results are stored yet: run `obt rotation update`")
    available = snap.memo.get("range")
    if available is None:
        available = snap.memo["range"] = ex.explain_range(snap)
    if chosen is None:
        if available["default"] is None:
            return _error(
                404,
                f"no day can be explained yet: a list needs {ex.WARMUP} days of stored results "
                f"and {len(snap.days)} are stored",
            )
        chosen = date.fromisoformat(available["default"])
    try:
        body = ex.explain(snap, chosen, key, top=n_top)
    except ex.ExplainError as error:
        return _error(_STATUS.get(error.code, 422), error.message)
    body["available"] = available
    return body


@router.get("/ic")
def ic(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    list: str | None = None,  # noqa: A002
    mode: str | None = None,
) -> Any:
    key = _list_key(list)
    if isinstance(key, JSONResponse):
        return key
    chosen_mode = mode or "forward"
    if chosen_mode not in ("forward", "research"):
        return _error(422, "mode must be forward or research")
    start, end = _day(from_, "from"), _day(to, "to")
    for bound in (start, end):
        if isinstance(bound, JSONResponse):
            return bound
    if start and end and start > end:
        return _error(422, "from must not be after to")
    try:
        snap = _snapshot()
    except ex.ExplainError as error:
        return _error(_STATUS.get(error.code, 422), error.message)
    if not snap.days:
        return _error(404, "no rotation results are stored yet: run `obt rotation update`")
    return rankic.analyse(snap, key, chosen_mode, start, end)
