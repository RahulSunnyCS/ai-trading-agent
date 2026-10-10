"""`/legwise/rotation/log`, `/day/{day}` and `/placement`: the rotation workspace's daily log (the
decision-to-result record) and the owner's placement record.

    GET  /legwise/rotation/log?from=&to=&source=   one row per journal entry, plus the trading days
                                                   with no entry (`not_recorded`), plus counters
    GET  /legwise/rotation/day/{day}               one day in full: the four baskets, each pick's
                                                   outcome, the chain hash and the placement rows
    GET  /legwise/rotation/placement?from=&to=     the placement record: current state and history
    POST /legwise/rotation/placement               one new row: placed | changed | not_placed
    GET  /legwise/rotation/forensics?variant=&day= one rotation variant's day re-simulated for the
                                                   existing Day forensics view

The figures are `rotation/daylog.py`'s and the picks are the journal's; nothing here computes a
ranking. The only write is a row appended to `rotation/placements.jsonl` (`rotation/placements.py`),
a file nothing else reads; the journal and the stored results are never written.

Errors come back as `{"error": ...}` (what the dashboard's api.ts reads), as in
`correlation_routes.py`.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from ..data.reference.loader import default_reference_data
from ..fyers.daily import data_dir
from ..legwise import anatomy, forensics
from ..legwise import store as legwise_store
from ..legwise.engine import simulate_day
from ..legwise.market import load_day
from ..legwise.schema import load_legwise
from ..rotation import daylog, journal, placements
from ..rotation.lists import LISTS, SIZING_DATE
from ..rotation.variants import strategy_path, variant_names

router = APIRouter(prefix="/legwise/rotation")


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _day(raw: str | None, label: str) -> date | None | JSONResponse:
    if not raw:
        return None
    try:
        parsed = date.fromisoformat(raw)
    except ValueError:
        return _error(422, f"{label} must be YYYY-MM-DD")
    return parsed if parsed.isoformat() == raw else _error(422, f"{label} must be YYYY-MM-DD")


def _window(from_: str | None, to: str | None) -> tuple[date | None, date | None] | JSONResponse:
    start, end = _day(from_, "from"), _day(to, "to")
    for bound in (start, end):
        if isinstance(bound, JSONResponse):
            return bound
    assert not isinstance(start, JSONResponse) and not isinstance(end, JSONResponse)
    if start and end and start > end:
        return _error(422, "from must not be after to")
    return start, end


@router.get("/log")
def log(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    source: str = "recorded",
) -> Any:
    window = _window(from_, to)
    if isinstance(window, JSONResponse):
        return window
    if source not in daylog.SOURCES:
        return _error(422, f"source must be one of {', '.join(daylog.SOURCES)}")
    try:
        return daylog.build_log(start=window[0], end=window[1], source=source)
    except journal.JournalCorrupt as error:
        return _error(500, f"the journal cannot be read: {error}")


@router.get("/day/{day}")
def day_detail(day: str) -> Any:
    parsed = _day(day, "day")
    if isinstance(parsed, JSONResponse):
        return parsed
    if parsed is None:
        return _error(422, "day must be YYYY-MM-DD")
    try:
        body = daylog.build_day(parsed)
    except journal.JournalCorrupt as error:
        return _error(500, f"the journal cannot be read: {error}")
    if body is None:
        return _error(
            404,
            f"{day} is not a recorded day, an expected one, or a day the research history can "
            "re-score (it needs 63 earlier days of results)",
        )
    return body


@router.get("/placement")
def placement_read(
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
) -> Any:
    window = _window(from_, to)
    if isinstance(window, JSONResponse):
        return window
    read = placements.read()
    rows = placements.in_range(read.rows, window[0], window[1])
    current = placements.current(rows)
    return {
        "current": [current[k] for k in sorted(current)],
        "history": rows,
        "skipped_lines": read.skipped,
        "statuses": list(placements.STATUSES),
        "note_max": placements.NOTE_MAX,
    }


class PlacementBody(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    day: str = Field(min_length=10, max_length=10)
    list: str = Field(min_length=1, max_length=8)
    status: str = Field(min_length=1, max_length=16)
    note: str = Field(default="", max_length=placements.NOTE_MAX)


@router.post("/placement")
def placement_write(body: PlacementBody) -> Any:
    if body.list not in LISTS:
        return _error(422, f"list must be one of {', '.join(LISTS)}")
    try:
        row = placements.append(body.day, body.list, body.status, body.note)
    except placements.PlacementError as error:
        return _error(422, str(error))
    return {"row": row}


_HHMM_RE = re.compile(r"^\d{2}:\d{2}$")


@router.get("/forensics")
def variant_forensics(variant: str, day: str, cuts: str | None = None) -> Any:
    """One rotation variant's day, re-simulated for the Day forensics view (minute MTM against the
    index, markers, per-leg attribution). The variants are not saved strategies, so `/legwise/day`
    cannot open them. The simulation is the nightly update's own call (the same strategy file and
    the lot-sizing date the stored results were made with), and the response says whether its
    gross equals the stored one."""
    if variant not in variant_names():  # matched against the enumerated files, never a path
        return _error(404, f"{variant!r} is not one of the rotation variants")
    parsed_day = _day(day, "day")
    if isinstance(parsed_day, JSONResponse):
        return parsed_day
    if parsed_day is None:
        return _error(422, "day must be YYYY-MM-DD")
    parts = [c for c in (cuts or ",".join(anatomy.DEFAULT_CUTS)).split(",") if c]
    if any(not _HHMM_RE.match(p) for p in parts):
        return _error(422, "cuts must be comma-separated HH:MM times, e.g. 10:30,13:30")
    try:
        parsed_cuts = anatomy.parse_cuts(parts)
    except ValueError as error:
        return _error(422, str(error))
    spec = load_legwise(strategy_path(variant))
    root = data_dir()
    try:
        data = load_day(root, spec.underlying, parsed_day)
    except FileNotFoundError:
        return _error(404, f"no collected {spec.underlying} data for {day}")
    result = simulate_day(spec, data, default_reference_data(), date.fromisoformat(SIZING_DATE))
    try:
        shape = anatomy.anatomy_day(root, spec.underlying, parsed_day, parsed_cuts)
    except Exception:  # noqa: BLE001 - the index shape is an extra; the replay stands without it
        shape = None
    body = forensics.build_forensics(
        spec, data, result, parsed_cuts, shape, legwise_store.spec_hash(spec)
    )
    stored = daylog.read_rows(variant, root).get(parsed_day)
    simulated = round(result.gross, 2)
    body["strategy_id"] = variant
    body["rotation"] = {
        "variant": variant,
        "stored_gross": None if stored is None else stored["gross"],
        "simulated_gross": simulated,
        "matches_stored": stored is not None and abs(stored["gross"] - simulated) < 0.01,
    }
    return body
