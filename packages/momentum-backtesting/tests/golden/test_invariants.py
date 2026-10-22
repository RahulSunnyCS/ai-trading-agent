"""Things that must be true of every backtest result, whatever the settings (BL-001 Phase 2).

The frozen results prove a result did not move; these prove the frozen result is internally
consistent. They read the frozen payloads, so they cost no extra backtest, and a change that
accepts new results (`update-goldens.py --accept-results`) is checked against them in the same
run. A check that fails on a baseline is a finding to investigate, never a reason to loosen the
check: write it up in BL-001's Log and fix the engine or the payload.
"""

from __future__ import annotations

import math

import pandas as pd
import pytest

from momentum_backtesting import metrics

from .harness import load_expected
from .scenarios import SCENARIOS

#: The payload is on a Rs 1 lakh basis whatever capital the request sets.
START = 100_000.0
#: Floats in the frozen files are rounded to 10 significant digits.
TOL = 1e-6


@pytest.fixture(scope="module")
def frozen() -> dict[str, dict]:
    return {name: load_expected(name) for name in SCENARIOS}


def _equity(response: dict) -> pd.Series:
    series = response["series"]
    return pd.Series(series["strategy"], index=pd.to_datetime(series["dates"]), dtype="float64")


@pytest.mark.parametrize("name", sorted(SCENARIOS))
def test_equity_starts_at_capital_stays_positive_and_dates_run_forward(name, frozen):
    response = frozen[name]["response"]
    equity = _equity(response)
    assert len(equity) == len(response["series"]["dates"]) > 2
    assert equity.iloc[0] == pytest.approx(START)
    assert (equity > 0).all()
    assert equity.index.is_monotonic_increasing and equity.index.is_unique


@pytest.mark.parametrize("name", sorted(SCENARIOS))
def test_reported_totals_match_the_curve(name, frozen):
    response = frozen[name]["response"]
    equity, kpis = _equity(response), response["kpis"]
    assert kpis["final_value"] == pytest.approx(equity.iloc[-1], rel=TOL)
    assert kpis["total_return"] == pytest.approx(equity.iloc[-1] / START - 1, rel=TOL)
    assert kpis["cagr"] == pytest.approx(metrics.cagr(equity), rel=TOL)
    depth, peak, trough = metrics.max_drawdown(equity)
    assert kpis["max_drawdown"] == pytest.approx(depth, rel=TOL)
    assert kpis["max_drawdown_peak"] == str(peak.date())
    assert kpis["max_drawdown_trough"] == str(trough.date())


@pytest.mark.parametrize("name", sorted(SCENARIOS))
def test_drawdown_curve_is_the_curve_below_its_peak(name, frozen):
    response = frozen[name]["response"]
    equity = _equity(response)
    reported = pd.Series(response["series"]["drawdown_strategy"], index=equity.index)
    assert (reported - metrics.drawdown(equity)).abs().max() < TOL
    assert (reported <= 0).all()


@pytest.mark.parametrize("name", sorted(SCENARIOS))
def test_calendar_years_compound_to_the_total_return(name, frozen):
    response = frozen[name]["response"]
    growth = math.prod(1 + row["strategy"] for row in response["yearly"])
    assert growth - 1 == pytest.approx(response["kpis"]["total_return"], rel=TOL)


@pytest.mark.parametrize("name", sorted(SCENARIOS))
def test_money_in_cash_and_holdings_are_shares(name, frozen):
    series = frozen[name]["response"]["series"]
    last = len(series["dates"]) - 1
    for field in ("idle_share", "holdings_count"):
        for i, value in enumerate(series[field]):
            # The newest week is never traded, so it has no weights row (BL-001 F5). Every other
            # week has one: a week that holds only waiting cash is 100% idle (F1 fix).
            assert value is not None or i == last, (field, series["dates"][i])
    assert all(0 <= x <= 1 + TOL for x in series["idle_share"] if x is not None)
    assert all(n >= 0 for n in series["holdings_count"] if n is not None)
    kpis = frozen[name]["response"]["kpis"]
    assert 0 <= kpis["time_in_cash"] <= 1 and 0 <= kpis["win_rate"] <= 1


@pytest.mark.parametrize("name", sorted(SCENARIOS))
def test_no_position_exceeds_the_cap_plus_its_band(name, frozen):
    request, response = frozen[name]["request"], frozen[name]["response"]
    cap = request.get("max_position")
    if not cap:
        pytest.skip("no position cap in this scenario")
    # The engine trims a holding only on a buy week (engine.py, the cap step is inside
    # `if is_buy_week`), and only for the buffer rule: with a slower cadence or monthly
    # rebalancing a holding can sit above cap + band until the next trade week, and the slots
    # rule has no cap. BL-001 Log, finding F2: a documented limit, not a bug.
    if (
        request.get("portfolio") != "buffer"
        or request.get("rebalance") != "weekly"
        or (request.get("rebalance_every") or 1) != 1
        or request.get("sell_every_week")
    ):
        pytest.skip("the cap is only enforced on buy weeks of the buffer rule")
    limit = cap + (request.get("cap_band") or 0.0)
    assert response["kpis"]["max_position_share"] <= limit + TOL
    final = response["kpis"]["final_value"]
    for position in response["open_positions"]:
        assert position["value"] / final <= limit + TOL, position["asset"]


@pytest.mark.parametrize("name", sorted(SCENARIOS))
def test_trades_are_consistent_with_themselves(name, frozen):
    response = frozen[name]["response"]
    for trade in response["trades"]:
        assert trade["weeks_held"] >= 0, trade
        assert trade["exit_week"] >= trade["entry_week"], trade
        # pnl and position_return are the same gain, in rupees and in percent
        assert (trade["pnl"] > 0) == (trade["position_return"] > 0) or abs(trade["pnl"]) < 1e-6, (
            trade
        )
        assert trade["position_return"] >= -1 - TOL, trade
    returns = [t["position_return"] for t in response["trades"]]
    if returns:
        kpis = response["kpis"]
        assert kpis["worst_trade"] <= kpis["best_trade"]
        assert min(returns) >= kpis["worst_trade"] - TOL
        assert max(returns) <= kpis["best_trade"] + TOL
