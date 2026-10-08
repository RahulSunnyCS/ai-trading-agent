"""BL-050 Phase 1: the filter features are point in time, and the tilt hook blends ranks."""

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting import filters
from momentum_backtesting.categories.broad import _apply_feature_tilt

WEEKS = pd.date_range("2015-01-02", periods=160, freq="W-FRI")
DAYS = pd.bdate_range(WEEKS[0] - pd.Timedelta(days=4), WEEKS[-1])


def data(seed=5):
    rng = np.random.default_rng(seed)
    cols = [f"S{i}" for i in range(12)]
    prices = pd.DataFrame(
        100 * np.cumprod(1 + rng.normal(0.003, 0.04, (len(WEEKS), len(cols))), axis=0),
        index=WEEKS,
        columns=cols,
    )
    daily_turn = pd.DataFrame(
        np.exp(rng.normal(15, 0.6, (len(DAYS), len(cols)))), index=DAYS, columns=cols
    )
    nifty = pd.Series(100 * np.cumprod(1 + rng.normal(0.002, 0.02, len(WEEKS))), index=WEEKS)
    return prices, daily_turn, nifty


def all_features(prices, daily_turn, nifty):
    weekly = filters.weekly_turnover(daily_turn, prices.index)
    universe = prices.notna()
    return {
        "V1": filters.v1_turnover_expansion(daily_turn, prices.index),
        "V2": filters.v2_accumulation(weekly, prices),
        "V3": filters.v3_quiet_or_building_blocked(weekly),
        "R1": filters.r1_relative_strength_blocked(prices, nifty),
        "M1": filters.m1_overextended_blocked(prices, universe),
        "M2": filters.m2_residual_sum(prices, nifty),
        "T1": filters.t1_trend_quality(prices),
    }


@pytest.mark.parametrize("cut", [80, 120])
def test_every_feature_is_point_in_time(cut) -> None:
    prices, daily_turn, nifty = data()
    full = all_features(prices, daily_turn, nifty)
    week = WEEKS[cut]
    short = all_features(prices.loc[:week], daily_turn.loc[:week], nifty.loc[:week])
    for name in full:
        pd.testing.assert_frame_equal(
            short[name], full[name].loc[:week], check_freq=False, obj=name
        )


def test_features_have_values_once_warm() -> None:
    prices, daily_turn, nifty = data()
    feats = all_features(prices, daily_turn, nifty)
    for name in ("V1", "V2", "M2", "T1"):
        assert feats[name].iloc[-1].notna().sum() >= 10, name
    for name in ("V3", "R1", "M1"):
        assert feats[name].dtypes.eq(bool).all(), name


def test_v3_quiet_and_building_pass_a_spike_is_blocked() -> None:
    weekly = pd.DataFrame({"Q": 100.0, "B": 100.0, "S": 100.0}, index=WEEKS[:40])
    weekly.loc[WEEKS[36:40], "B"] = [101.0, 102.0, 103.0, 104.0]  # building: 3 rises in a row
    weekly.loc[WEEKS[39], "S"] = 400.0  # one-week spike
    blocked = filters.v3_quiet_or_building_blocked(weekly).iloc[-1]
    assert not blocked["Q"] and not blocked["B"] and blocked["S"]


def test_t1_rewards_a_steady_rise_over_a_choppy_one() -> None:
    steady = 100 * 1.01 ** np.arange(60)
    choppy = steady * (1 + 0.15 * np.sin(np.arange(60)))
    prices = pd.DataFrame({"steady": steady, "choppy": choppy}, index=WEEKS[:60])
    t1 = filters.t1_trend_quality(prices).iloc[-1]
    assert t1["steady"] > t1["choppy"]


def test_the_tilt_blends_and_reranks() -> None:
    ranks = pd.DataFrame({"A": [1.0], "B": [2.0], "C": [3.0], "D": [np.nan]}, index=WEEKS[:1])
    feature = pd.DataFrame({"A": [0.0], "B": [1.0], "C": [5.0], "D": [9.0]}, index=WEEKS[:1])
    out, _ = _apply_feature_tilt(ranks, feature, 0.5)
    # feature ranks among A-C: C 1, B 2, A 3 -> blended A 2.0, B 2.0, C 2.0 -> ties by order
    assert np.isnan(out.at[WEEKS[0], "D"])
    light, _ = _apply_feature_tilt(ranks, feature, 0.25)
    assert list(light.iloc[0, :3]) == [1.0, 2.0, 3.0]  # 0.25 does not overturn a 2-rank gap
    heavy, _ = _apply_feature_tilt(ranks, feature.assign(C=[5.0]), 0.5)
    assert heavy.iloc[0, :3].notna().all()


def test_a_name_without_a_feature_gets_the_middle_rank() -> None:
    ranks = pd.DataFrame({"A": [1.0], "B": [2.0], "C": [3.0]}, index=WEEKS[:1])
    feature = pd.DataFrame({"A": [np.nan], "B": [1.0], "C": [2.0]}, index=WEEKS[:1])
    _, blended = _apply_feature_tilt(ranks, feature, 0.5)
    assert blended.at[WEEKS[0], "A"] == pytest.approx(0.5 * 1 + 0.5 * 2.0)


def test_bad_weight_is_refused() -> None:
    ranks = pd.DataFrame({"A": [1.0]}, index=WEEKS[:1])
    with pytest.raises(ValueError):
        _apply_feature_tilt(ranks, ranks, 1.0)
