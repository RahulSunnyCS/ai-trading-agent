"""`/legwise/rotation/pulse`: the Family pulse card's read layer (Options Lab rotation workspace,
widget 11). The maths is `rotation/pulse.py` over the Strategy Matrix's cached cube; nothing here
computes a figure and no route writes anything.

    GET /legwise/rotation/pulse?as_of=&list=&index=   the 12 family-band cells, as of one session

`as_of` (YYYY-MM-DD) is the last session the windows include (default: the latest stored one); the
"ranking sees" column is the rank for the pick whose history ends there. `list` (A | B | C | REF,
default A) is the list whose pick share is shown; `index` (NIFTY | SENSEX | both) narrows the cell
means only, never the rank. Errors come back as `{"error": ...}`.
"""

from __future__ import annotations

import time
from datetime import date
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..rotation import daylog, pulse
from ..rotation import explain as ex
from ..rotation import matrix as mx
from ..rotation.lists import LISTS
from ..rotation.variants import variant_names

router = APIRouter(prefix="/legwise/rotation/pulse")

CACHE_SECONDS = 30.0  # results are written nightly; a page refresh should not re-read 298 files
_snap_cache: dict[str, Any] = {"at": 0.0, "root": None, "value": None}


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _snapshot(root) -> ex.Snapshot:
    now = time.monotonic()
    if (
        _snap_cache["value"] is not None
        and _snap_cache["root"] == root
        and now - _snap_cache["at"] < CACHE_SECONDS
    ):
        return _snap_cache["value"]
    value = ex.load_snapshot(root, variant_names())
    _snap_cache.update(at=now, root=root, value=value)
    return value


@router.get("")
def get_pulse(
    as_of: str | None = None,
    list: str | None = None,  # noqa: A002
    index: str | None = None,
) -> Any:
    from ..fyers.daily import data_dir

    key = (list or "A").upper()
    if key not in LISTS:
        return _error(422, f"list must be one of {', '.join(LISTS)}")
    day: date | None = None
    if as_of:
        try:
            day = date.fromisoformat(as_of)
        except ValueError:
            return _error(422, "as_of must be YYYY-MM-DD")
    try:
        idx = pulse.parse_index(index)
        root = data_dir()
        cube = mx.load_cube(root)
        snap = _snapshot(root)
        rec = daylog.reconstruction(root)
        return pulse.compute(
            cube,
            snap,
            as_of=day,
            list_id=key,
            index=idx,
            picks_fn=None if rec.error else rec.picks,
            reconstructable=None if rec.error else rec.days_available,
            is_trading=daylog.is_trading_day,
        )
    except (pulse.PulseError, ex.ExplainError) as error:
        return _error(422, getattr(error, "message", None) or str(error))
