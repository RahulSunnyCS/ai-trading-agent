"""
Bar-adjacent features pulled straight from `Cache`: `leg_sum` and `raw`
(per-bar), `gap` (scalar). `resolve_builtin_series` is the one place a
builtin `cash`/`fut` source turns into an `(open, closes)` pair — shared
with `features/evaluator.py`'s resolution of `max_runup`/`session_high`/
`session_low`'s `source` field, which may name a builtin directly (as
`or_breakout.yaml`'s `or_high`/`or_low` do) rather than another feature.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Literal

from ..data.cache import Cache
from ..data.reference.loader import ReferenceData
from ..features.registry import GapFeature, LegSumFeature, RawFeature, parse_leg_ref
from ..strategy.schema import Universe


def resolve_builtin_series(
    source: Literal["cash", "fut"], universe: Universe, cache: Cache, d: date
) -> tuple[float, list[float]]:
    if source == "fut":
        raise NotImplementedError(
            "FUT bars are schema-supported (features/registry.py allows "
            "source='fut') but not yet ingested — data/ingest.py only writes "
            "opt/cash/greeks Parquet. Add FUT ingestion before using this."
        )
    bars = cache.get_cash_bars(universe.underlying, universe.timeframe, d, d)
    if not bars:
        raise ValueError(f"No cash bars for {universe.underlying} on {d}")
    return bars[0].open, [b.close for b in bars]


def evaluate_leg_sum(
    feature: LegSumFeature, universe: Universe, cache: Cache, d: date
) -> tuple[float, list[float]]:
    total_open = 0.0
    total_closes: list[float] | None = None
    for leg_ref in feature.legs:
        rule, right = parse_leg_ref(leg_ref)
        bars = cache.get_opt_bars(universe.underlying, universe.timeframe, rule, right, d, d)
        if not bars:
            raise ValueError(f"No option bars for {universe.underlying} {rule}.{right} on {d}")
        total_open += bars[0].open
        closes = [b.close for b in bars]
        total_closes = (
            closes
            if total_closes is None
            else [a + b for a, b in zip(total_closes, closes, strict=True)]
        )
    assert total_closes is not None  # feature.legs has min_length=1, enforced by the schema
    return total_open, total_closes


def evaluate_raw(
    feature: RawFeature, universe: Universe, cache: Cache, d: date
) -> tuple[float, list[float]]:
    return resolve_builtin_series(feature.source, universe, cache, d)


def evaluate_gap(
    feature: GapFeature, universe: Universe, cache: Cache, reference: ReferenceData, d: date
) -> float:
    if feature.source == "fut":
        raise NotImplementedError(
            "FUT bars are schema-supported but not yet ingested — "
            "'gap: fut' has no backing data yet."
        )
    prev_day = _previous_trading_day(reference, d)
    today_open, _ = resolve_builtin_series("cash", universe, cache, d)
    _, prev_closes = resolve_builtin_series("cash", universe, cache, prev_day)
    return today_open - prev_closes[-1]


def _previous_trading_day(reference: ReferenceData, d: date) -> date:
    cursor = d - timedelta(days=1)
    while not reference.is_trading_day(cursor):
        cursor -= timedelta(days=1)
    return cursor
