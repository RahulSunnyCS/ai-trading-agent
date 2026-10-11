"""BL-085 L5: inverse-volatility sizing of a buy week's money (`Config.weight_by`)."""

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting.engine import BENCHMARK, CASH, GILT, Config, run_backtest

WEEKS = pd.date_range("2019-01-04", periods=60, freq="W-FRI")


def setup():
    rng = np.random.default_rng(7)
    n = len(WEEKS)
    calm = 100 * np.cumprod(1 + 0.004 + rng.normal(0, 0.01, n))
    wild = 100 * np.cumprod(1 + 0.004 + rng.normal(0, 0.02, n))
    prices = pd.DataFrame({"A": calm, "B": wild, "C": 100 * 1.001 ** np.arange(n)}, index=WEEKS)
    prices[CASH] = 100 * 1.0002 ** np.arange(n)
    prices[BENCHMARK] = 100 * 1.001 ** np.arange(n)
    special = {CASH: "defensive", GILT: "defensive"}
    includes = {name: special.get(name, "core") for name in prices}
    ranks = pd.DataFrame({"A": 1.0, "B": 2.0, "C": 3.0}, index=WEEKS)
    return prices, includes, (ranks, -ranks)


def config(**kw) -> Config:
    base = dict(
        top_n=2,
        exit_rank=3,
        cost_pct=0.0,
        start="2019-08-01",
        universe=("A", "B", "C"),
        max_position=None,
        min_ranked=1,
    )
    return Config(**{**base, **kw})


def first_buys(result) -> pd.Series:
    t = result.trades
    first = t[t["action"] == "BUY"]["week"].min()
    return t[(t["week"] == first) & (t["action"] == "BUY")].set_index("asset")["value"]


def test_equal_is_the_default_and_unchanged() -> None:
    prices, includes, external = setup()
    plain = run_backtest(prices, includes, config(), external_ranks=external)
    explicit = run_backtest(prices, includes, config(weight_by="equal"), external_ranks=external)
    pd.testing.assert_series_equal(plain.equity, explicit.equity)
    buys = first_buys(plain)
    assert buys["A"] == pytest.approx(buys["B"])


def test_the_calmer_name_gets_more_money() -> None:
    prices, includes, external = setup()
    result = run_backtest(
        prices, includes, config(weight_by="inverse_vol"), external_ranks=external
    )
    buys = first_buys(result)
    week = result.trades[result.trades["action"] == "BUY"]["week"].min()
    std = prices[["A", "B"]].pct_change().rolling(26).std().loc[week]
    expected_a = (1 / std["A"]) / (1 / std["A"] + 1 / std["B"])
    assert buys["A"] / (buys["A"] + buys["B"]) == pytest.approx(expected_a, rel=1e-9)
    assert buys["A"] > buys["B"]


def test_the_cap_still_binds() -> None:
    prices, includes, external = setup()
    result = run_backtest(
        prices,
        includes,
        config(weight_by="inverse_vol", max_position=0.55, cap_band=1.0),
        external_ranks=external,
    )
    buys = first_buys(result)
    assert buys["A"] / (buys["A"] + buys["B"]) <= 0.55 + 1e-9


def test_a_name_without_history_gets_the_median_weight() -> None:
    prices, includes, external = setup()
    prices.loc[: WEEKS[40], "B"] = np.nan  # B has no 26-week history at the first buy
    prices["B"] = prices["B"].bfill()
    result = run_backtest(
        prices, includes, config(weight_by="inverse_vol"), external_ranks=external
    )
    buys = first_buys(result)
    assert buys["A"] == pytest.approx(buys["B"])  # one known weight: the median is itself


def test_bad_settings_are_refused() -> None:
    with pytest.raises(ValueError):
        config(weight_by="random")
    with pytest.raises(ValueError):
        config(weight_by="inverse_vol", portfolio="slots")
    with pytest.raises(ValueError):
        config(vol_window=2)
