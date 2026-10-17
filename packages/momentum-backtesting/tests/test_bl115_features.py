"""BL-115: the own-history features read nothing after the decision week (look-ahead check)."""

import importlib.util
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "bl115_own_history_features.py"


@pytest.fixture(scope="module")
def bl115():
    spec = importlib.util.spec_from_file_location("bl115", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _data(seed=1):
    rng = np.random.default_rng(seed)
    weeks = pd.date_range("2016-01-01", periods=200, freq="W-FRI")
    p = pd.Series(100 * np.exp(np.cumsum(rng.normal(0.004, 0.04, len(weeks)))), index=weeks)
    days = pd.bdate_range("2015-06-01", weeks[-1])
    move = pd.Series(rng.normal(0.001, 0.02, len(days)), index=days)
    move.iloc[::37] = 0.0199  # some circuit-edge days
    turnover = pd.Series(rng.uniform(1e7, 5e7, len(days)), index=days)
    return p, move, turnover


def test_features_ignore_everything_after_the_decision_week(bl115):
    p, move, turnover = _data()
    for d in p.index[80:190:17]:
        full = {
            **bl115.weekly_features(p, d, [4, 13, 26, 52]),
            **bl115.daily_features(move, turnover, p, d),
        }
        cut = {
            **bl115.weekly_features(p.loc[:d], d, [4, 13, 26, 52]),
            **bl115.daily_features(move.loc[:d], turnover.loc[:d], p.loc[:d], d),
        }
        # Changing every value after d must not move a feature either.
        later = p.index > d
        noisy = p.copy()
        noisy[later] *= 3.0
        moved = {
            **bl115.weekly_features(noisy, d, [4, 13, 26, 52]),
            **bl115.daily_features(
                move * (move.index <= d) + 0.5 * (move.index > d), turnover, noisy, d
            ),
        }
        for key in full:
            assert full[key] == pytest.approx(cut[key], nan_ok=True), key
            assert full[key] == pytest.approx(moved[key], nan_ok=True), key


def test_the_average_weekly_score_is_each_window_return_over_its_weeks(bl115):
    weeks = pd.date_range("2020-01-03", periods=60, freq="W-FRI")
    p = pd.Series(100.0, index=weeks)
    d = weeks[-1]
    p.loc[d] = 126.0  # +26% over every lookback that starts before the last week
    got = bl115.weekly_features(p, d, [13, 26, 52])
    assert got["F0_avg_weekly_score"] == pytest.approx(26 / 13 + 26 / 26 + 26 / 52)
    assert got["F3_distance_below_52w_high"] == pytest.approx(0.0)
    assert got["F1_steadiness"] == pytest.approx(1 / 26)


def test_a_rise_made_in_one_day_is_spike_dependent(bl115):
    weeks = pd.date_range("2020-01-03", periods=60, freq="W-FRI")
    p = pd.Series(100.0, index=weeks)
    p.iloc[-5:] = 120.0
    days = pd.bdate_range("2019-06-01", weeks[-1])
    move = pd.Series(0.0, index=days)
    move.iloc[move.index.get_indexer([weeks[-5]], method="pad")[0]] = 0.20
    got = bl115.daily_features(move, pd.Series(1e7, index=days), p, weeks[-1])
    assert got["F6_spike_dependence"] == pytest.approx(np.log1p(0.20) / np.log(1.2))
    assert got["F5_circuit_days"] == 1.0
