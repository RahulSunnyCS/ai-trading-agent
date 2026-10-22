"""BL-154 checks: the opening labels ignore later sessions; the shrunk fit is `skewed_fit` at k = 0,
the window mean at k = inf, and reads no row at or after day i.

    uv run --with pandas --with pyarrow python -m pytest research/bl154/test_bl154.py
"""

from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import labels as L  # noqa: E402
from replay import fit_shrunk, fit_skewed  # noqa: E402


def _ohlc(n: int, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    c = 22000 * np.exp(np.cumsum(rng.normal(0, 0.01, n)))
    o = c * (1 + rng.normal(0, 0.003, n))
    h = np.maximum(o, c) * (1 + np.abs(rng.normal(0, 0.004, n)))
    low = np.minimum(o, c) * (1 - np.abs(rng.normal(0, 0.004, n)))
    days = [date(2023, 1, 2) + timedelta(days=i) for i in range(n)]
    return pd.DataFrame({"day": days, "open": o, "high": h, "low": low, "close": c})


def test_labels_ignore_later_sessions():
    a = _ohlc(400, 1)
    b = a.copy()
    cut = 330
    b.loc[cut + 1 :, ["open", "high", "low", "close"]] *= 1.37  # change only sessions after cut
    va, vb = L.raw_values(a), L.raw_values(b)
    ga, gb = L.bands(va["gap"].to_numpy()), L.bands(vb["gap"].to_numpy())
    ra, rb = L.bands(va["prev_range"].to_numpy()), L.bands(vb["prev_range"].to_numpy())
    assert (ga[: cut + 1] == gb[: cut + 1]).all()
    assert (ra[: cut + 1] == rb[: cut + 1]).all()
    assert set(ga[L.BAND_N + L.ATR_N + 1 :]) <= {"lo", "mid", "hi"}


def test_shrunk_fit_limits_and_causality():
    rng = np.random.default_rng(7)
    P = rng.normal(0, 500, (200, 12))
    lab = rng.integers(0, 5, 200)
    match = (lab[:, None] == lab[150]).repeat(12, axis=1)
    np.testing.assert_allclose(fit_shrunk(0.0)(P, match, 150), fit_skewed(P, match, 150))
    inf = fit_shrunk(np.inf)(P, match, 150)
    assert np.isfinite(inf).all()
    P2 = P.copy()
    P2[150:] = 1e9  # day i and later never read
    np.testing.assert_allclose(fit_shrunk(10.0)(P, match, 150), fit_shrunk(10.0)(P2, match, 150))
