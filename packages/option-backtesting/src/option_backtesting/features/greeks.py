"""`greek` — a single point-in-time snapshot per session, read from
`Cache.get_greeks`."""

from __future__ import annotations

from datetime import date, time

from ..bartime import time_to_bar_index
from ..data.cache import Cache
from ..features.registry import GreekFeature, parse_leg_ref
from ..strategy.schema import Universe

_FIELD_TO_COLUMN = {
    "iv": "implied_vol",
    "delta": "delta",
    "theta": "theta",
    "gamma": "gamma",
    "vega": "vega",
    "rho": "rho",
}


def evaluate_greek(
    feature: GreekFeature,
    universe: Universe,
    cache: Cache,
    d: date,
    bar_times: list[time],
) -> float:
    rule, right = parse_leg_ref(feature.leg)
    rows = cache.get_greeks(universe.underlying, universe.timeframe, rule, right, d, d)
    if not rows:
        raise ValueError(f"No greeks for {universe.underlying} {rule}.{right} on {d}")
    idx = time_to_bar_index(bar_times, feature.at)
    if idx is None:
        raise ValueError(
            f"greek feature 'at': {feature.at!r} precedes the session's first bar — "
            f"greeks have no pre-bar snapshot."
        )
    value = getattr(rows[idx], _FIELD_TO_COLUMN[feature.field])
    if value is None:
        raise ValueError(
            f"Greek field {feature.field!r} is null for {universe.underlying} "
            f"{rule}.{right} at {feature.at} on {d}."
        )
    return value
