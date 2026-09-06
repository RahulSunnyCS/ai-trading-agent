"""
Cross-day rolling features over another feature's per-session SCALAR series.
`lag` is always >= 1 (enforced at schema-validation time by
features/registry.py — never re-checked here): the window for day `i` ends
at day `i - lag`, so day `i`'s own (possibly still-incomplete) value never
leaks into its own threshold.

Window definition (shared by all three), verified against the golden
fixture's Variant D thresholds (see tests/unit/test_features_rolling.py):
for `days=D`, `lag=L`, day index `i` (0-based over the run's ordered
sessions), the window is `ordered_dates[i-L-D+1 : i-L+1]` — i.e. `D`
sessions ending at day `i-L` inclusive. Days too early in the run to have a
full window (fewer than `L+D` prior sessions) are simply absent from the
result — calibration-only, not zero.
"""

from __future__ import annotations

import statistics
from datetime import date

from ..features.registry import EwmaFeature, RollingMeanFeature, RollingPctileFeature


def _window(
    days: int, lag: int, ordered_dates: list[date], i: int
) -> list[date] | None:
    end_inclusive = i - lag
    start_inclusive = end_inclusive - days + 1
    if start_inclusive < 0:
        return None
    return ordered_dates[start_inclusive : end_inclusive + 1]


def rolling_mean_series(
    feature: RollingMeanFeature, source_scalars: dict[date, float], ordered_dates: list[date]
) -> dict[date, float]:
    result: dict[date, float] = {}
    for i, d in enumerate(ordered_dates):
        window = _window(feature.days, feature.lag, ordered_dates, i)
        if window is None:
            continue
        result[d] = sum(source_scalars[wd] for wd in window) / feature.days
    return result


def ewma_series(
    feature: EwmaFeature, source_scalars: dict[date, float], ordered_dates: list[date]
) -> dict[date, float]:
    """Not golden-verified (no committed strategy uses `ewma` yet).
    Exponentially weighted mean over the same lag-respecting history (every
    session up to and including day `i - lag`), most-recent-first, with
    `alpha = 1 - 2**(-1/halflife_days)`."""
    result: dict[date, float] = {}
    alpha = 1 - 2 ** (-1 / feature.halflife_days)
    for i, d in enumerate(ordered_dates):
        end_inclusive = i - feature.lag
        if end_inclusive < 0:
            continue
        history = ordered_dates[: end_inclusive + 1]
        weighted_sum = 0.0
        weight_total = 0.0
        w = 1.0
        for wd in reversed(history):
            weighted_sum += w * source_scalars[wd]
            weight_total += w
            w *= 1 - alpha
        result[d] = weighted_sum / weight_total
    return result


def rolling_pctile_series(
    feature: RollingPctileFeature, source_scalars: dict[date, float], ordered_dates: list[date]
) -> dict[date, float]:
    """Not golden-verified (no committed strategy uses this yet), and the
    schema (features/registry.py) has no explicit percentile parameter — the
    only self-consistent reading given `source`/`days`/`lag` alone (an
    identical window to `rolling_mean`) is the window's MEDIAN (50th
    percentile). A real percentile knob (e.g. `pctile: 75`) would be a
    natural additive field if a strategy ever needs a non-median cut."""
    result: dict[date, float] = {}
    for i, d in enumerate(ordered_dates):
        window = _window(feature.days, feature.lag, ordered_dates, i)
        if window is None:
            continue
        result[d] = statistics.median(source_scalars[wd] for wd in window)
    return result
