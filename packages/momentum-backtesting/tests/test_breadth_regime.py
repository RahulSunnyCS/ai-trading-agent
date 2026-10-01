"""Unit tests for scripts/breadth_regime_tests.py (TODO.md 3.9.24) on small hand-built frames."""

import importlib.util
import math
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

_PATH = Path(__file__).resolve().parents[1] / "scripts" / "breadth_regime_tests.py"
_SPEC = importlib.util.spec_from_file_location("breadth_regime_tests", _PATH)
brt = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(brt)

WEEKS = pd.date_range("2020-01-03", periods=6, freq="W-FRI")


def test_breadth_counts_only_members_with_full_average_history():
    prices = pd.DataFrame(
        {
            "A": [10, 11, 12, 13, 12, 11],  # rising then falling
            "B": [10, 9, 8, 7, 8, 9],  # falling then rising
            "C": [np.nan, np.nan, 5, 6, 7, 8],  # lists in week 3
        },
        index=WEEKS,
    )
    members = pd.DataFrame(True, index=WEEKS, columns=prices.columns)
    members.loc[WEEKS[5], "A"] = False  # A leaves the index in the last week
    pct, eligible = brt.breadth(prices, members, window=3)

    # Weeks 1-2: no one has 3 closes yet.
    assert eligible.iloc[:2].tolist() == [0, 0]
    assert pct.iloc[:2].isna().all()
    # Week 3: A 12 > mean(10,11,12)=11 above; B 8 < 9 below; C has 1 close -> ineligible.
    assert eligible.iloc[2] == 2
    assert pct.iloc[2] == pytest.approx(50.0)
    # Week 5: A 12 vs 12.33 below; B 8 vs 7.67 above; C 7 vs 6 above.
    assert eligible.iloc[4] == 3
    assert pct.iloc[4] == pytest.approx(200 / 3)
    # Week 6: A is no longer a member; B 9 > 8 above, C 8 > 7 above.
    assert eligible.iloc[5] == 2
    assert pct.iloc[5] == pytest.approx(100.0)


def test_breadth_has_no_lookahead():
    """Changing a future price never changes an earlier week's breadth."""
    prices = pd.DataFrame({"A": [1, 2, 3, 4, 5, 6.0], "B": [6, 5, 4, 3, 2, 1.0]}, index=WEEKS)
    members = pd.DataFrame(True, index=WEEKS, columns=prices.columns)
    before, _ = brt.breadth(prices, members, window=2)
    shocked = prices.copy()
    shocked.iloc[-1] = [0.0, 0.0]
    after, _ = brt.breadth(shocked, members, window=2)
    pd.testing.assert_series_equal(before.iloc[:-1], after.iloc[:-1])
    assert after.iloc[-1] != before.iloc[-1]


def test_trend_flag_needs_close_above_a_rising_average():
    close = pd.Series([1, 2, 3, 4, 5, 4.0], index=WEEKS)
    flag = brt.trend_flag(close, window=2, slope_lag=1)
    # Average: nan, 1.5, 2.5, 3.5, 4.5, 4.5. Week 6: 4 < 4.5 and the average stopped rising.
    assert flag.tolist() == [False, False, True, True, True, False]


def test_apply_hold_keeps_each_new_state_for_two_weeks():
    target = pd.Series([1, 0.5, 1, 1, 0.5, 1, 1], index=pd.RangeIndex(7), dtype=float)
    held = brt.apply_hold(target, min_hold=2)
    # The switch to 0.5 at week 1 holds through week 2 although the target is back at 1; week 3
    # switches back to 1, so the target's 0.5 at week 4 is ignored (1 must hold weeks 3-4).
    assert held.tolist() == [1, 0.5, 0.5, 1, 1, 1, 1]


def test_overlay_arithmetic_by_hand():
    idx = pd.RangeIndex(4)
    strat = pd.Series([np.nan, 0.10, -0.05, 0.02], index=idx)
    cash = pd.Series([np.nan, 0.01, 0.01, 0.01], index=idx)
    w = pd.Series([1.0, 0.6, 0.6, 1.0], index=idx)
    out = brt.overlay_returns(strat, cash, w, cost_pct=0.10)

    # Week 1 earns w[0]=1 on the strategy, no cost (w[0] equals the implied prior 1).
    assert out.loc[1, "ret"] == pytest.approx(0.10)
    # Week 2 earns w[1]=0.6 and pays the 1 -> 0.6 switch decided at week 1: 0.4 * 2 * 0.1%.
    expected = 0.6 * -0.05 + 0.4 * 0.01 - 0.4 * 2 * 0.10 / 100
    assert out.loc[2, "ret"] == pytest.approx(expected)
    # Week 3 earns w[2]=0.6, no switch at week 2.
    assert out.loc[3, "ret"] == pytest.approx(0.6 * 0.02 + 0.4 * 0.01)
    assert out["exposure"].tolist() == [1.0, 0.6, 0.6]
    assert out["cost"].sum() == pytest.approx(0.0008)


def test_full_exposure_overlay_reproduces_the_strategy():
    eq = pd.Series([1.0, 1.1, 1.05, 1.2], index=WEEKS[:4])
    cash = pd.Series([1.0, 1.001, 1.002, 1.003], index=WEEKS[:4])
    out = brt.overlay_returns(
        eq.pct_change(), cash.pct_change(), pd.Series(1.0, index=eq.index), 0.1
    )
    rebuilt = brt.equity_from(out["ret"])
    assert rebuilt.iloc[-1] == pytest.approx(1.2)


def test_weekly_marks_carries_holdings_through_a_skipped_week():
    prices = pd.DataFrame(
        {"X": [100, 110, 121, 121.0], "Cash": [1, 1.01, 1.0201, 1.030301]}, index=WEEKS[:4]
    )
    equity = pd.Series([1.0, 1.08, 1.1], index=[WEEKS[0], WEEKS[1], WEEKS[3]])  # week 3 skipped
    weights = pd.DataFrame({"X": [0.5, 0.75, 0.7], "Idle": [0.5, 0.25, 0.3]}, index=equity.index)
    marked = brt.weekly_marks(equity, weights, prices, cash_col="Cash", idle_col="Idle")

    assert list(marked.index) == list(WEEKS[:4])
    assert marked["engine_week"].tolist() == [True, True, False, True]
    expected = 1.08 * (0.75 * 121 / 110 + 0.25 * 1.0201 / 1.01)
    assert marked.loc[WEEKS[2], "equity"] == pytest.approx(expected)
    assert marked.loc[WEEKS[3], "equity"] == pytest.approx(1.1)  # engine's own value kept
    assert marked["cash"].iloc[0] == 1.0


def test_episodes_counts_separate_runs():
    assert brt.episodes(pd.Series([False, True, True, False, True, False, True])) == 3
    assert brt.episodes(pd.Series([True, True])) == 1
    assert brt.episodes(pd.Series([False, False])) == 0


def test_block_bootstrap_of_a_constant_is_that_constant():
    values = np.full(40, 0.02)
    mask = np.arange(40) % 3 == 0
    boot = brt.block_bootstrap_means(values, {"m": mask}, reps=50)
    assert np.allclose(boot["m"], 0.02)


def test_metrics_from_returns_annualises_on_calendar_time():
    idx = pd.date_range("2020-01-10", periods=52, freq="W-FRI")
    ret = pd.Series(0.001, index=idx)
    m = brt.metrics_from_returns(ret, pd.Series(0.0, index=idx))
    years = 52 * 7 / 365.25
    assert m["CAGR"] == pytest.approx(1.001 ** (52 / years) - 1)
    assert m["max_dd"] == 0
    assert math.isnan(m["Calmar"])
