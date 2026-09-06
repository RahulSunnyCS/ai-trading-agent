"""
Orchestrates every declared feature into a `FeatureStore`, in two passes —
mirroring the reference implementation computing every session's own
`max_runup` up front, before simulating any single day's ladder fires (which
need the OTHER sessions' history to build the rolling threshold).

Pass 1 (per session, in `features` dict order — already guaranteed acyclic
and forward-ref-free by `strategy/loader.py`): same-day features, each drawn
from `Cache`/`ReferenceData` or an already-evaluated feature earlier in this
same pass.

Pass 2 (cross-day, over ALL sessions' Pass-1 scalars): `rolling_mean`/
`ewma`/`rolling_pctile`, honoring each one's `lag`.

There is no Pass 3 here — `running_low`/`running_high`/`last_fill` are
engine/loop.py's own simulation STATE (engine/state.py), not features; the
evaluator never touches them.
"""

from __future__ import annotations

from datetime import date, time

from ..bartime import time_to_bar_index
from ..data.cache import Cache
from ..data.reference.loader import ReferenceData
from ..features.registry import (
    BUILTIN_SOURCES,
    DaysToExpiryFeature,
    EwmaFeature,
    FeatureSpec,
    GapFeature,
    GreekFeature,
    LegSumFeature,
    RawFeature,
    RollingMeanFeature,
    RollingPctileFeature,
    SessionHighFeature,
    SessionLowFeature,
)
from ..features.registry import MaxRunupFeature as MaxRunupFeatureSpec
from ..strategy.schema import Universe
from . import path as path_features
from . import rolling as rolling_features
from .calendar import evaluate_days_to_expiry
from .greeks import evaluate_greek
from .leg import evaluate_gap, evaluate_leg_sum, evaluate_raw, resolve_builtin_series
from .store import FeatureStore


def evaluate_features(
    features: dict[str, FeatureSpec],
    universe: Universe,
    cache: Cache,
    reference: ReferenceData,
    ordered_dates: list[date],
    bar_times_by_date: dict[date, list[time]],
) -> FeatureStore:
    store = FeatureStore()

    for d in ordered_dates:
        bar_times = bar_times_by_date[d]
        for name, spec in features.items():
            if isinstance(spec, LegSumFeature):
                open_, closes = evaluate_leg_sum(spec, universe, cache, d)
                store.set_per_bar(name, d, open_, closes)
            elif isinstance(spec, RawFeature):
                open_, closes = evaluate_raw(spec, universe, cache, d)
                store.set_per_bar(name, d, open_, closes)
            elif isinstance(spec, GapFeature):
                store.set_scalar(name, d, evaluate_gap(spec, universe, cache, reference, d))
            elif isinstance(spec, GreekFeature):
                store.set_scalar(name, d, evaluate_greek(spec, universe, cache, d, bar_times))
            elif isinstance(spec, DaysToExpiryFeature):
                store.set_scalar(name, d, evaluate_days_to_expiry(spec, universe, reference, d))
            elif isinstance(spec, MaxRunupFeatureSpec):
                src_open, src_closes = _resolve_source_series(
                    spec.source, store, universe, cache, d
                )
                store.set_scalar(name, d, path_features.max_runup(src_open, src_closes))
            elif isinstance(spec, SessionHighFeature | SessionLowFeature):
                src_open, src_closes = _resolve_source_series(
                    spec.source, store, universe, cache, d
                )
                until_bar = time_to_bar_index(bar_times, spec.until)
                fn = (
                    path_features.session_high
                    if isinstance(spec, SessionHighFeature)
                    else path_features.session_low
                )
                store.set_scalar(name, d, fn(src_open, src_closes, until_bar))
            elif isinstance(spec, RollingMeanFeature | EwmaFeature | RollingPctileFeature):
                continue  # Pass 2, below
            else:  # pragma: no cover — exhaustive over the FeatureSpec union
                raise AssertionError(f"Unhandled feature type for {name!r}: {type(spec)}")

    for name, spec in features.items():
        if isinstance(spec, RollingMeanFeature):
            source_scalars = store.scalars[spec.source]
            for d, value in rolling_features.rolling_mean_series(
                spec, source_scalars, ordered_dates
            ).items():
                store.set_scalar(name, d, value)
        elif isinstance(spec, EwmaFeature):
            source_scalars = store.scalars[spec.source]
            ewma_values = rolling_features.ewma_series(spec, source_scalars, ordered_dates)
            for d, value in ewma_values.items():
                store.set_scalar(name, d, value)
        elif isinstance(spec, RollingPctileFeature):
            source_scalars = store.scalars[spec.source]
            for d, value in rolling_features.rolling_pctile_series(
                spec, source_scalars, ordered_dates
            ).items():
                store.set_scalar(name, d, value)

    return store


def _resolve_source_series(
    source: str, store: FeatureStore, universe: Universe, cache: Cache, d: date
) -> tuple[float, list[float]]:
    """`source` is either a builtin (`cash`/`fut` — referenced directly, as
    `or_breakout.yaml`'s `or_high`/`or_low` do) or an already-evaluated
    per-bar feature name declared earlier in the same file. A scalar source
    is never valid here — `max_runup`/`session_high`/`session_low` need a
    per-bar series to walk."""
    if source in BUILTIN_SOURCES:
        return resolve_builtin_series(source, universe, cache, d)  # type: ignore[arg-type]
    if store.is_per_bar(source):
        return store.open_value(source, d), store.bar_series(source, d)
    raise ValueError(
        f"Feature source {source!r} is neither a builtin ({', '.join(sorted(BUILTIN_SOURCES))}) "
        f"nor an already-evaluated per-bar feature."
    )
