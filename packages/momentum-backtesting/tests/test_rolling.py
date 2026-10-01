"""Rolling-window lever evaluation and the deflated Sharpe ratio (TODO 3.9.23 Step 0d)."""

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting.engine import BENCHMARK, CASH, Config, run_backtest
from momentum_backtesting.sweep import (
    compare_rolling,
    deflated_sharpe,
    rerun_windows,
    rolling_windows,
    sliced_windows,
    weekly_excess,
)

WEEKS = pd.date_range("2016-01-01", periods=420, freq="W-FRI")


def test_rolling_windows_are_three_years_and_step_quarterly():
    windows = rolling_windows(WEEKS, years=3, step_weeks=13)
    assert windows[0][0] == WEEKS[0]
    assert all((end - start).days >= 3 * 365 - 7 for start, end in windows)
    assert all(end <= WEEKS[-1] for _, end in windows)
    assert (windows[1][0] - windows[0][0]).days == 13 * 7
    # the last window must still be a full one
    assert (WEEKS[-1] - windows[-1][0]).days >= 3 * 365 - 7


def test_sliced_windows_rebase_each_window():
    equity = pd.Series(1.01 ** np.arange(len(WEEKS)), index=WEEKS)
    cash = pd.Series(1.001 ** np.arange(len(WEEKS)), index=WEEKS)
    frame = sliced_windows(equity, cash, rolling_windows(WEEKS))
    # a constant 1%/week path has the same CAGR in every window and never draws down
    assert frame["CAGR"].std() < 1e-9
    assert (frame["max drawdown"] == 0).all()


def test_compare_rolling_counts_wins_against_the_baseline():
    idx = pd.date_range("2017-01-06", periods=4, freq="13W-FRI")
    base = pd.DataFrame({"CAGR": [0.1] * 4, "Sharpe": [1.0] * 4, "max drawdown": [-0.2] * 4}, idx)
    better = base.assign(CAGR=[0.12, 0.12, 0.12, 0.08], Sharpe=[1.1, 1.1, 1.1, 0.9])
    table = compare_rolling({"base": base, "lever": better}, "base")
    assert table.loc["lever", "CAGR win share"] == 0.75
    assert table.loc["lever", "Sharpe win share"] == 0.75
    assert table.loc["lever", "MaxDD win share"] == 0
    assert table.loc["lever", "worst dCAGR"] == pytest.approx(-0.02)
    assert bool(table.loc["lever", "wins most"]) is True
    assert bool(table.loc["base", "wins most"]) is False


def test_rerun_windows_starts_a_fresh_backtest_per_window():
    rng = np.random.default_rng(3)
    names = [f"A{i}" for i in range(8)]
    prices = pd.DataFrame(
        {n: 100 * np.cumprod(1 + rng.normal(0.002, 0.03, len(WEEKS))) for n in names}, WEEKS
    )
    prices[CASH] = 100 * np.cumprod(np.full(len(WEEKS), 1.0012))
    prices[BENCHMARK] = 100 * np.cumprod(1 + rng.normal(0.0015, 0.02, len(WEEKS)))
    includes = {n: "core" for n in names} | {CASH: "defensive", BENCHMARK: "core"}
    windows = rolling_windows(WEEKS[60:], step_weeks=52)
    starts = []

    def run_window(start, end):
        starts.append(start)
        config = Config(start=str(start.date()), end=str(end.date()), top_n=2, exit_rank=4)
        return run_backtest(prices, includes, config, rank_cache=cache)

    cache = {}
    frame = rerun_windows(run_window, windows)
    assert starts == [s for s, _ in windows]
    assert len(frame) == len(windows)


def test_deflated_sharpe_penalises_many_trials():
    rng = np.random.default_rng(5)
    returns = pd.Series(rng.normal(0.004, 0.02, 500))
    trials = list(rng.normal(0.1, 0.05, 50))
    alone = deflated_sharpe(returns, [0.2], n_trials=1)
    many = deflated_sharpe(returns, trials)
    assert alone.expected_max_sharpe == 0
    assert many.expected_max_sharpe > 0
    assert many.probability < alone.probability
    assert 0 <= many.probability <= 1 and many.n_trials == 50 and many.n_obs == 500


def test_deflated_sharpe_of_noise_is_not_significant():
    rng = np.random.default_rng(9)
    noise = pd.Series(rng.normal(0.0, 0.02, 500))
    trials = list(rng.normal(0.0, 0.04, 30))
    assert deflated_sharpe(noise, trials).probability < 0.5


def test_weekly_excess_is_strategy_minus_cash():
    class R:
        equity = pd.Series([1.0, 1.1, 1.21])
        cash = pd.Series([1.0, 1.01, 1.0201])

    assert list(weekly_excess(R()).dropna()) == pytest.approx([0.09, 0.09])
