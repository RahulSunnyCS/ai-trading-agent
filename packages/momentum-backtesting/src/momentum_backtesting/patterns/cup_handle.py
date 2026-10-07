"""Cup and handle (weekly bars, causal swing points).

At week k, for each left lip a (a swing high of the weekly closes, `pivots` reversal, confirmed
on or before k; most recent first):

- the cup bottom b is the lowest low after a (through k); the right lip r is the highest high
  after b and before k, so the handle is the weeks (r, k];
- cup length r - a within `cup.min_weeks`..`cup.max_weeks`, depth 1 - low_b / high_a within
  `cup.min_depth`..`cup.max_depth`, the right lip within `cup.right_lip_within_of_left` of the
  left (not above it by more than the same), nothing in between higher than both lips;
- U, not V: at least `cup.min_weeks_in_lower_third` weekly closes inside the cup in its lower
  third, and the bottom at least two weeks from either lip;
- a prior advance of at least `prior_advance` into the left lip (from the lowest low of the
  52 weeks before it);
- handle: `handle.min_weeks`..`handle.max_weeks` weeks, no high above the right lip, at most
  `handle.max_depth` deep, and (if `handle.must_be_in_upper_half`) its low in the upper half of
  the cup;
- no bad bar from a to k;
- (addendum 2) the left lip is the highest high of the `left_lip_high_of_weeks` weeks up to
  it, and the stock's setting passes `common.context` (near its 52-week high).

The pivot is the handle's highest high.
"""

from __future__ import annotations

import re

import numpy as np

from . import detector_params
from .bars import SymbolBars
from .common import Base, context
from .pivots import known_highs, zigzag

PATTERN = "cup_handle"


def _reversal(text: str) -> float:
    match = re.search(r"reversal (\d+(?:\.\d+)?)%", text)
    if not match:
        raise ValueError(f"cup_handle.pivots names no reversal: {text!r}")
    return float(match.group(1)) / 100


def scan(bars: SymbolBars, params: dict | None = None) -> list[Base | None]:
    p = params or detector_params(PATTERN)
    cup, handle = p["cup"], p["handle"]
    w = bars.weekly()
    pivots = zigzag(w.close, _reversal(p["pivots"]))
    out: list[Base | None] = [None] * len(w.close)
    setting = context(w, p)
    for k in range(len(w.close)):
        if not setting[k]:
            continue
        for lip in known_highs(pivots, k):
            a = lip.index
            if k - a > cup["max_weeks"] + handle["max_weeks"]:
                break
            base = _cup_at(w, bars, a, k, p)
            if base is not None:
                out[k] = base
                break
    return out


def _cup_at(w, bars: SymbolBars, a: int, k: int, p: dict) -> Base | None:
    cup, handle = p["cup"], p["handle"]
    if k - a < cup["min_weeks"] + handle["min_weeks"]:
        return None
    top_weeks = p.get("left_lip_high_of_weeks")
    if top_weeks and w.high[a] < w.high[max(0, a - top_weeks + 1) : a + 1].max():
        return None  # the left lip must be a real top, not a bump inside a slide
    b = a + 1 + int(np.argmin(w.low[a + 1 : k + 1]))
    if b >= k - handle["min_weeks"]:
        return None
    r = b + 1 + int(np.argmax(w.high[b + 1 : k]))
    weeks_handle = k - r
    if not handle["min_weeks"] <= weeks_handle <= handle["max_weeks"]:
        return None
    left, right, bottom = w.high[a], w.high[r], w.low[b]
    if not cup["min_weeks"] <= r - a <= cup["max_weeks"]:
        return None
    depth = 1 - bottom / left
    if not cup["min_depth"] <= depth <= cup["max_depth"]:
        return None
    within = cup["right_lip_within_of_left"]
    if not left * (1 - within) <= right <= left * (1 + within):
        return None
    if w.high[a + 1 : r].max(initial=-np.inf) > max(left, right):
        return None
    if b - a < 2 or r - b < 2:
        return None
    lower_third = bottom + (left - bottom) / 3
    if (w.close[a + 1 : r] <= lower_third).sum() < cup["min_weeks_in_lower_third"]:
        return None
    before = w.low[max(0, a - 52) : a + 1].min()
    if left < before * (1 + p["prior_advance"]):
        return None
    handle_low = w.low[r + 1 : k + 1].min()
    handle_high = w.high[r + 1 : k + 1].max()
    if handle_high > right:
        return None
    handle_depth = 1 - handle_low / right
    if handle_depth > handle["max_depth"]:
        return None
    if handle["must_be_in_upper_half"] and handle_low < bottom + (left - bottom) / 2:
        return None
    if w.bad[a : k + 1].any():
        return None
    date = lambda week: str(np.datetime_as_string(bars.dates[bars.week_end[week]], unit="D"))  # noqa: E731
    return Base(
        pivot=float(handle_high),
        start=int(w.start[a]),
        end=int(bars.week_end[k]),
        geometry={
            "left_lip": date(a),
            "bottom": date(b),
            "right_lip": date(r),
            "cup_weeks": r - a,
            "depth": round(float(depth), 4),
            "right_vs_left": round(float(right / left - 1), 4),
            "handle_weeks": weeks_handle,
            "handle_depth": round(float(handle_depth), 4),
            "prior_advance": round(float(left / before - 1), 3),
        },
    )
