"""The daily log over a span of days, kept for a short time, for the cards that read a list's
history (drawdown episodes, selection drift; BL-058 Phase 4). Read-only.

`daylog.build_log` is the expensive step (journal read, chain check, re-scoring of the days before
the journal began, placements) and returns all four lists, so a change of list or of a card's own
filter must not rebuild it. Two spans are enough for the cards:

* ``P1`` / ``P2``: the registered research periods;
* ``recent``: from the start of P1 to the latest day, which holds the research history and the
  forward days together.
"""

from __future__ import annotations

import threading
import time
from pathlib import Path

from . import daylog
from .matrix import NAMED

SPANS = ("P1", "P2", "recent")
#: how long a built log is reused; the files change once a night and at 09:16
LOG_SECONDS = 30.0
_lock = threading.Lock()
_cache: dict[tuple[str, str], tuple[float, dict]] = {}


def span_bounds(span: str):
    """(start, end) of a span; end is None for `recent`."""
    if span == "recent":
        return NAMED["P1"][0], None
    return NAMED[span][0], NAMED[span][1]


def daily_log(root: Path, span: str) -> dict:
    """`daylog.build_log(source="all")` over the span, reused for `LOG_SECONDS`."""
    if span not in SPANS:
        raise ValueError(f"span must be one of {', '.join(SPANS)}")
    key = (str(root), span)
    now = time.monotonic()
    with _lock:
        hit = _cache.get(key)
    if hit is not None and now - hit[0] < LOG_SECONDS:
        return hit[1]
    start, end = span_bounds(span)
    value = daylog.build_log(root, start=start, end=end, source="all")
    with _lock:
        _cache[key] = (now, value)
    return value


def clear() -> None:
    with _lock:
        _cache.clear()
