"""BL-022 look-ahead check (Phase 0): changing any bar at or after T, or any later day, changes
neither the day vector nor the chosen neighbours.

    uv run --with pandas --with pyarrow python -m pytest research/bl022/test_lookahead.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).parent))
import analog as A  # noqa: E402


def _day(rng, n=A.N_BARS):
    c = 22000 * np.exp(np.cumsum(rng.normal(0, 4e-4, n)))
    o = np.r_[c[0] * (1 + rng.normal(0, 1e-3)), c[:-1]]
    h = np.maximum(o, c) * (1 + np.abs(rng.normal(0, 2e-4, n)))
    low = np.minimum(o, c) * (1 - np.abs(rng.normal(0, 2e-4, n)))
    return o, h, low, c


@pytest.mark.parametrize("check", list(A.CHECKS))
def test_features_ignore_bars_at_or_after_check(check):
    rng = np.random.default_rng(22)
    tmin = A.CHECKS[check]
    j = tmin - A.OPEN_MIN
    o, h, low, c = _day(rng)
    vix = 13 + np.cumsum(rng.normal(0, 0.01, A.N_BARS))
    base = A.day_features(o, h, low, c, tmin, 0.01, 21950.0, vix, 13.0, 3)
    o2, h2, low2, c2, vix2 = (a.copy() for a in (o, h, low, c, vix))
    for a in (o2, h2, low2, c2):
        a[j:] *= 1.5
    vix2[j:] += 9
    moved = A.day_features(o2, h2, low2, c2, tmin, 0.01, 21950.0, vix2, 13.0, 3)
    assert base == moved
    assert len([k for k in base if k.startswith("p")]) == len(A.path_cols(tmin))
    # the outcome does read them: the test would catch a feature that should not
    assert A.outcome(h, low, c, tmin) != A.outcome(h2, low2, c2, tmin)


def test_path_points_are_complete_at_check():
    for check, tmin in A.CHECKS.items():
        cols = A.path_cols(tmin)
        assert max(cols) == tmin - A.OPEN_MIN - 1, check
        assert cols[0] == 14  # the bar stamped 09:29, complete at 09:30


def _synthetic_features(n_days: int, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    days = pd.bdate_range("2023-01-02", periods=n_days).strftime("%Y-%m-%d")
    df = pd.DataFrame(
        rng.normal(size=(n_days, len(A.feature_names("1030")))), columns=A.feature_names("1030")
    )
    df["vix"] = 12 + rng.random(n_days) * 8
    df["dte"] = rng.integers(0, 8, n_days).astype(float)
    df["rod"] = 0.004 + rng.random(n_days) * 0.01
    df["rsf_raw"] = 0.003 + rng.random(n_days) * 0.01
    df["minutes_left"], df["index"], df["check"], df["day"] = 285, "NIFTY", "1030", days
    return df


def test_forecast_pool_ignores_later_days():
    """forecast.forecasts: a day's analog forecasts are unchanged when every later day's features
    and outcome change, so the pool is earlier days only (`valid[:i]`)."""
    import forecast as F

    df = _synthetic_features(F.MIN_POOL + 60, seed=11)
    cut = df.day.iloc[F.MIN_POOL + 30]
    moved = df.copy()
    later = moved.day > cut
    cols = [*A.feature_names("1030"), "rod", "rsf_raw"]
    moved.loc[later, cols] = moved.loc[later, cols] * 3 + 1
    # the cut day's own outcome too (its morning features are known at T and stay): a pool that
    # included the day itself would move its forecast
    moved.loc[moved.day == cut, "rod"] += 1
    a = F.forecasts(df, "NIFTY", "1030", df.day.iloc[0], cut, np.random.default_rng(1))
    b = F.forecasts(moved, "NIFTY", "1030", df.day.iloc[0], cut, np.random.default_rng(1))
    assert len(a) == 31
    for col in ("analog_euclid", "analog_dtw", "persistence"):
        assert np.allclose(a[col], b[col]), col
    assert np.allclose(a.opening_range, b.opening_range)


def test_dtw_is_zero_on_itself_and_bounded_by_lockstep_distance():
    rng = np.random.default_rng(3)
    p = rng.normal(size=(5, 6))
    x = p[2].copy()
    d = A.dtw_band1(p, x)
    assert d[2] == 0
    assert (A.dtw_band1(p, x) <= ((p - x) ** 2).sum(1) + 1e-12).all()
