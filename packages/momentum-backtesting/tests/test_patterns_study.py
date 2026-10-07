"""BL-042 Phases 4-5: ranking shapes and the event-study statistics."""

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
    # addendum 1 swapped filter_20 -> filter_100 and bonus_5 -> bonus_25
    assert [v[0] for v in ranking.variants()] == [
        "blend_0.25", "blend_0.5", "blend_0.75", "filter_40", "filter_100", "bonus_10", "bonus_25",
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


def test_phases_4_and_5_refuse_before_the_detectors_are_frozen(tmp_path, monkeypatch):
    from momentum_backtesting import patterns
    from momentum_backtesting.patterns import run

    monkeypatch.setattr(patterns, "SEARCH_SPACES", tmp_path)
    with pytest.raises(RuntimeError, match="freeze the detectors"):
        run.event_study(tmp_path)
    with pytest.raises(RuntimeError, match="freeze the detectors"):
        run.ranking_test(tmp_path)


def _write(path, data):
    import json

    path.write_text(json.dumps(data))


def test_holdout_entrants_need_all_three_passes(tmp_path, monkeypatch):
    from momentum_backtesting import patterns
    from momentum_backtesting.patterns import holdout

    monkeypatch.setattr(holdout, "SEARCH_SPACES", tmp_path)
    monkeypatch.setattr(patterns, "SEARCH_SPACES", tmp_path)
    _write(
        tmp_path / "bl042_criteria_addendum_2.json",
        {"detectors_frozen": True, "dropped_patterns": ["cup_handle"]},
    )
    _write(
        tmp_path / "bl042_event_study_result.json",
        {"verdicts": {"tight_range": "pass", "flag": "kill", "cup_handle": "pass"}},
    )
    _write(
        tmp_path / "bl042_dev_result.json",
        {
            "verdicts": {"tight_range": "pass", "flag": "pass", "cup_handle": "pass"},
            "holdout_choice": {
                "tight_range": "tight_range/blend_0.5",
                "flag": "flag/bonus_5",
                "cup_handle": "cup_handle/filter_20",
            },
        },
    )
    assert holdout.entrants() == {"tight_range": "tight_range/blend_0.5"}


def test_holdout_runs_once(tmp_path, monkeypatch):
    from momentum_backtesting.patterns import holdout

    monkeypatch.setattr(holdout, "SEARCH_SPACES", tmp_path)
    monkeypatch.setattr(holdout.bl010_holdout, "_dirty", lambda: False)
    monkeypatch.setattr(holdout, "entrants", lambda: {})
    report = holdout.run(tmp_path / "out", echo=lambda *_: None)
    assert report["entrants"] == {} and "not read" in report["note"]
    with pytest.raises(RuntimeError, match="runs once"):
        holdout.run(tmp_path / "out", echo=lambda *_: None)
    (tmp_path / holdout.RESULT).unlink()  # even without the result, the claim still blocks
    with pytest.raises(RuntimeError, match="already started"):
        holdout.run(tmp_path / "out", echo=lambda *_: None)


def test_holdout_judge():
    from momentum_backtesting.patterns import holdout

    weeks = pd.date_range("2024-01-05", periods=157, freq="W-FRI")
    base = pd.Series(np.linspace(1.0, 1.3, 157), index=weeks)
    mine = pd.Series(np.linspace(1.0, 1.5, 157), index=weeks)
    verdict = holdout.judge(base, mine)
    assert verdict["excess_cagr_pts"] > 2 and verdict["passes"]
    assert not holdout.judge(mine, base)["passes"]


def test_blend_reads_the_quality_weighted_table_and_filter_the_state():
    graded = _pool([[0, 0, 0, 0.2, 0]])  # D detected but sloppy: state 1.0, quality 0.2
    out = ranking.apply("blend", POOL, SCORE, 0.75, blend=graded).iloc[0]
    assert out["D"] > 1  # 0.75 * 0.2 = 0.15 no longer beats A (0.25)
    out = ranking.apply("filter", POOL, SCORE, 40, blend=graded).iloc[0]
    assert out["D"] == 1  # the filter reads the state, not the quality


def test_quality_grades():
    from momentum_backtesting.patterns.quality import grade, with_quality

    perfect_cup = {"depth": 0.22, "handle_depth": 0.0, "right_vs_left": 0.0, "prior_advance": 1.2}
    sloppy_cup = {"depth": 0.34, "handle_depth": 0.14, "right_vs_left": 0.09, "prior_advance": 0.32}
    assert grade("cup_handle", perfect_cup) == pytest.approx(1.0)
    assert grade("cup_handle", sloppy_cup) < 0.15
    tight = {"weeks": 5, "range": 0.03, "range_vs_own_median": 0.2, "volume_10d_vs_50d": None}
    assert 0.5 < grade("tight_range", tight) < 1
    flag = {"retrace_of_pole": 0.0, "flag_vs_pole_volume": 0.3, "pole_rise": 0.7}
    assert grade("flag", flag) == pytest.approx(1.0)
    assert math.isnan(grade("high_tight_flag", {}))
    det = pd.DataFrame(
        {
            "pattern": ["cup_handle"],
            "geometry": [__import__("json").dumps(perfect_cup)],
            "score": [0.75],
        }  # fmt: skip
    )
    assert with_quality(det)["blend_score"].iloc[0] == pytest.approx(0.75)


def test_weekly_statistic_excluded_names_are_not_controls():
    weeks = WEEKS[:1]
    cols = ["E", "X", "C"]
    ranks = pd.DataFrame([[1, 1, 1]], index=weeks, columns=cols, dtype=float)
    rets = pd.DataFrame([[0.10, 0.50, 0.00]], index=weeks, columns=cols)
    events = pd.DataFrame([[True, False, False]], index=weeks, columns=cols)
    exclude = pd.DataFrame([[False, True, False]], index=weeks, columns=cols)
    assert study.weekly_statistic(rets, ranks, events).iloc[0] == pytest.approx(-0.15)
    assert study.weekly_statistic(rets, ranks, events, exclude).iloc[0] == pytest.approx(0.10)
