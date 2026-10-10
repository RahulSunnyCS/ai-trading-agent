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

import threading
from datetime import date
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from ..rotation import daylog, pulse, store
from ..rotation import explain as ex
from ..rotation import matrix as mx
from ..rotation.lists import LISTS
from ..rotation.variants import variant_names

router = APIRouter(prefix="/legwise/rotation/pulse")

# The snapshot is the slow read (298 files); it is reused only while the files it was built from are
# the ones the cube was built from, so the windows, the rank and the picks cannot describe two
# different stores. The key is the cube object itself (`load_cube` returns the same one while the
# result files and days.csv are unchanged) and the journal file's stat.
_snap_cache: dict[str, Any] = {"root": None, "cube": None, "journal": None, "value": None}
_snap_lock = threading.Lock()


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _journal_stat(root: Path) -> tuple[int, int] | None:
    try:
        st = store.journal_path(root).stat()
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


def _snapshot(root: Path, cube: mx.Cube) -> ex.Snapshot:
    with _snap_lock:
        journal_key = _journal_stat(root)
        c = _snap_cache
        if (
            c["value"] is not None
            and c["root"] == root
            and c["cube"] is cube
            and c["journal"] == journal_key
        ):
            return c["value"]
        value = ex.load_snapshot(root, variant_names())
        c.update(root=root, cube=cube, journal=journal_key, value=value)
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
        snap = _snapshot(root, cube)
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
