"""BL-010 criteria as code: the committed files, the drawdown baskets and the window rule."""

from __future__ import annotations

import pandas as pd
import pytest

from momentum_backtesting import criteria


def test_the_committed_files_load_with_every_addendum():
    rules = criteria.load()
    assert set(rules["baskets"]) == {"conservative", "medium", "aggressive"}
    assert rules["phase_4_method"]["pbo"]["kill_above"] == 0.3
    assert "monday_open_repricing" in rules["phase_2_arithmetic"]  # addendum 1
    assert rules["windows"]["embargo_weeks"] == 13  # addendum 2


def _curve(values, start="2020-01-03"):
    return pd.Series(values, index=pd.date_range(start, periods=len(values), freq="W-FRI"))


def test_episodes_find_each_fall_and_the_index_fall_inside_it():
    curve = _curve([100, 110, 80, 90, 120, 100, 130])
    index = _curve([100, 100, 70, 80, 100, 95, 100])
    found = criteria.episodes(curve, index)
    assert [round(e.depth, 4) for e in found] == [round(80 / 110 - 1, 4), round(100 / 120 - 1, 4)]
    assert round(found[0].index_fall, 4) == -0.3  # 100 -> 70 between the same dates


def test_a_fall_passes_a_basket_by_its_limit_or_by_the_index_but_never_past_the_ceiling():
    index = {
        name: _curve([100, 100, 60, 60])
        for name in ("Nifty Midcap 150 TRI", "Nifty Smallcap 250 TRI")
    }
    shallow = _curve([100, 100, 76, 80])  # -24%: inside every fixed limit
    assert criteria.baskets_passed(shallow, index) == ["conservative", "medium", "aggressive"]
    deep_but_market = _curve([100, 100, 63, 70])  # -37%, the index fell 40%
    assert criteria.baskets_passed(deep_but_market, index) == [
        "conservative",
        "medium",
        "aggressive",
    ]
    worse_than_market = _curve([100, 100, 55, 70])  # -45%: past the 40% ceiling
    assert criteria.baskets_passed(worse_than_market, index) == []
    calm = {name: _curve([100, 100, 95, 95]) for name in index}  # the index barely fell
    assert criteria.baskets_passed(_curve([100, 100, 72, 80]), calm) == ["medium", "aggressive"]


def test_selection_and_validation_windows_may_not_meet():
    criteria.check_windows([("2017-01-01", "2020-12-31")], [("2021-06-01", "2023-12-31")])
    with pytest.raises(ValueError, match="overlap"):
        criteria.check_windows([("2017-01-01", "2020-12-31")], [("2020-06-01", "2023-12-31")])
    with pytest.raises(ValueError, match="embargo"):  # four weeks apart, embargo is thirteen
        criteria.check_windows([("2017-01-01", "2020-12-31")], [("2021-01-29", "2023-12-31")])
    with pytest.raises(ValueError, match="hold-out"):
        criteria.check_windows([("2015-01-01", "2020-12-31")], [("2022-01-01", "2023-12-31")])
