"""
Same-session, path-dependent scalar features — computed once per session
from a source series' `(open, closes)` pair, wherever that source came from
(a builtin cash/fut series or another already-evaluated feature).
"""

from __future__ import annotations

from collections.abc import Sequence


def max_runup(source_open: float, source_closes: Sequence[float]) -> float:
    """Largest `(current value - running low so far)` seen anywhere in the
    session. Verbatim port of the reference's `max_runup()`: the running low
    is folded in AFTER checking that bar's runup, not before — this is the
    OPPOSITE update order from the engine's own running-low ladder anchor
    (engine/state.py), which folds in the current bar's value BEFORE its
    fire-check. The two must not share one helper."""
    lo = source_open
    mx = 0.0
    for p in source_closes:
        mx = max(mx, p - lo)
        lo = min(lo, p)
    return mx


def session_high(
    source_open: float, source_closes: Sequence[float], until_bar: int | None
) -> float:
    """Highest value from the session's pre-bar open through `until_bar`
    inclusive (None = the pre-bar open only, i.e. `until` precedes the first
    bar)."""
    values = [source_open, *source_closes[: (until_bar + 1) if until_bar is not None else 0]]
    return max(values)


def session_low(source_open: float, source_closes: Sequence[float], until_bar: int | None) -> float:
    values = [source_open, *source_closes[: (until_bar + 1) if until_bar is not None else 0]]
    return min(values)
