"""Unit tests for scripts/overextension_trim_tests.py (TODO.md 3.9.26) on hand-built frames."""

import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

_SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(_SCRIPTS))
import overextension_trim_tests as ott  # noqa: E402

WEEKS = pd.date_range("2021-01-01", periods=8, freq="W-FRI")


def _frame(data: dict, index=WEEKS) -> pd.DataFrame:
    return pd.DataFrame(data, index=index[: len(next(iter(data.values())))])


def test_spell_ids_and_eligibility():
    held = _frame({"A": [False, True, True, True, False, True, True, True]})
    assert ott.spell_ids(held)["A"].tolist() == [0, 1, 1, 1, 0, 2, 2, 2]
    # Held after trades at t-2, t-1 and t: only the third week of each spell qualifies.
    assert ott.eligible_matrix(held, 2)["A"].tolist() == [
        False,
        False,
        False,
        True,
        False,
        False,
        False,
        True,
    ]


def test_held_matrix_carries_holdings_through_skipped_weeks_and_drops_idle():
    engine_weeks = WEEKS[[0, 1, 4]]
    weights = pd.DataFrame(
        {"A": [0.5, 0.6, 0.0], "B": [0.0, 0.4, 1.0], "Idle": [0.5, 0.0, 0.0]}, index=engine_weeks
    )
    held = ott.held_matrix(weights, WEEKS[:6], idle_col="Idle")
    assert list(held.columns) == ["A", "B"]
    assert held["A"].tolist() == [True, True, True, True, False, False]  # weeks 2-3 skipped
    assert held["B"].tolist() == [False, True, True, True, True, True]


def test_detect_events_keeps_one_event_per_spell_per_four_weeks():
    signal = _frame({"A": [True, True, False, True, True, False, False, True]})
    spells = _frame({"A": [1] * 8})
    events = ott.detect_events(signal, spells, cooldown=4)
    # Week 0 kept; 1 and 3 are within 4 weeks of it; 4 is exactly 4 weeks later -> kept;
    # 7 is 3 weeks after week 4 -> dropped.
    assert events == [(WEEKS[0], "A"), (WEEKS[4], "A")]


def test_detect_events_restarts_the_cooldown_in_a_new_holding_spell():
    signal = _frame({"A": [True, False, True, False], "B": [False, True, True, False]})
    spells = _frame({"A": [1, 0, 2, 2], "B": [3, 3, 3, 3]})
    events = ott.detect_events(signal, spells, cooldown=4)
    assert events == [(WEEKS[0], "A"), (WEEKS[1], "B"), (WEEKS[2], "A")]


def test_run_return_and_vol_score_have_no_lookahead():
    rng = np.random.default_rng(0)
    idx = pd.date_range("2020-01-03", periods=40, freq="W-FRI")
    px = pd.DataFrame({"A": 100 * np.cumprod(1 + rng.normal(0, 0.02, 40))}, index=idx)
    r2 = ott.run_return(px, 2)
    assert r2["A"].iloc[-1] == pytest.approx(px["A"].iloc[-1] / px["A"].iloc[-3] - 1)
    z = ott.vol_score(px, 2)
    weekly = px["A"].pct_change()
    vol = weekly.iloc[-28:-2].std()  # 26 weekly returns ending at t-2
    assert z["A"].iloc[-1] == pytest.approx(r2["A"].iloc[-1] / (vol * math.sqrt(2)))
    # A jump at t changes r2[t] but not the yardstick it is divided by.
    shocked = px.copy()
    shocked.iloc[-1] *= 1.5
    z2 = ott.vol_score(shocked, 2)
    assert z2["A"].iloc[-1] / z["A"].iloc[-1] == pytest.approx(
        ott.run_return(shocked, 2)["A"].iloc[-1] / r2["A"].iloc[-1]
    )


def test_forward_return_and_other_holdings_excess_by_hand():
    px = _frame({"A": [100, 110.0], "B": [50, 51.0], "C": [20, 19.2], "D": [10, 30.0]})
    fwd = ott.forward_return(px, 1)
    assert fwd.iloc[0].tolist() == pytest.approx([0.10, 0.02, -0.04, 2.0])
    held = _frame({"A": [True, True], "B": [True, True], "C": [True, True], "D": [False, False]})
    others = ott.other_holdings_return(fwd, held)
    # For A: B and C equal-weighted = (2% - 4%) / 2 = -1%; the unheld D never counts.
    assert others.at[WEEKS[0], "A"] == pytest.approx(-0.01)
    assert others.at[WEEKS[0], "B"] == pytest.approx((0.10 - 0.04) / 2)
    # Excess = alternative - stock: trimming A into B and C would have lost 11 points.
    assert ott.excess(others.at[WEEKS[0], "A"], fwd.at[WEEKS[0], "A"]) == pytest.approx(-0.11)
    assert ott.excess(0.05, 0.02) == pytest.approx(0.03)  # positive = trimming helped


def test_other_holdings_is_nan_when_nothing_else_is_held():
    fwd = _frame({"A": [0.1], "B": [0.2]})
    held = _frame({"A": [True], "B": [False]})
    assert math.isnan(ott.other_holdings_return(fwd, held).at[WEEKS[0], "A"])


def test_best_unheld_skips_held_and_disallowed_names():
    ranks = _frame({"A": [1.0, 2.0], "B": [2.0, 1.0], "C": [3.0, np.nan]})
    held = _frame({"A": [True, False], "B": [False, False], "C": [False, False]})
    allowed = _frame({"A": [True, True], "B": [False, True], "C": [True, True]})
    best = ott.best_unheld(ranks, held, allowed)
    assert best.tolist() == ["C", "B"]


def test_fisher_greater_matches_a_hand_computed_case():
    # 3 of 3 hits peak, 0 of 3 non-hits: p = 1 / C(6, 3).
    assert ott.fisher_greater(3, 0, 0, 3) == pytest.approx(1 / 20)
    assert ott.fisher_greater(0, 3, 3, 0) == pytest.approx(1.0)


def test_weekly_mean_ci_averages_within_a_week_first_and_skips_thin_samples():
    cal = pd.date_range("2020-01-03", periods=30, freq="W-FRI")
    weeks = pd.Series([cal[0], cal[0], cal[3]])
    values = pd.Series([0.10, 0.30, 0.0])
    mean, lo, hi, n = ott.weekly_mean_ci(weeks, values, cal)
    assert n == 2
    assert mean == pytest.approx((0.20 + 0.0) / 2)  # week means 20% and 0%, not event mean
    assert math.isnan(lo) and math.isnan(hi)  # fewer than MIN_CI_WEEKS event weeks
