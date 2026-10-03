"""Circuit-lock gates in the engine (`uc_locked` / `lc_locked`): a stock locked at the upper
circuit cannot be bought, one locked at the lower circuit cannot be sold."""

import numpy as np
import pandas as pd

from momentum_backtesting.engine import BENCHMARK, CASH, GILT, Config, run_backtest

WEEKS = pd.date_range("2020-01-03", periods=30, freq="W-FRI")


def path(*segments: tuple[int, float]) -> pd.Series:
    rets = [r for n, r in segments for _ in range(n)]
    values = 100 * np.cumprod([1.0, *(1 + r for r in rets)])
    return pd.Series(values[: len(WEEKS)], index=WEEKS[: len(values)])


def prices_and_includes() -> tuple[pd.DataFrame, dict[str, str]]:
    prices = pd.DataFrame(
        {
            "A": path((8, 0.05), (21, 0.0)),
            "B": path((8, 0.0), (21, 0.02)),
            "C": path((14, 0.0), (15, 0.04)),
        }
    ).reindex(WEEKS)
    prices[CASH] = path((29, 0.001))
    prices[BENCHMARK] = path((29, 0.002))
    special = {CASH: "defensive", GILT: "defensive"}
    return prices, {name: special.get(name, "core") for name in prices}


def config(portfolio: str) -> Config:
    return Config(
        lookbacks=(1, 2),
        top_n=1,
        exit_rank=2,
        cost_pct=0.0,
        start="2020-01-01",
        portfolio=portfolio,
    )


def flags(prices: pd.DataFrame, **cells: list[pd.Timestamp]) -> pd.DataFrame:
    table = pd.DataFrame(False, index=prices.index, columns=list(cells))
    for name, weeks in cells.items():
        table.loc[weeks, name] = True
    return table


def test_all_false_masks_change_nothing() -> None:
    prices, includes = prices_and_includes()
    for portfolio in ("slots", "buffer"):
        plain = run_backtest(prices, includes, config(portfolio))
        masked = run_backtest(
            prices,
            includes,
            config(portfolio),
            uc_locked=flags(prices, A=[]),
            lc_locked=flags(prices, A=[]),
        )
        pd.testing.assert_series_equal(plain.equity, masked.equity)
        assert len(plain.trades) == len(masked.trades)


def test_a_holding_locked_at_the_lower_circuit_cannot_be_sold_that_week() -> None:
    prices, includes = prices_and_includes()
    for portfolio in ("slots", "buffer"):
        base = run_backtest(prices, includes, config(portfolio))
        sells = base.trades.query("action == 'SELL' and asset == 'A'")
        assert not sells.empty, "the scenario needs A to be sold at some point"
        locked_week = sells["week"].iloc[0]

        result = run_backtest(
            prices, includes, config(portfolio), lc_locked=flags(prices, A=[locked_week])
        )
        sold = result.trades.query("action == 'SELL' and asset == 'A'")["week"]
        assert locked_week not in set(sold)
        # still held through the locked week...
        assert (
            result.holdings.loc[result.holdings.index == locked_week]
            .astype(str)
            .apply(lambda row: "A" in " ".join(row), axis=1)
            .all()
        )
        # ...and it goes as soon as the lock lifts (or it is simply never sold again)
        assert all(week > locked_week for week in sold)


def test_a_name_locked_at_the_upper_circuit_cannot_be_bought_that_week() -> None:
    prices, includes = prices_and_includes()
    for portfolio in ("slots", "buffer"):
        base = run_backtest(prices, includes, config(portfolio))
        buys = base.trades.query("action == 'BUY' and asset == 'B'")
        assert not buys.empty, "the scenario needs B to be bought at some point"
        locked_week = buys["week"].iloc[0]

        result = run_backtest(
            prices, includes, config(portfolio), uc_locked=flags(prices, B=[locked_week])
        )
        bought = result.trades.query("action in ('BUY', 'ADD') and asset == 'B'")["week"]
        assert locked_week not in set(bought)


def test_a_held_name_that_locks_up_can_still_be_sold() -> None:
    """The UC gate only blocks new buys; it never keeps you from selling something you own."""
    prices, includes = prices_and_includes()
    base = run_backtest(prices, includes, config("buffer"))
    bought = base.trades.query("action == 'BUY' and asset == 'A'")["week"].iloc[0]
    after_purchase = [week for week in prices.index if week > bought]
    result = run_backtest(
        prices, includes, config("buffer"), uc_locked=flags(prices, A=after_purchase)
    )

    def sells(r):
        return r.trades.query("action == 'SELL' and asset == 'A'")["week"].tolist()

    assert sells(result) == sells(base) != []
