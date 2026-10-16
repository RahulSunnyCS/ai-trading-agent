"""A group's own numbers and curve for the Saved runs table: its sleeves as equal capital."""

import pandas as pd
import pytest

from momentum_backtesting import metrics, runs_store


def _member(id_, values, **kpis):
    dates = pd.date_range("2024-01-05", periods=len(values), freq="W-FRI").strftime("%Y-%m-%d")
    return {
        "id": id_,
        "latest": {
            "kpis": {"cagr": 0.2, "excess_cagr": 0.1, "sharpe": 1.0, "turnover_per_year": 4.0}
            | kpis,
            "dates": list(dates),
            "strategy": values,
        },
    }


def test_two_identical_sleeves_blend_to_the_same_curve_and_cagr():
    values = [100.0 + 2 * i + (i % 5) for i in range(80)]
    blend = runs_store.group_blend([_member("a", values), _member("b", values)])
    assert blend["members"] == 2 and len(blend["strategy"]) == len(values)
    assert blend["strategy"][0] == pytest.approx(100.0) and blend["strategy"][-1] == pytest.approx(
        values[-1], rel=1e-3
    )
    curve = pd.Series(values, index=pd.to_datetime(blend["dates"]))
    assert blend["kpis"]["cagr"] == pytest.approx(metrics.cagr(curve), rel=1e-6)
    assert blend["kpis"]["max_drawdown"] == pytest.approx(metrics.max_drawdown(curve)[0], rel=1e-6)
    # Benchmark CAGR is cagr - excess (0.1); the blend's edge is measured against it.
    assert blend["kpis"]["excess_cagr"] == pytest.approx(blend["kpis"]["cagr"] - 0.1)


def test_unequal_sleeves_are_held_at_equal_capital_not_summed_by_value():
    # Twelve weeks from 5 Jan end before the April reset, so the split is never restored.
    up = [100.0 * 1.01**i for i in range(12)]
    flat = [100.0] * 12
    blend = runs_store.group_blend([_member("a", up), _member("b", flat)])
    assert blend["strategy"][-1] == pytest.approx((up[-1] + 100.0) / 2, abs=1)


def test_a_group_with_fewer_than_two_curves_has_no_blend():
    assert runs_store.group_blend([]) is None
    assert runs_store.group_blend([_member("a", [100.0, 101.0, 102.0])]) is None
    empty = {"id": "b", "latest": {"kpis": {}, "dates": [], "strategy": []}}
    assert runs_store.group_blend([_member("a", [100.0, 101.0, 102.0]), empty]) is None


def test_the_blend_is_cached_until_a_member_curve_changes(monkeypatch):
    from momentum_backtesting import choose

    calls = []
    real = choose.ensemble_curve
    monkeypatch.setattr(choose, "ensemble_curve", lambda *a, **k: calls.append(1) or real(*a, **k))
    runs_store._BLEND_CACHE.clear()
    values = [100.0 + i for i in range(12)]
    members = [_member("a", values), _member("b", values)]
    first = runs_store.group_blend(members)
    assert runs_store.group_blend(members) is first and len(calls) == 1
    changed = [_member("a", values), _member("b", [*values[:-1], values[-1] + 5])]
    assert runs_store.group_blend(changed) is not first and len(calls) == 2


def test_the_blend_starts_at_the_sleeves_value_on_their_first_common_week():
    # Sleeve b was saved over a later period: the blend's window starts with it, and its first
    # value is what the sleeves were worth then (not sleeve a's value on its own first week).
    a = _member("a", [100.0 * 1.01**i for i in range(12)])
    b = _member("b", [150.0] * 4 + [150.0 * 1.01**i for i in range(8)])
    b["latest"]["dates"] = a["latest"]["dates"][4:] + ["2024-04-05"] * 0
    b["latest"]["strategy"] = [150.0 * 1.01**i for i in range(8)]
    blend = runs_store.group_blend([a, b])
    expected = (a["latest"]["strategy"][4] + 150.0) / 2
    assert blend["dates"][0] == a["latest"]["dates"][4]
    assert blend["strategy"][0] == pytest.approx(expected, abs=1)
