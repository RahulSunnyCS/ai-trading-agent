"""BL-155 look-ahead check (Phase 0): changing any bar at or after 11:00, or any later session, changes
neither a day's R nor its type.

    uv run --with pandas python -m pytest research/bl155/test_lookahead.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import morning as M  # noqa: E402


def _bars(n_days: int, seed: int) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    days = pd.bdate_range("2024-01-01", periods=n_days).strftime("%Y-%m-%d")
    rows = []
    for d in days:
        c = 22000 * np.exp(np.cumsum(rng.normal(0, rng.uniform(2e-4, 8e-4), 375)))
        for k, x in enumerate(c):
            rows.append((d, M.OPEN_MIN + k, x * (1 - 1e-4), x * (1 + 2e-4), x * (1 - 2e-4)))
    return pd.DataFrame(rows, columns=["day", "m", "open", "high", "low"])


def test_type_ignores_bars_from_11_and_later_sessions():
    bars = _bars(40, seed=5)
    cut = sorted(bars.day.unique())[30]
    base = M.morning_types(bars).set_index("day")
    moved = bars.copy()
    late = (moved.m >= M.CHECK_MIN) | (moved.day > cut)
    moved.loc[late, ["open", "high", "low"]] *= 1.3
    moved.loc[late & (moved.day > cut), "high"] *= 1.05
    after = M.morning_types(moved).set_index("day")
    ok = base.index <= cut
    pd.testing.assert_frame_equal(base[ok], after[ok])
    assert base.loc[cut, "type"] in ("quiet", "normal", "wide")
    # the base is the previous 20 sessions, not including the day itself
    i = list(base.index).index(cut)
    assert np.isclose(base.R.iloc[i], base.rsf.iloc[i] / base.rsf.iloc[i - M.LOOKBACK : i].mean())
    # the first 20 sessions have no base, so no type
    assert base.type.iloc[: M.LOOKBACK].isna().all() and base.type.iloc[M.LOOKBACK :].notna().all()


def test_bar_stamped_10_59_counts_and_11_00_does_not():
    bars = _bars(25, seed=9)
    d = sorted(bars.day.unique())[-1]
    spike = bars.copy()
    spike.loc[(spike.day == d) & (spike.m == M.CHECK_MIN - 1), "high"] *= 1.02
    assert (
        M.morning_types(spike).set_index("day").loc[d, "rsf"]
        > M.morning_types(bars).set_index("day").loc[d, "rsf"]
    )
    spike = bars.copy()
    spike.loc[(spike.day == d) & (spike.m == M.CHECK_MIN), "high"] *= 1.02
    pd.testing.assert_frame_equal(M.morning_types(spike), M.morning_types(bars))


def test_short_leg_charges_match_bl063_shape():
    # ₹100 premium, 75 qty, exit ₹50: 40 brokerage + STT 7.5 + exchange 3.94 + ... + GST
    c = M.short_leg_charges("NIFTY", "2025-06-02", 75, 100.0, 50.0)
    both = 11250.0
    exch, sebi, ipft = 0.0003503 * both, 1e-6 * both, 5e-6 * both
    expect = (
        40 + 0.001 * 7500 + exch + sebi + ipft + 0.00003 * 3750 + 0.18 * (40 + exch + sebi + ipft)
    )
    assert abs(c - expect) < 1e-9
    assert (
        M.short_leg_charges("NIFTY", "2026-04-01", 75, 100.0, 50.0) > c
    )  # STT 0.15% from April 2026
