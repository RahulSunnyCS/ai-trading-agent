"""BL-010 Phase 6 paper tracking (criteria addendum 5): the two fail lines on synthetic curves."""

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting import tracker

WEEKS = pd.date_range("2026-01-02", periods=60, freq="W-FRI")


def _line(weekly: float, falls: dict[int, float] | None = None) -> pd.Series:
    r = np.full(len(WEEKS), weekly)
    for week, fall in (falls or {}).items():
        r[week] = fall
    r[0] = 0.0
    return pd.Series(np.cumprod(1 + r), index=WEEKS)


def test_start_week_is_the_last_week_on_or_before_since():
    assert tracker.start_week(WEEKS, "2026-01-09") == pd.Timestamp("2026-01-09")
    assert tracker.start_week(WEEKS, "2026-01-12") == pd.Timestamp("2026-01-09")
    with pytest.raises(ValueError):
        tracker.start_week(WEEKS, "2025-12-01")


def test_a_healthy_ensemble_crosses_no_fail_line():
    out = tracker.evaluate(_line(0.006), _line(0.005), _line(0.004), "2026-01-09")
    assert not out["failed"]
    assert out["weeks"] == len(WEEKS) - 2  # rebased at the second week
    assert out["fail"]["trailing_index"]["measured_at"] is not None  # past 26 weeks
    assert out["returns"]["ensemble"] > out["returns"]["mom30"]


def test_trailing_the_index_by_more_than_10_points_at_26_weeks_fails():
    out = tracker.evaluate(_line(0.001), _line(0.004), _line(0.006), "2026-01-02")
    gap = out["fail"]["trailing_index"]["ensemble_minus_mom30"]
    assert gap < -0.10 and out["fail"]["trailing_index"]["failed"] and out["failed"]


def test_before_26_weeks_the_trailing_test_is_not_judged():
    out = tracker.evaluate(_line(0.001), _line(0.004), _line(0.02), "2026-09-04")
    assert out["weeks"] < tracker.TRAILING_WEEKS
    assert out["fail"]["trailing_index"]["failed"] is False
    assert out["fail"]["trailing_index"]["measured_at"] is None


def test_a_fall_deeper_than_57_percent_fails_the_drawdown_line():
    falls = {30: -0.6}
    out = tracker.evaluate(_line(0.01, falls), _line(0.005), _line(0.004), "2026-01-02")
    assert out["fail"]["drawdown"]["ensemble_max_drawdown"] < tracker.DRAWDOWN_LIMIT
    assert out["fail"]["drawdown"]["failed"] and out["failed"]
    mild = tracker.evaluate(_line(0.01, {30: -0.3}), _line(0.005), _line(0.004), "2026-01-02")
    assert not mild["fail"]["drawdown"]["failed"]


def test_median_companion_is_closest_to_the_group_median_with_ties_to_the_lower_id():
    index = pd.date_range("2020-01-03", periods=261, freq="W-FRI")
    rates = {"c": 0.001, "a": 0.002, "b": 0.003, "d": 0.0025, "e": 0.0015}
    curves = pd.DataFrame(
        {k: np.cumprod(np.full(len(index), 1 + r)) for k, r in rates.items()}, index=index
    )
    assert tracker.median_companion(curves, list(curves.columns)) == "a"  # the middle rate
    twins = pd.DataFrame({"y": curves["a"], "x": curves["a"], "z": curves["b"]})
    assert tracker.median_companion(twins, ["x", "y", "z"]) == "x"  # tie: lower id
