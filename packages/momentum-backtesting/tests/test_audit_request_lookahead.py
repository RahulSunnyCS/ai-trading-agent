"""The comparison behind `mbt audit lookahead-requests` (BL-010 Phase 2 step 4, extended)."""

from __future__ import annotations

import copy

from momentum_backtesting.audit import request_lookahead as rl


def _ok(**over):
    response = {
        "kpis": {"cagr": 0.25, "max_drawdown": -0.3},
        "series": {"strategy": [100000.0, 101000.0, 99000.0]},
        "trades": [{"week": "2021-06-25", "asset": "AAA", "price": 10.0, "value": 5000.0}],
        "rotations": [],
        "yearly": [{"year": 2021, "ret": 0.01}],
        "open_positions": [],
        "companion": None,
    }
    response.update(over)
    return {"status": 200, "response": response}


def test_identical_runs_have_no_differences():
    assert rl.compare(_ok(), _ok()) == []


def test_a_later_split_rescaling_a_price_level_is_not_a_difference():
    other = copy.deepcopy(_ok())
    other["response"]["trades"][0]["price"] = 20.0
    assert rl.compare(_ok(), other) == []


def test_a_moved_equity_point_is_named():
    other = copy.deepcopy(_ok())
    other["response"]["series"]["strategy"][2] = 98000.0
    found = rl.compare(_ok(), other)
    assert found and found[0].startswith("series.strategy.2:")


def test_a_different_trade_is_named():
    other = copy.deepcopy(_ok())
    other["response"]["trades"][0]["asset"] = "BBB"
    assert any("trades.0.asset" in line for line in rl.compare(_ok(), other))


def test_float_noise_under_the_tolerance_is_ignored():
    other = copy.deepcopy(_ok())
    other["response"]["kpis"]["cagr"] = 0.25 * (1 + 1e-12)
    assert rl.compare(_ok(), other) == []


def test_a_failed_run_is_reported_not_compared():
    bad = {"status": 422, "response": {"detail": "weekly closes are missing"}}
    assert "status 200 against 422" in rl.compare(_ok(), bad)[0]


def test_a_length_mismatch_is_reported():
    other = copy.deepcopy(_ok())
    other["response"]["series"]["strategy"].append(1.0)
    assert any("3 items against 4" in line for line in rl.compare(_ok(), other))


def test_nan_against_a_number_is_a_difference_and_nan_against_nan_is_not():
    nan = float("nan")
    assert rl.differences({"a": nan}, {"a": 5.0})
    assert rl.differences({"a": 5.0}, {"a": nan})
    assert not rl.differences({"a": nan}, {"a": nan})
    assert rl.differences({"a": float("inf")}, {"a": 5.0})
    assert not rl.differences({"a": float("inf")}, {"a": float("inf")})


def test_only_broad_requests_are_accepted(tmp_path):
    import pytest

    with pytest.raises(ValueError, match="only Broad"):
        rl.check({"etf run": {"dataset": "etf"}}, ["2021-06-25"], tmp_path)


def test_holdings_listed_in_a_different_order_are_not_a_difference():
    def week(order):
        return {
            "rotations": [{"week": "w", "holdings": [{"asset": a, "share": 0.25} for a in order]}]
        }

    a, b = _ok(**week(["POWERGRID", "JKPAPER"])), _ok(**week(["JKPAPER", "POWERGRID"]))
    assert rl.compare(a, b) == []
    c = _ok(**week(["JKPAPER", "OTHER"]))
    assert rl.compare(a, c)  # a different holding still counts
