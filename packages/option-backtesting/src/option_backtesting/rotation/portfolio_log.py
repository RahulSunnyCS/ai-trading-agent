"""The portfolio stop over the Rotation log's baskets (BL-095 Phase 2).

`portfolio.py` is the calculation; this takes the picks of a list-day from the daily log
(`daylog.build_day` / `build_log`: recorded, or reconstructed from the research history) and
returns what that book did under a typed stop and trailing mode. Read-only: it replays strategy
files over the collected lake and stores nothing, and the log's own figures are never altered.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

from ..legwise.market import N_MINUTES, minute_label
from . import daylog
from . import portfolio as pf
from .portfolio import BookDay, PortfolioStopError, Trail, normalise_stop

LISTS = ("A", "B", "C", "REF")
MAX_DAYS = 400
MATCH_TOLERANCE = 0.5  # the stored results are rounded to the paisa a pick


class LogBookError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


def _picks(block: dict) -> list[tuple[str, int]]:
    names = [p["name"] for p in block["picks"]]
    if not names:
        raise LogBookError(409, "the list has no picks that day")
    lots_each = int(block["lots"]) // len(names)
    return [(n, lots_each) for n in names]


def _setting(stop: float | None, trail: Trail | None) -> dict:
    return {"amount": normalise_stop(stop), "trail": None if trail is None else trail.text()}


def _book_row(block: dict, book: BookDay) -> dict:
    return {
        "lots": block["lots"],
        "gross_log": block["gross"],
        "gross_without": round(book.gross_without, 2),
        "gross_with": round(book.gross_with, 2),
        "stop_minute": book.stop_minute,
        "stop_label": book.stop_label,
        "fired_by": book.fired_by,
        "matches_log": abs(book.gross_without - block["gross"]) < MATCH_TOLERANCE,
    }


def list_day(
    day: date,
    list_key: str,
    stop_inr: float | None,
    trail: Trail | None,
    source: str = "all",
    root: Path | None = None,
    track: str | None = None,
    lots_per: int | None = None,
) -> dict:
    """One list's basket on one day: the combined and each pick's path, the stop level and where it
    fired. `source` (`recorded`, `reconstructed` or `all`) is a filter: a day that exists only as
    the other kind is a 404, never silently shown under the wrong label. `LogBookError` carries
    the HTTP status for a day or list that cannot be shown. `track` reads a parallel track's
    journal and `lots_per` books every pick at that many lots (as `daylog.build_day`)."""
    if list_key not in LISTS:
        raise LogBookError(422, f"list must be one of {', '.join(LISTS)}")
    if source not in daylog.SOURCES:
        raise LogBookError(422, f"source must be one of {', '.join(daylog.SOURCES)}")
    body = daylog.build_day(day, root, track=track, lots_per=lots_per)
    if body is None:
        raise LogBookError(404, f"{day} is not a recorded or reconstructable day")
    if source != "all" and body.get("source") != source:
        raise LogBookError(404, f"{day} is a {body.get('source')} day, not a {source} one")
    block = (body.get("lists") or {}).get(list_key)
    if block is None:
        raise LogBookError(404, f"no list {list_key} on {day}")
    if not block.get("scored"):
        missing = ", ".join(block.get("missing") or []) or "its picks"
        raise LogBookError(409, f"{list_key} on {day} is not scored yet: waiting on {missing}")
    from ..fyers.daily import data_dir

    root = root or data_dir()
    picks = _picks(block)
    try:
        loaded: dict = {}
        book = pf.book_day(root, day, picks, stop_inr, trail, loaded)
        paths = {n: pf.one_lot_path(root, day, n, loaded) for n, _ in picks}
    except PortfolioStopError as error:
        raise LogBookError(404, str(error)) from error
    lots = dict(picks)
    path_by_name = {m["name"]: m for m in book.members}
    return {
        "day": day.isoformat(),
        "list": list_key,
        "track": track,
        "basis": "gross",
        "setting": _setting(stop_inr, trail),
        "book": _book_row(block, book),
        "minutes": N_MINUTES,
        "first_minute_label": minute_label(0),
        "combined": [round(v, 2) for v in book.combined],
        "stopped": [round(v, 2) for v in book.stopped],
        "level": [None if v is None else round(v, 2) for v in book.level],
        "picks": [
            {
                "name": n,
                "lots": lots[n],
                "role": next((p["role"] for p in block["picks"] if p["name"] == n), None),
                "gross": path_by_name[n]["gross_without"],
                "at_stop": path_by_name[n]["at_stop"],
                "path": [round(lots[n] * v, 2) for v in paths[n]],
            }
            for n in lots
        ],
    }


def days(
    start: date | None,
    end: date | None,
    stop_inr: float | None,
    trail: Trail | None,
    source: str = "recorded",
    root: Path | None = None,
    track: str | None = None,
    lots_per: int | None = None,
) -> dict:
    """Every scored list-day in the window, with and without the portfolio stop. `track` reads a
    parallel track's journal (list C only), `lots_per` books every pick at that many lots (the
    Rotation page asks for 1; default the entry's recorded lots)."""
    from ..fyers.daily import data_dir

    root = root or data_dir()
    log = daylog.build_log(root, start, end, source, track=track, lots_per=lots_per)
    rows: list[dict] = []
    errors: list[dict] = []
    totals = {k: {"n": 0, "without": 0.0, "with": 0.0, "fired": 0} for k in LISTS}
    if len(log["rows"]) > MAX_DAYS:
        raise LogBookError(422, f"at most {MAX_DAYS} days at a time; narrow from / to")
    for row in log["rows"]:
        day = date.fromisoformat(row["day"])
        loaded: dict = {}
        lists: dict[str, dict] = {}
        for key, block in (row.get("lists") or {}).items():
            if key not in LISTS or not block.get("scored"):
                continue
            try:
                book = pf.book_day(root, day, _picks(block), stop_inr, trail, loaded)
            except (PortfolioStopError, LogBookError) as error:
                errors.append({"day": row["day"], "list": key, "error": str(error)})
                continue
            lists[key] = _book_row(block, book)
            t = totals[key]
            t["n"] += 1
            t["without"] += book.gross_without
            t["with"] += book.gross_with
            t["fired"] += book.stop_minute is not None
        if lists:
            rows.append({"day": row["day"], "lists": lists})
    return {
        "basis": "gross",
        "source": source,
        "track": track,
        "lots_per_strategy": lots_per,
        "setting": _setting(stop_inr, trail),
        "rows": rows,
        "errors": errors,
        "totals": {
            k: {**v, "without": round(v["without"], 2), "with": round(v["with"], 2)}
            for k, v in totals.items()
            if v["n"]
        },
    }
