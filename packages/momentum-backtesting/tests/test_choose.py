"""BL-010 Phase 5: the choice rule committed in criteria addendum 3."""

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting import choose, criteria

WEEKS = pd.date_range("2017-01-06", "2026-10-02", freq="W-FRI")


def _curve(weekly: float, noise: np.ndarray | None = None) -> pd.Series:
    r = np.full(len(WEEKS), weekly) + (0 if noise is None else noise)
    r[0] = 0.0
    return pd.Series(np.exp(np.cumsum(r)), index=WEEKS)


def test_fy_bounds_and_complete_years():
    assert choose.fy_bounds(2018) == (pd.Timestamp("2017-04-01"), pd.Timestamp("2018-03-31"))
    # Data from January 2017 to October 2026: FY2018..FY2026 complete, FY2027 not.
    assert choose.complete_fys(WEEKS) == list(range(2018, 2027))
    # Cut at the end of 2018: only FY2018 has finished.
    assert choose.complete_fys(WEEKS[WEEKS <= "2018-12-31"]) == [2018]


def test_window_return_uses_the_week_before_the_start():
    curve = pd.Series(np.arange(1.0, len(WEEKS) + 1), index=WEEKS)
    start, end = choose.fy_bounds(2018)
    before = WEEKS[start > WEEKS][-1]
    last = WEEKS[end >= WEEKS][-1]
    assert choose.window_returns(curve, start, end) == pytest.approx(
        curve[last] / curve[before] - 1
    )
    # A window past the data is NaN, never a partial return.
    assert np.isnan(choose.window_returns(curve, "2026-04-01", "2027-03-31"))


def test_lower_bound_is_the_third_worst_of_nine():
    excess = pd.DataFrame({"a": [0.5, -0.3, 0.1, 0.2, -0.1, 0.0, 0.4, 0.3, -0.2]})
    assert choose.lower_bound(excess)["a"] == pytest.approx(-0.1)


def test_clusters_group_configs_that_move_together():
    rng = np.random.default_rng(0)
    base_a, base_b = rng.normal(0, 0.03, len(WEEKS)), rng.normal(0, 0.03, len(WEEKS))
    curves = pd.DataFrame(
        {
            "a1": _curve(0.004, base_a),
            "a2": _curve(0.004, base_a + rng.normal(0, 0.003, len(WEEKS))),
            "a3": _curve(0.004, base_a + rng.normal(0, 0.003, len(WEEKS))),
            "b1": _curve(0.003, base_b),
            "b2": _curve(0.003, base_b + rng.normal(0, 0.003, len(WEEKS))),
        }
    )
    rank = pd.Series({"a1": 0.05, "a2": 0.04, "a3": 0.03, "b1": 0.02, "b2": 0.01})
    found = choose.clusters(curves, rank)
    assert sorted(sorted(c.members) for c in found) == [["a1", "a2", "a3"], ["b1", "b2"]]
    # Scored by the 25th-percentile member, so cluster a's score is between its worst two.
    a = next(c for c in found if "a1" in c.members)
    assert 0.03 <= a.score <= 0.04


def _facts(holdings: dict[str, int]) -> pd.DataFrame:
    return pd.DataFrame(
        {"holdings": holdings, "simplicity": {k: (3, 4, False, False) for k in holdings}}
    )


def test_pick_prefers_eight_to_twelve_within_one_point():
    found = [
        choose.Cluster("narrow", ["narrow"], 0.050),
        choose.Cluster("broad", ["broad"], 0.042),
    ]
    facts = _facts({"narrow": 4, "broad": 10})
    martin = pd.Series({"narrow": 1.0, "broad": 1.0})
    assert choose.pick(found, facts, martin).medoid == "broad"  # 0.8 pts behind: preference wins
    found[1].score = 0.035
    assert choose.pick(found, facts, martin).medoid == "narrow"  # 1.5 pts behind: score wins


def test_pick_breaks_half_point_ties_by_martin_then_simplicity():
    found = [choose.Cluster("x", ["x"], 0.040), choose.Cluster("y", ["y"], 0.037)]
    facts = _facts({"x": 10, "y": 10})
    assert choose.pick(found, facts, pd.Series({"x": 1.0, "y": 2.0})).medoid == "y"
    facts.at["y", "simplicity"] = (2, 4, False, False)
    assert choose.pick(found, facts, pd.Series({"x": 1.0, "y": 1.0})).medoid == "y"


def test_basket_loosen_moves_only_the_fixed_limit():
    # One 28% fall; the index falls 10% over the same weeks, so only the fixed limit can pass it.
    values = np.ones(len(WEEKS))
    values[100:] = 0.72
    curve = pd.Series(values, index=WEEKS)
    index_values = np.ones(len(WEEKS))
    index_values[100:] = 0.9
    index = pd.Series(index_values, index=WEEKS)
    indices = {"Nifty Midcap 150 TRI": index, "Nifty Smallcap 250 TRI": index}
    assert not criteria.basket_passes(curve, indices, "conservative")  # 25% limit
    assert criteria.basket_passes(curve, indices, "conservative", loosen=0.05)  # 30%
    # The 40% ceiling never moves.
    curve[100:] = 0.55
    assert not criteria.basket_passes(curve, indices, "aggressive", loosen=0.20)


def test_walk_forward_selects_only_on_the_past():
    """A config that is best before a year but worst in it must still be the one chosen for
    that year: the rule may not see the year it is judged on."""
    early = pd.Timestamp("2019-04-01") > WEEKS
    steady = np.full(len(WEEKS), 0.002)
    fades = np.where(early, 0.006, -0.002)
    rng = np.random.default_rng(1)
    curves = pd.DataFrame(
        {
            "steady": _curve(0, steady + rng.normal(0, 0.004, len(WEEKS))),
            "fades": _curve(0, fades + rng.normal(0, 0.004, len(WEEKS))),
        }
    )
    flat = pd.Series(1.0, index=WEEKS)
    indices = {"Nifty Midcap 150 TRI": flat, "Nifty Smallcap 250 TRI": flat}
    facts = _facts({"steady": 10, "fades": 10})
    out = choose.walk_forward(curves, indices, flat, facts, first_fy=2020, echo=lambda *_: None)
    # FY2020 is chosen on data to 13 weeks before 2019-04-01, i.e. FY2018 only, when `fades`
    # led; it is chosen even though it loses money in FY2020.
    for table in out.values():
        assert table.at[2020, "selected_on"] == "FY2018-FY2018"
        assert table.at[2020, "chosen"] == "fades"
        assert table.at[2020, "chosen_return"] < 0


def test_pick_ignores_a_nan_martin_ratio():
    found = [choose.Cluster("x", ["x"], 0.040), choose.Cluster("y", ["y"], 0.039)]
    facts = _facts({"x": 10, "y": 10})
    assert choose.pick(found, facts, pd.Series({"x": np.nan, "y": 1.0})).medoid == "y"


def test_walk_forward_partial_first_year_is_opt_in():
    rng = np.random.default_rng(2)
    curves = pd.DataFrame({k: _curve(0.003, rng.normal(0, 0.01, len(WEEKS))) for k in "ab"})
    flat = pd.Series(1.0, index=WEEKS)
    indices = {"Nifty Midcap 150 TRI": flat, "Nifty Smallcap 250 TRI": flat}
    facts = _facts({"a": 10, "b": 10})
    committed = choose.walk_forward(curves, indices, flat, facts, echo=lambda *_: None)
    partial = choose.walk_forward(
        curves, indices, flat, facts, partial_first=True, echo=lambda *_: None
    )
    assert 2019 not in committed["aggressive"].index
    assert partial["aggressive"].at[2019, "selected_on"].endswith("(partial)")
    assert "2017-12-29" in partial["aggressive"].at[2019, "selected_on"]
