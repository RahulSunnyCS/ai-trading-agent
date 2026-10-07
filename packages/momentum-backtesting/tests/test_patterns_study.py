"""BL-041 Phases 4-5: ranking shapes and the event-study statistics."""

from __future__ import annotations

import math

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting.patterns import ranking, study

WEEKS = pd.date_range("2020-01-03", periods=3, freq="W-FRI")


def _pool(rows):
    return pd.DataFrame(rows, index=WEEKS[: len(rows)], columns=list("ABCDE"), dtype=float)


POOL = _pool([[1, 2, 3, 4, np.nan]])
SCORE = _pool([[0, 0, 0, 1.0, 1.0]])  # D detected; E detected but outside the pool


def test_blend_orders_by_the_mixed_score():
    low = ranking.blend(POOL, SCORE, 0.25).iloc[0]
    high = ranking.blend(POOL, SCORE, 0.75).iloc[0]
    assert list(low[["A", "B", "C", "D"]]) == [1, 2, 3, 4]  # D: 0.25 < C: 0.25 tie -> pool rank
    assert high["D"] == 1  # D: 0.75 beats A: 0.25
    assert math.isnan(high["E"])


def test_filter_puts_detected_top_names_first():
    out = ranking.filter_top(POOL, SCORE, 4).iloc[0]
    assert list(out[["D", "A", "B", "C"]]) == [1, 2, 3, 4]
    out = ranking.filter_top(POOL, SCORE, 3).iloc[0]  # D is rank 4: outside top 3
    assert list(out[["A", "B", "C", "D"]]) == [1, 2, 3, 4]


def test_bonus_moves_up_by_ranks_with_ties_to_pool_rank():
    out = ranking.bonus(POOL, SCORE, 2).iloc[0]  # D: 4 - 2 = 2, ties B (2) -> B first
    assert list(out[["A", "B", "D", "C"]]) == [1, 2, 3, 4]


def test_seven_variants():
    assert [v[0] for v in ranking.variants()] == [
        "blend_0.25", "blend_0.5", "blend_0.75", "filter_20", "filter_40", "bonus_5", "bonus_10",
    ]  # fmt: skip


def test_weekly_statistic_compares_within_deciles():
    weeks = WEEKS[:1]
    ranks = pd.DataFrame([list(range(1, 21))], index=weeks, columns=[f"S{i}" for i in range(20)])
    rets = pd.DataFrame([[0.0] * 20], index=weeks, columns=ranks.columns)
    rets.loc[:, "S0"] = 0.10  # an event in decile 1 (ranks 1-2)
    rets.loc[:, "S1"] = 0.02  # its control
    rets.loc[:, "S19"] = 0.50  # a big mover in another decile must not matter
    events = pd.DataFrame(False, index=weeks, columns=ranks.columns)
    events.loc[:, "S0"] = True
    stat = study.weekly_statistic(rets, ranks, events)
    assert stat.iloc[0] == pytest.approx(0.08)


def test_newey_west_matches_plain_t_without_lags_and_holm():
    rng = np.random.default_rng(0)
    x = pd.Series(rng.normal(0.1, 1, 400))
    plain = x.mean() / (x.std(ddof=0) / math.sqrt(len(x)))
    assert study.newey_west_t(x, 0) == pytest.approx(plain)
    assert study.one_sided_p(1.6449) == pytest.approx(0.05, abs=1e-4)
    out = study.holm({"a": 0.001, "b": 0.02, "c": 0.04}, 0.05)
    assert out == {"a": True, "b": True, "c": True}
    out = study.holm({"a": 0.001, "b": 0.03, "c": 0.04}, 0.05)
    assert out == {"a": True, "b": False, "c": False}


def test_forward_returns_never_pass_the_last_week():
    prices = pd.DataFrame({"A": [100.0, 110.0, 121.0]}, index=WEEKS)
    fwd = study.forward_returns(prices, 1)
    assert fwd["A"].iloc[0] == pytest.approx(0.10)
    assert math.isnan(fwd["A"].iloc[-1])
