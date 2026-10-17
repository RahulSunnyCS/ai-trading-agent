"""BL-116 Phase 2: `run_backtest(buy_weights=...)` shares a buy week's money by given weights."""

import numpy as np
import pandas as pd
import pytest
from test_inverse_vol import WEEKS, config, first_buys, setup

from momentum_backtesting.engine import run_backtest


def test_no_weights_change_nothing() -> None:
    prices, includes, external = setup()
    plain = run_backtest(prices, includes, config(), external_ranks=external)
    ones = pd.DataFrame(1.0, index=WEEKS, columns=["A", "B", "C"])
    flat = run_backtest(prices, includes, config(), external_ranks=external, buy_weights=ones)
    pd.testing.assert_series_equal(plain.equity, flat.equity)


def test_a_double_weight_gets_twice_the_money() -> None:
    prices, includes, external = setup()
    weights = pd.DataFrame(1.0, index=WEEKS, columns=["A", "B", "C"])
    weights["A"] = 2.0
    result = run_backtest(prices, includes, config(), external_ranks=external, buy_weights=weights)
    buys = first_buys(result)
    assert buys["A"] / (buys["A"] + buys["B"]) == pytest.approx(2 / 3, rel=1e-9)


def test_the_weights_follow_the_signal_delay() -> None:
    prices, includes, external = setup()
    weights = pd.DataFrame(1.0, index=WEEKS, columns=["A", "B", "C"])
    result = run_backtest(
        prices, includes, config(signal_delay=1), external_ranks=external, buy_weights=weights
    )
    week = result.trades[result.trades["action"] == "BUY"]["week"].min()
    weights.loc[week, "A"] = 5.0  # set ON the fill week: one week too late to count
    late = run_backtest(
        prices, includes, config(signal_delay=1), external_ranks=external, buy_weights=weights
    )
    assert first_buys(late)["A"] == pytest.approx(first_buys(result)["A"])
    i = WEEKS.get_loc(week)
    weights.loc[WEEKS[i - 1], "A"] = 5.0  # the signal week: counts
    on_time = run_backtest(
        prices, includes, config(signal_delay=1), external_ranks=external, buy_weights=weights
    )
    buys = first_buys(on_time)
    assert buys["A"] / (buys["A"] + buys["B"]) == pytest.approx(5 / 6, rel=1e-9)


def test_cannot_combine_with_inverse_vol() -> None:
    prices, includes, external = setup()
    ones = pd.DataFrame(1.0, index=WEEKS, columns=["A", "B", "C"])
    with pytest.raises(ValueError):
        run_backtest(
            prices,
            includes,
            config(weight_by="inverse_vol"),
            external_ranks=external,
            buy_weights=ones,
        )
    assert np.isfinite(ones.to_numpy()).all()
