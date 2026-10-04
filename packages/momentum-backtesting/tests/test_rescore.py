"""Window statistics for the steady-highs re-score."""

import numpy as np
import pandas as pd

from momentum_backtesting import metrics


def test_window_stats_count_new_highs_and_time_under_water_inside_a_window():
    idx = pd.date_range("2017-01-06", periods=10, freq="7D")
    # 1.0 1.1 1.2 | 1.1 1.0 1.15 1.25 1.2 1.3 1.4
    eq = pd.Series([1.0, 1.1, 1.2, 1.1, 1.0, 1.15, 1.25, 1.2, 1.3, 1.4], index=idx)
    full = metrics.window_stats(eq, {"all": ("2017-01-01", None)})
    # new highs at weeks 1, 2, 6, 8, 9 -> 5 of 10 weeks
    assert full["all_newhigh"] == 0.5
    assert full["all_uw"] == 3  # weeks 3,4,5 sit below the 1.2 peak
    late = metrics.window_stats(eq, {"late": (str(idx[4].date()), None)})
    assert late["late_uw"] == 2 and late["late_newhigh"] == 0.5  # weeks 4-5 under; highs at 6, 8, 9
    assert late["late_cagr"] > 0


def test_window_stats_use_the_curves_full_history_for_the_running_high():
    idx = pd.date_range("2017-01-06", periods=8, freq="7D")
    eq = pd.Series([1.0, 2.0, 1.5, 1.6, 1.7, 1.8, 1.9, 1.95], index=idx)  # never regains 2.0
    late = metrics.window_stats(eq, {"late": (str(idx[3].date()), None)})
    assert (
        late["late_newhigh"] == 0.0 and late["late_uw"] == 5
    )  # whole window is under the old peak


def test_window_stats_skip_windows_with_fewer_than_two_weeks():
    idx = pd.date_range("2017-01-06", periods=5, freq="7D")
    out = metrics.window_stats(
        pd.Series(np.linspace(1, 2, 5), index=idx), {"none": ("2030-01-01", None)}
    )
    assert out == {}


def test_steady_selection_applies_filters_ladders_the_cap_and_ranks_by_cagr():
    from momentum_backtesting import steady

    n = 200
    rng = np.random.default_rng(0)
    df = pd.DataFrame(
        {
            "id": [f"r{i}" for i in range(n)],
            "cagr": rng.uniform(0.2, 0.4, n),
            "mdd": -rng.uniform(0.15, 0.30, n),
            "turnover_x": 1.5,
            "buys_per_yr": 40.0,
            steady.UW: rng.integers(20, 110, n).astype(float),
            "w1_cagr": 0.15,
            "w2_cagr": 0.15,
            "w1_newhigh": 0.3,
            "w2_newhigh": 0.3,
            f"hurdle_w1|{steady.HURDLE}": 0.10,
            f"hurdle_w2|{steady.HURDLE}": 0.10,
        }
    )
    chosen, cap, counts = steady.select_candidates(df, top=40)
    assert cap in steady.LADDER and counts[cap] >= steady.MIN_CANDIDATES or cap == steady.LADDER[-1]
    assert (
        (chosen[steady.UW] <= cap).all()
        and chosen.cagr.is_monotonic_decreasing
        and len(chosen) <= 40
    )
    # a candidate that does not keep up in a weak window is excluded whatever its CAGR
    bad = df.copy()
    bad.loc[bad.id == chosen.id.iloc[0], "w2_newhigh"] = 0.05
    assert chosen.id.iloc[0] not in set(steady.select_candidates(bad, 40)[0].id)


def test_relaxed_track_only_loosens_the_weak_window_hurdle():
    from momentum_backtesting import steady

    row = {
        "id": "x",
        "cagr": 0.3,
        "mdd": -0.2,
        "turnover_x": 1.0,
        "buys_per_yr": 30.0,
        steady.UW: 60.0,
        "w1_cagr": 0.08,
        "w2_cagr": 0.2,
        "w1_newhigh": 0.2,
        "w2_newhigh": 0.2,
        f"hurdle_w1|{steady.HURDLE}": 0.186,
        f"hurdle_w2|{steady.HURDLE}": 0.039,
    }
    df = pd.DataFrame([row])
    assert not steady.passes_filters(df, 104).iloc[0]  # trails the index in window 1
    assert steady.passes_filters(df, 104, relaxed=True).iloc[
        0
    ]  # but it still grows and makes highs
    slow = pd.DataFrame([{**row, "w2_newhigh": 0.05}])
    assert not steady.passes_filters(slow, 104, relaxed=True).iloc[0]  # new-high rule still applies
    long_uw = pd.DataFrame([{**row, steady.UW: 130.0}])
    assert not steady.passes_filters(long_uw, 104, relaxed=True).iloc[0]
