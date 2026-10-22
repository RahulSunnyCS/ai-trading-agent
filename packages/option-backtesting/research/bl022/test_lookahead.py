"""BL-022 look-ahead check (Phase 0): changing any bar at or after T, or any later day, changes
neither the day vector nor the chosen neighbours.

    uv run --with pandas --with pyarrow python -m pytest research/bl022/test_lookahead.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
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


@pytest.mark.parametrize("variant", ["euclid", "dtw"])
def test_neighbours_ignore_later_days(variant):
    rng = np.random.default_rng(7)
    pool = rng.normal(size=(300, 12))
    x = rng.normal(size=12)
    later = rng.normal(size=(50, 12))
    a = A.nearest(pool, x, 7, variant)
    # a caller that slices the pool to earlier days must get the same answer whatever comes later
    b = A.nearest(np.vstack([pool, later])[: len(pool)], x, 7, variant)
    assert (a == b).all()
    assert len(a) == A.K and a.max() < len(pool)


def test_dtw_equals_euclid_squared_on_identical_timing():
    rng = np.random.default_rng(3)
    p = rng.normal(size=(5, 6))
    x = p[2].copy()
    d = A.dtw_band1(p, x)
    assert d[2] == 0
    assert (A.dtw_band1(p, x) <= ((p - x) ** 2).sum(1) + 1e-12).all()
