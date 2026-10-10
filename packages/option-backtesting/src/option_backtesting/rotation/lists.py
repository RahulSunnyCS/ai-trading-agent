"""The lists the forward journal records (registered in BL-058 Phase 0b, 2026-10-10).

All are DRB-6W3L2 in shape: 3 strategies x 2 lots from the 248-variant whole-day list, at least 2
Widesl strategies, the Buy add-on when a Buy variant ranks in the overall top 10. They differ
only in how the daily composite is weighted. Never edit a list after the first entry: add a
new name.
"""

from __future__ import annotations

from dataclasses import dataclass

#: fit lookbacks (days, weight) of the weekday / days-to-expiry / VIX-band criteria
LOOKBACKS_NEW: tuple[tuple[int, float], ...] = ((5, 0.30), (21, 0.25), (63, 0.25), (126, 0.20))
LOOKBACKS_REF: tuple[tuple[int, float], ...] = ((5, 0.40), (21, 0.30), (63, 0.30))

N_CORE = 3  # strategies a day (each traded with LOTS_PER lots)
LOTS_PER = 2
MIN_WIDE_N = 2  # at least this many Widesl strategies
N_BUY = 1  # Buy strategies (of LOTS_PER lots) when one ranks in the top BUY_TOP
BUY_TOP = 10
WARMUP = 63  # a list needs this many earlier days of results before it can pick
#: lots are sized with this date's lot size, so a later lot-size revision cannot move the series
SIZING_DATE = "2026-10-12"


@dataclass(frozen=True)
class RotationList:
    name: str
    description: str
    #: weights of the composite's criteria (fractions): recent, weekday, dte, vix, rfam
    weights: dict[str, float]
    lookbacks: tuple[tuple[int, float], ...]


LISTS: dict[str, RotationList] = {
    "A": RotationList(
        "A",
        "own 5 / weekday 34 / dte 33 / VIX 23 / family-band 5 (BL-075 stage 1, the safest cell)",
        {"recent": 0.05, "weekday": 0.34, "dte": 0.33, "vix": 0.23, "rfam": 0.05},
        LOOKBACKS_NEW,
    ),
    "B": RotationList(
        "B",
        "own 0 / weekday 36 / dte 35 / VIX 24 / family-band 5 (BL-075, best Jan-Aug 2025)",
        {"recent": 0.0, "weekday": 0.36, "dte": 0.35, "vix": 0.24, "rfam": 0.05},
        LOOKBACKS_NEW,
    ),
    "C": RotationList(
        "C",
        "own 15 / weekday 30 / dte 30 / VIX 20 / family-band 5 (BL-075, best 2025-26)",
        {"recent": 0.15, "weekday": 0.30, "dte": 0.30, "vix": 0.20, "rfam": 0.05},
        LOOKBACKS_NEW,
    ),
    "REF": RotationList(
        "REF",
        "the live baseline: own 33 / weekday 25 / dte 25 / VIX 17, lookbacks 5/21/63",
        {"recent": 0.33, "weekday": 0.25, "dte": 0.25, "vix": 0.17, "rfam": 0.0},
        LOOKBACKS_REF,
    ),
}

for _l in LISTS.values():
    assert abs(sum(_l.weights.values()) - 1.0) < 1e-9, _l.name
    assert abs(sum(w for _, w in _l.lookbacks) - 1.0) < 1e-9, _l.name
