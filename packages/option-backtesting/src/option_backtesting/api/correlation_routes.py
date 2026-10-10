"""`/legwise/correlation*`: how the strategies' daily P&L move together, for the Options Lab's
Correlation tab (BL-090). The maths is `analytics/correlation.py` and the strategies are found by
`rotation/series.py`, the same code `obt rotation corr` runs; nothing here computes a figure.

    GET /legwise/correlation/available   what has results now, and the groups a picker offers
    GET /legwise/correlation             the matrices, per-strategy stats, basket, drift
    GET /legwise/correlation/pick        a basket whose members are not alike (in-sample)

Errors come back as `{"error": ...}` (what the dashboard's api.ts reads). Selector text is only
ever matched against the enumerated strategy names, never turned into a path.
"""

from __future__ import annotations

import re
import time
from collections import Counter
from datetime import date
from typing import Any

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from ..analytics import correlation as c
from ..rotation import series as rseries
from ..rotation.variants import is_dir, is_wide

router = APIRouter(prefix="/legwise/correlation")

MAX_STRATEGIES = 80  # a matrix this size is ~25k numbers a measure; more is unreadable anyway
MAX_SELECTORS = 40
CACHE_SECONDS = 30.0  # results are written nightly; a picker should not re-read 248 files a click
_SELECTOR_RE = re.compile(r"^[A-Za-z0-9_:*?.+\[\]-]{1,80}$")
_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")

_cache: dict[str, Any] = {"at": 0.0, "root": None, "value": None}


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message})


def _available() -> list[rseries.Available]:
    from ..fyers.daily import data_dir

    root = data_dir()
    now = time.monotonic()
    if (
        _cache["value"] is not None
        and _cache["root"] == root
        and now - _cache["at"] < CACHE_SECONDS
    ):
        return _cache["value"]
    value = rseries.available(root)
    _cache.update(at=now, root=root, value=value)
    return value


def _split(raw: str | None, pattern: re.Pattern[str], what: str, limit: int) -> list[str] | str:
    parts = [p.strip() for p in (raw or "").split(",") if p.strip()]
    if len(parts) > limit:
        return f"at most {limit} {what}"
    bad = [p for p in parts if not pattern.match(p)]
    return f"unusable {what}: {bad[0]!r}" if bad else parts


def _day(raw: str | None, label: str) -> date | None | JSONResponse:
    if not raw:
        return None
    try:
        return date.fromisoformat(raw)
    except ValueError:
        return _error(422, f"{label} must be YYYY-MM-DD")


def _selected(
    selectors: str | None, include_stale: bool
) -> tuple[list[rseries.Available], list[str]] | JSONResponse:
    parsed = _split(selectors, _SELECTOR_RE, "selectors", MAX_SELECTORS)
    if isinstance(parsed, str):
        return _error(422, parsed)
    try:
        chosen = rseries.resolve(parsed, _available(), include_stale)
    except rseries.SelectorError as error:
        return _error(404, str(error))
    if len(chosen) > MAX_STRATEGIES:
        return _error(
            422,
            f"that selects {len(chosen)} strategies; at most {MAX_STRATEGIES} can be compared "
            "at once. Narrow it by start time, family or index",
        )
    return chosen, parsed or rseries.DEFAULT_SELECTORS


def _parts(name: str) -> tuple[str | None, str | None, str | None]:
    bits = name.split("_")
    return (bits[0], bits[1], bits[2]) if len(bits) == 3 else (None, None, None)


def _family_tokens(name: str, family: str) -> set[str]:
    tokens = {family}
    if is_wide(name):
        tokens.add("wide")
    if is_dir(name):
        tokens.add("dir")
    return tokens


@router.get("/available")
def available() -> Any:
    rows = _available()
    groups: dict[str, Counter[str]] = {
        "slot": Counter(),
        "family": Counter(),
        "index": Counter(),
        "kind": Counter(),
    }
    out = []
    for a in rows:
        index, family, slot = _parts(a.name) if a.kind == "variant" else (None, None, None)
        out.append(
            {
                "name": a.name,
                "kind": a.kind,
                "index": index,
                "family": family,
                "slot": slot,
                "first": a.first.isoformat(),
                "last": a.last.isoformat(),
                "n_days": a.n_days,
                "stale": a.stale,
            }
        )
        if a.stale:
            continue
        groups["kind"][a.kind] += 1
        if index is not None and slot is not None and family is not None:
            groups["slot"][slot] += 1
            groups["index"][index] += 1
            # counted the way the `family:` selector matches: `wide` is every Widesl incl. the
            # closest-premium ones, `dir` includes Dir ITM1; a specific token counts itself too
            for token in _family_tokens(a.name, family):
                groups["family"][token] += 1
    return {
        "strategies": out,
        "groups": {k: dict(sorted(v.items())) for k, v in groups.items()},
        "max_strategies": MAX_STRATEGIES,
        "default_selectors": rseries.DEFAULT_SELECTORS,
    }


@router.get("")
def correlation(
    selectors: str | None = None,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    window: int = Query(default=c.WINDOW, ge=10, le=252),
    include_stale: bool = False,
) -> Any:
    start, end = _day(from_, "from"), _day(to, "to")
    for bound in (start, end):
        if isinstance(bound, JSONResponse):
            return bound
    picked = _selected(selectors, include_stale)
    if isinstance(picked, JSONResponse):
        return picked
    chosen, used = picked
    if len(chosen) < 2:
        return _error(422, "pick at least two strategies to compare")
    try:
        report = c.analyse([a.series() for a in chosen], start=start, end=end, window=window)
    except ValueError as error:
        return _error(422, str(error))
    return {
        **c.to_json(report),
        "selectors": used,
        "from": start.isoformat() if start else None,
        "to": end.isoformat() if end else None,
        "stale": [a.name for a in chosen if a.stale],
        "in_sample": True,
    }


@router.get("/pick")
def pick(
    selectors: str | None = None,
    k: int = Query(default=3, ge=1, le=20),
    max_corr: float = Query(default=0.6, gt=-1.0, le=1.0),
    measure: str = "pearson",
    require: str | None = None,
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = None,
    include_stale: bool = False,
) -> Any:
    if measure not in c.MEASURES:
        return _error(422, f"measure must be one of {', '.join(c.MEASURES)}")
    start, end = _day(from_, "from"), _day(to, "to")
    for bound in (start, end):
        if isinstance(bound, JSONResponse):
            return bound
    needed = _split(require, _NAME_RE, "required names", 20)
    if isinstance(needed, str):
        return _error(422, needed)
    picked = _selected(selectors, include_stale)
    if isinstance(picked, JSONResponse):
        return picked
    chosen, used = picked
    if len(chosen) < 2:
        return _error(422, "pick at least two strategies to choose between")
    try:
        report = c.analyse([a.series() for a in chosen], start=start, end=end)
        basket = c.pick_diverse(report, k, max_corr, measure=measure, require=needed)
    except ValueError as error:
        return _error(422, str(error))
    return {
        **c.basket_to_json(basket),
        "selectors": used,
        "n_days": report.n_days,
        "from": report.days[0].isoformat(),
        "to": report.days[-1].isoformat(),
        "candidates": len(chosen),
    }
