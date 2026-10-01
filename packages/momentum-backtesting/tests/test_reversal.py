"""Reversal / turnaround sleeve (TODO 3.9.23 Step 2)."""

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting.engine import BENCHMARK, CASH, Config, run_backtest
from momentum_backtesting.reversal import FAR, ReversalParams, blend_curves, reversal_signals

WEEKS = pd.date_range("2016-01-01", periods=140, freq="W-FRI")


def segments(*parts: tuple[int, float]) -> np.ndarray:
    rets = [r for n, r in parts for _ in range(n)]
    return 100 * np.cumprod([1.0, *(1 + r for r in rets)])[: len(WEEKS)]


def universe() -> pd.DataFrame:
    return pd.DataFrame(
        {
            # crashes ~65% over a year, then recovers steadily: the turnaround we want
            "Turn": segments((60, 0.0), (52, -0.02), (28, 0.03)),
            # steady winner: never beaten down
            "Winner": segments((140, 0.01)),
            # crashes and keeps falling: beaten down but never turns
            "Faller": segments((60, 0.0), (80, -0.015)),
            "Flat1": segments((140, 0.001)),
            "Flat2": segments((140, 0.002)),
        },
        index=WEEKS,
    )


def test_only_a_beaten_down_name_that_turned_is_ranked():
    sig = reversal_signals(universe())
    last = sig.ranks.iloc[-1]
    assert last["Turn"] == 1.0
    assert (last[["Winner", "Faller"]] >= FAR).all()  # tradeable, never bought, sold if held
    assert sig.no_buy.iloc[-1][["Winner", "Faller"]].all()


def test_a_name_making_a_new_52_week_low_is_ineligible():
    sig = reversal_signals(universe())
    assert not sig.eligible["Faller"].any()


def test_entry_needs_26w_still_negative_and_price_above_its_10w_average():
    sig = reversal_signals(universe())
    turn = sig.no_buy["Turn"]
    first_ranked = sig.eligible["Turn"].idxmax()
    # early in the recovery the 26-week return is still negative: buyable
    assert not turn.loc[first_ranked]
    # by the end it has recovered past its 26-week-ago level: no fresh buy, but still ranked
    assert turn.iloc[-1] and sig.ranks["Turn"].iloc[-1] == 1.0


def test_a_sparse_sleeve_still_runs_every_week():
    sig = reversal_signals(universe())
    tradeable = universe().notna()
    assert (sig.ranks.notna() == tradeable).all().all()


def test_membership_removes_a_name_entirely():
    prices = universe()
    membership = pd.DataFrame(True, index=WEEKS, columns=prices.columns)
    membership["Turn"] = False
    sig = reversal_signals(prices, membership=membership)
    assert sig.ranks["Turn"].isna().all()  # not a member: not even tradeable


def test_volume_confirmation_can_veto_entry():
    prices = universe()
    heavy_down = pd.DataFrame(1.0, index=WEEKS, columns=prices.columns)
    heavy_down[prices.pct_change() < 0] = 100.0
    with_volume = reversal_signals(prices, volume=heavy_down)
    without = reversal_signals(prices)
    assert with_volume.no_buy["Turn"].sum() >= without.no_buy["Turn"].sum()


def test_the_engine_buys_and_holds_the_turnaround():
    prices = universe()
    prices[CASH] = 100 * 1.001 ** np.arange(len(WEEKS))
    prices[BENCHMARK] = prices[CASH]
    sig = reversal_signals(prices[universe().columns])
    names = list(universe().columns)
    includes = {n: "core" for n in names} | {CASH: "defensive", BENCHMARK: "defensive"}
    config = Config(start="2017-01-06", top_n=1, exit_rank=2, cost_pct=0.0, lookbacks=(13,))
    result = run_backtest(
        prices, includes, config, external_ranks=sig.external_ranks, no_buy=sig.no_buy
    )
    bought = set(result.trades.loc[result.trades["action"] == "BUY", "asset"])
    assert bought == {"Turn"}
    assert result.equity.iloc[-1] > 1.2


def test_params_are_respected():
    strict = reversal_signals(universe(), params=ReversalParams(drawdown=0.9, bottom_quantile=0.0))
    assert strict.gate.sum().sum() <= reversal_signals(universe()).gate.sum().sum()


def test_blend_curves():
    idx = WEEKS[:3]
    m = pd.Series([1.0, 1.1, 1.21], index=idx)
    r = pd.Series([1.0, 0.9, 0.9], index=idx)
    held = blend_curves(m, r, 0.2)
    assert held.iloc[-1] == pytest.approx(0.8 * 1.21 + 0.2 * 0.9)
    mixed = blend_curves(m, r, 0.2, rebalance=True)
    assert mixed.iloc[1] == pytest.approx(0.8 * 1.1 + 0.2 * 0.9)
    assert mixed.iloc[2] == pytest.approx(mixed.iloc[1] * (1 + 0.8 * 0.1 + 0.2 * 0.0))


def test_rank_on_momentum_is_an_option_and_bad_values_fail():
    plain = reversal_signals(universe(), params=ReversalParams(rank_on="momentum"))
    assert plain.ranks["Turn"].iloc[-1] == 1.0
    with pytest.raises(ValueError):
        reversal_signals(universe(), params=ReversalParams(rank_on="nope"))
