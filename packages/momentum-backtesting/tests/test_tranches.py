"""Overlapping tranches (TODO 3.9.23 Step 0c)."""

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting import metrics
from momentum_backtesting.engine import BENCHMARK, CASH, Config, run_backtest
from momentum_backtesting.tranches import (
    blend,
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
