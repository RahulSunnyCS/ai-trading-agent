"""BL-054 L6: residual momentum (categories/residual.py).

The regression has an intercept (as in Blitz, Huij and Martens 2011), so a constant
outperformance is absorbed by it: the score measures how much better a stock did over the
recent 26 weeks than over its 52-week average. The test paths therefore add their drift only
in the last 30 weeks."""

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting.categories.residual import residual_ranks, residual_scores
from momentum_backtesting.engine import Config, compute_ranks

WEEKS = pd.date_range("2018-01-05", periods=120, freq="W-FRI")


def setup():
    rng = np.random.default_rng(11)
    n = len(WEEKS)
    mkt = rng.normal(0.003, 0.02, n)
    noise = lambda s: rng.normal(0, s, n)  # noqa: E731
    late = np.where(np.arange(n) >= n - 30, 1.0, 0.0)
    returns = pd.DataFrame(
        {
            "BETA": 1.3 * mkt + noise(0.004),  # market exposure only
            "ALPHA": 1.0 * mkt + 0.01 * late + noise(0.004),  # recent outperformance
            "LOSER": 1.0 * mkt - 0.01 * late + noise(0.004),
            "NOISE": 0.8 * mkt + noise(0.004),
        },
        index=WEEKS,
    )
    prices = 100 * (1 + returns).cumprod()
    market = pd.Series(100 * np.cumprod(1 + mkt), index=WEEKS)
    return prices, market


def test_ranks_follow_the_residual_not_the_market_beta() -> None:
    prices, market = setup()
    ranks, scores = residual_ranks(prices, market, {})
    last = ranks.iloc[-1]
    assert last["ALPHA"] == 1 and last["LOSER"] == 4


def test_short_history_has_no_score() -> None:
    prices, market = setup()
    scores = residual_scores(prices, market, {})
    assert scores.iloc[:52].isna().all().all()
    assert scores.iloc[-1].notna().sum() >= 3


def test_no_look_ahead() -> None:
    prices, market = setup()
    full = residual_scores(prices, market, {})
    cut = WEEKS[90]
    short = residual_scores(prices.loc[:cut], market.loc[:cut], {})
    pd.testing.assert_frame_equal(short, full.loc[:cut])


def test_a_group_factor_absorbs_a_shared_sector_move() -> None:
    prices, market = setup()
    rng = np.random.default_rng(3)
    n = len(WEEKS)
    late = np.where(np.arange(n) >= n - 30, 0.01, 0.0)
    sector = late + rng.normal(0, 0.01, n)
    mkt = market.pct_change().fillna(0).to_numpy()
    legs = {f"S{i}": mkt + sector + rng.normal(0, 0.004, n) for i in range(1, 5)}
    both = prices.assign(**{k: 100 * np.cumprod(1 + v) for k, v in legs.items()})
    groups = dict.fromkeys(legs, "x")
    with_group = residual_scores(both, market, groups)["S1"].iloc[-5:].mean()
    without = residual_scores(both, market, {})["S1"].iloc[-5:].mean()
    assert without > 1
    assert abs(with_group) < without


def test_the_engine_refuses_residual_without_factors() -> None:
    prices, _ = setup()
    with pytest.raises(ValueError, match="residual"):
        compute_ranks(prices, Config(score="residual", universe=tuple(prices.columns)))
