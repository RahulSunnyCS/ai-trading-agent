"""Overlapping tranches (TODO 3.9.23 Step 0c)."""

from dataclasses import replace

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting import choose, groups, metrics
from momentum_backtesting.engine import BENCHMARK, CASH, Config, run_backtest
from momentum_backtesting.tax import TaxRules
from momentum_backtesting.tranches import (
    blend,
    blend_reset,
    friday_spread,
    run_backtest_tranches,
    run_tranches,
    tranche_configs,
)

WEEKS = pd.date_range("2016-01-01", periods=200, freq="W-FRI")
NAMES = [f"Asset {i}" for i in range(10)]


def market() -> pd.DataFrame:
    rng = np.random.default_rng(11)
    data = {n: 100 * np.cumprod(1 + rng.normal(0.002, 0.035, len(WEEKS))) for n in NAMES}
    data[CASH] = 100 * np.cumprod(np.full(len(WEEKS), 1.0012))
    data[BENCHMARK] = 100 * np.cumprod(1 + rng.normal(0.0018, 0.025, len(WEEKS)))
    return pd.DataFrame(data, index=WEEKS)


INCLUDES = {n: "core" for n in NAMES} | {CASH: "defensive", BENCHMARK: "core"}
BASE = Config(start="2017-01-06", top_n=3, exit_rank=6)


def test_one_tranche_is_exactly_the_plain_backtest():
    plain = run_backtest(market(), INCLUDES, BASE)
    run = run_backtest_tranches(market(), INCLUDES, BASE, 1)
    pd.testing.assert_series_equal(run.equity, plain.equity.rename("strategy"))


def test_blend_is_the_mean_of_the_phases_and_reports_them():
    run = run_backtest_tranches(market(), INCLUDES, BASE, 4, rank_cache={})
    assert len(run.tranches) == 4
    assert [r.config.rebalance_offset for r in run.tranches] == [0, 1, 2, 3]
    expected = pd.concat([r.equity for r in run.tranches], axis=1).mean(axis=1)
    assert np.allclose(run.equity, expected)
    table = run.table()
    assert list(table.index) == ["phase 0", "phase 1", "phase 2", "phase 3", "blend"]
    assert table.loc["blend", "CAGR"] == pytest.approx(metrics.cagr(run.equity))
    luck = run.luck()
    assert luck["CAGR spread"] >= 0 and luck["max drawdown spread"] >= 0


def test_each_tranche_gets_its_share_of_capital():
    configs = tranche_configs(Config(capital=1_000_000.0), 4)
    assert {c.capital for c in configs} == {250_000.0}


def test_tranches_need_the_weekly_calendar():
    with pytest.raises(ValueError):
        tranche_configs(Config(rebalance="monthly"), 2)


def test_blend_rejects_mismatched_windows():
    a = run_backtest(market(), INCLUDES, BASE)
    b = run_backtest(market(), INCLUDES, Config(start="2018-01-05", top_n=3, exit_rank=6))
    with pytest.raises(ValueError):
        blend([a, b])


def test_run_tranches_accepts_any_runner():
    seen = []

    def runner(config):
        seen.append(config.rebalance_offset)
        return run_backtest(market(), INCLUDES, config)

    run_tranches(runner, BASE, 2)
    assert seen == [0, 1]


# --- BL-056: the April-reset blend as one Result ------------------------------------------------


def _phases(every: int = 4, **changes) -> list:
    config = replace(BASE, **changes)
    classes = dict.fromkeys([*NAMES, BENCHMARK], "equity") | {CASH: "debt"}
    return [
        run_backtest(market(), INCLUDES, c, classes, rank_cache={})
        for c in tranche_configs(config, every)
    ]


def test_blend_reset_is_the_ensemble_curve_of_the_phases():
    phases = _phases()
    blended = blend_reset(phases)
    curves = pd.concat([r.equity for r in phases], axis=1, keys=range(4))
    expected = choose.ensemble_curve(curves, list(range(4)))
    assert np.allclose(blended.equity.to_numpy(), expected.to_numpy())
    # Resets happen: the blend is not the never-rebalanced mean.
    assert not np.allclose(blended.equity, curves.mean(axis=1))
    assert blended.config.rebalance_offset == 0 and blended.config.capital == BASE.capital


def test_blend_reset_weights_are_the_whole_account():
    blended = blend_reset(_phases())
    totals = blended.weights.sum(axis=1)
    assert np.allclose(totals.to_numpy(), 1.0, atol=1e-6)


def test_blend_reset_trades_are_in_the_blends_units():
    phases = _phases()
    blended = blend_reset(phases)
    assert set(blended.trades["friday"]) == {0, 1, 2, 3}
    assert blended.trades["week"].is_monotonic_increasing
    assert len(blended.trades) == sum(len(r.trades) for r in phases)
    # Before the first April reset every tranche is a quarter of the account.
    first_reset = groups.reset_weeks(blended.equity.index)[1]
    early = blended.trades[blended.trades["week"] <= first_reset]
    raw = pd.concat([r.trades for r in phases])
    raw_early = raw[raw["week"] <= first_reset]
    assert early["value"].sum() == pytest.approx(raw_early["value"].sum() / 4)


def test_blend_reset_open_positions_add_up_to_the_last_week():
    blended = blend_reset(_phases())
    held = blended.open_positions["value"].sum() + blended.idle_value
    last = blended.weights.iloc[-1]
    invested_share = last.drop(labels=["Idle cash"], errors="ignore").sum()
    assert held == pytest.approx(blended.equity.iloc[-1] * invested_share, rel=1e-6)
    assert blended.open_positions["asset"].is_unique


def test_blend_reset_tax_adds_the_ledgers():
    phases = _phases(tax=TaxRules())
    blended = blend_reset(phases)
    assert blended.tax_ledger is not None
    assert blended.tax_ledger.sales == sum(r.tax_ledger.sales for r in phases)
    assert 0 < blended.tax_ledger.paid < sum(r.tax_ledger.paid for r in phases)


def test_friday_spread_reports_each_phase_and_the_blend():
    phases = _phases()
    spread = friday_spread(phases, blend_reset(phases))
    assert [p["offset"] for p in spread["phases"]] == [0, 1, 2, 3]
    assert spread["cagr_spread"] >= 0
    assert set(spread["blend"]) == {"cagr", "max_drawdown", "ulcer"}
