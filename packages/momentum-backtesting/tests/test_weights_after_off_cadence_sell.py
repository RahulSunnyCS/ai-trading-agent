"""BL-001 finding F1: the weights of a week that sold on an off-cadence week (`sell_every_week`,
or a stop paid out to cash) left the proceeds out of the denominator.

`engine.py` built `weights[week]` from `sum(value(a) for a in lots)`. The cash waiting for the
next buy week (`uninvested`) is added to equity but not to that total, so the holdings that remain
are shown as a bigger share of the portfolio than they are and the idle share is too small. The
money is right (equity includes it); the shares, `max_position_share`, `idle_share`,
`holdings_count`-based averages and the Rotation rows are not. The owner's live strategy sets
neither switch, so no live signal is affected.

Fixed in the same change as this file (BL-001 F1): `uninvested` is now part of the total and of
the idle share.
"""

import pandas as pd
import pytest

from momentum_backtesting.engine import BENCHMARK, CASH, IDLE, Config, run_backtest

WEEKS = pd.date_range("2016-01-01", periods=30, freq="W-FRI")


def case():
    """Two held names; at a non-buy week one of them drops out. Flat, zero-cost prices."""
    names = ["A", "B", "C", "D"]
    flip = WEEKS[5]
    prices = pd.DataFrame({n: 100.0 for n in names}, index=WEEKS)
    prices[CASH] = 100.0
    prices[BENCHMARK] = 100.0
    ranks = pd.DataFrame({"A": 1.0, "B": 2.0, "C": 3.0, "D": 4.0}, index=WEEKS)
    ranks.loc[flip:, names] = [4.0, 1.0, 2.0, 3.0]  # A falls past exit_rank, B stays on top
    includes = {n: "core" for n in names} | {CASH: "defensive", BENCHMARK: "defensive"}
    config = Config(
        start="2016-01-01",
        top_n=2,
        exit_rank=3,
        cost_pct=0.0,
        max_position=None,
        rebalance_every=2,
        rebalance_offset=0,
        sell_every_week=True,
    )
    return run_backtest(prices, includes, config, external_ranks=(ranks, ranks)), flip


def test_the_sale_happens_and_equity_keeps_the_money():
    result, flip = case()
    sells = result.trades[result.trades["action"] == "SELL"]
    assert sells["week"].iloc[0] == flip and sells["asset"].iloc[0] == "A"
    assert result.equity[flip] == pytest.approx(result.equity.iloc[0])  # nothing lost


def test_the_week_after_an_off_cadence_sale_shows_the_proceeds_as_idle():
    result, flip = case()
    row = result.weights.loc[flip]
    assert row["B"] == pytest.approx(0.5)
    assert row[IDLE] == pytest.approx(0.5)
    assert row.sum() == pytest.approx(1.0)
