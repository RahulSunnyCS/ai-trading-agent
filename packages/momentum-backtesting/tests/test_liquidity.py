"""Tests for categories/liquidity.py - the tradability gate's decision logic.

The SQL feature build needs a real bhavcopy lake, so these exercise the pure parts (thresholds,
reasons, week alignment) against hand-built feature frames.
"""

from __future__ import annotations

import pandas as pd
import pytest

from momentum_backtesting import api
from momentum_backtesting.categories import liquidity as liq


def _features(rows: list[dict]) -> pd.DataFrame:
    base = {
        "n60": 60,
        "noneq60": 0,
        "zero60": 0,
        "med60": 5.0,
        "p10_60": 2.0,
        "maxrun125": 0,
        "bandhits60": 0,
        "px": 100.0,
        "wk": pd.Timestamp("2026-09-25"),
    }
    return pd.DataFrame([{**base, **row} for row in rows])


def test_healthy_stock_passes_and_each_rule_can_fail_it() -> None:
    cfg = liq.LiquidityConfig(min_turnover_cr=1.0, max_circuit_days=3)
    frame = _features(
        [
            {"symbol": "OK"},
            {"symbol": "THIN", "med60": 0.4},
            {"symbol": "QUIET", "p10_60": 0.1},
            {"symbol": "PENNY", "px": 8.0},
            {"symbol": "BE", "noneq60": 4},
            {"symbol": "HALT", "zero60": 1},
            {"symbol": "NEW", "n60": 30},
            {"symbol": "LOCKED", "maxrun125": 3},
            {"symbol": "TWITCHY", "bandhits60": 4},
        ]
    )
    passed = dict(zip(frame["symbol"], liq._passes(frame, cfg), strict=True))
    assert passed == {
        "OK": True,
        "THIN": False,
        "QUIET": False,
        "PENNY": False,
        "BE": False,
        "HALT": False,
        "NEW": False,
        "LOCKED": False,
        "TWITCHY": False,
    }


def test_circuit_rules_can_be_switched_off() -> None:
    frame = _features([{"symbol": "LOCKED", "maxrun125": 5, "bandhits60": 30}])
    assert not liq._passes(frame, liq.LiquidityConfig(max_circuit_days=10)).iloc[0]
    assert liq._passes(frame, liq.LiquidityConfig(circuit=False)).iloc[0]


def test_run_shorter_than_threshold_is_allowed() -> None:
    frame = _features([{"symbol": "X", "maxrun125": 2}])
    assert liq._passes(frame, liq.LiquidityConfig(circuit_run=3)).iloc[0]
    assert not liq._passes(frame, liq.LiquidityConfig(circuit_run=2)).iloc[0]


@pytest.mark.parametrize(
    "cfg",
    [
        liq.LiquidityConfig(min_turnover_cr=0),
        liq.LiquidityConfig(floor_ratio=1.5),
        liq.LiquidityConfig(min_price=-1),
        liq.LiquidityConfig(circuit_run=1),
        liq.LiquidityConfig(max_circuit_days=61),
    ],
)
def test_validate_rejects_out_of_range_settings(cfg: liq.LiquidityConfig) -> None:
    with pytest.raises(ValueError):
        cfg.validate()


def test_last_full_week_ignores_a_partial_top_up_week() -> None:
    weeks = pd.date_range("2026-08-07", periods=8, freq="W-FRI")
    rows = [{"symbol": f"S{i}", "wk": week} for week in weeks[:-1] for i in range(100)] + [
        {"symbol": f"S{i}", "wk": weeks[-1]} for i in range(20)
    ]  # just the top-up pool
    assert liq._last_full_week(_features(rows)) == weeks[-2]


def test_eligibility_reuses_a_verdict_for_one_holiday_week_only(monkeypatch) -> None:
    weeks = pd.date_range("2026-09-04", periods=4, freq="W-FRI")
    frame = _features([{"symbol": "A", "wk": weeks[0]}])  # nothing for the next weeks
    monkeypatch.setattr(liq, "weekly_features", lambda symbols, root=None: frame)
    out = liq.eligibility(liq.LiquidityConfig(), ["A"], pd.Index(weeks))
    assert out["A"].tolist() == [True, True, False, False]


def test_preview_reports_why_a_stock_failed(monkeypatch) -> None:
    frame = _features([{"symbol": "OK"}, {"symbol": "THIN", "med60": 0.2}])
    monkeypatch.setattr(liq, "weekly_features", lambda symbols, root=None: frame)
    result = liq.preview(liq.LiquidityConfig(), ["OK", "THIN", "GONE"])
    assert result["eligible"] == 1
    assert result["reasons"] == {"median turnover too low": 1, "no recent trading": 1}
    assert {row["symbol"] for row in result["excluded"]} == {"THIN", "GONE"}
    assert result["warning"] is None


def test_whole_market_universe_forces_the_gate_on() -> None:
    req = api.BacktestRequest(
        dataset="broad", universe=["broad_momentum"], broad_universe="all_liquid"
    )
    cfg = api._liquidity_config(req)
    assert cfg is not None
    assert cfg.min_turnover_cr == 1.0 and cfg.max_circuit_days is None


def test_default_request_keeps_the_original_ungated_pool() -> None:
    req = api.BacktestRequest(dataset="broad", universe=["broad_momentum"])
    assert req.broad_universe == "total_market"
    assert req.broad_respect_circuits is False  # fills ignore locks unless asked
    assert api._liquidity_config(req) is None
