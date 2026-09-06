"""
Shared bar-time-grid helpers. A single time grid (the `"HH:MM"` bar-close
labels for a session, e.g. the golden fixture's 24 quarter-hour bars from
09:30 to 15:15) is used by both the feature evaluator (features/evaluator.py,
for `session_high`/`session_low`'s `until` cutoff) and the engine loop
(engine/loop.py, for `entry.time`/`fallback.time`/`exits[].at`) — kept in one
place, top-level, so neither package depends on the other for it.
"""

from __future__ import annotations

from datetime import time


def parse_bar_times(times: list[str]) -> list[time]:
    return [time.fromisoformat(t) for t in times]


def time_to_bar_index(bar_times: list[time], target: str) -> int | None:
    """Returns None if `target` strictly precedes the session's first bar
    close — the caller's PRE_BAR sentinel case (e.g. an entry time like
    "09:17" that falls before the first 15m bar closes at "09:30", resolved
    instead via the pre-bar `open` snapshot). Otherwise requires an EXACT
    match against a bar's close time and raises if none exists — ladder/
    fallback/exit times are always chosen to align with a real bar close in
    the reference, so a non-aligned time is a configuration error to
    surface, not something to silently round."""
    t = time.fromisoformat(target)
    if t < bar_times[0]:
        return None
    for i, bt in enumerate(bar_times):
        if bt == t:
            return i
    raise ValueError(f"Time {target!r} does not align with any bar close in this session's grid")
