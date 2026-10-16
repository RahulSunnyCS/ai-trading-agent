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
    assert blend["strategy"][-1] == pytest.approx((up[-1] + 100.0) / 2, abs=0.01)


def test_a_group_with_fewer_than_two_curves_has_no_blend():
    assert runs_store.group_blend([]) is None
    assert runs_store.group_blend([_member("a", [100.0, 101.0, 102.0])]) is None
    empty = {"id": "b", "latest": {"kpis": {}, "dates": [], "strategy": []}}
    assert runs_store.group_blend([_member("a", [100.0, 101.0, 102.0]), empty]) is None
