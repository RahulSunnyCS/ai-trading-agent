"""BL-084: the weekly stop-loss in the buffer rule (`Config.stop_from_buy` / `stop_from_peak`).

A fixed rank table keeps A the top name throughout, so A is only ever sold by the stop; prices
are built so the week each stop must fire on is known in advance."""

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting.engine import BENCHMARK, CASH, GILT, Config, run_backtest

WEEKS = pd.date_range("2020-01-03", periods=30, freq="W-FRI")


def path(*segments: tuple[int, float]) -> pd.Series:
    rets = [r for n, r in segments for _ in range(n)]
    values = 100 * np.cumprod([1.0, *(1 + r for r in rets)])
    return pd.Series(values[: len(WEEKS)], index=WEEKS[: len(values)])


def setup() -> tuple[pd.DataFrame, dict[str, str], tuple[pd.DataFrame, pd.DataFrame]]:
    prices = pd.DataFrame(
        {
            # up 10% a week for 6 weeks (peak at week 6), then down 8% a week
            "A": path((6, 0.10), (23, -0.08)),
            "B": path((29, 0.01)),
            "C": path((29, 0.005)),
        }
    ).reindex(WEEKS)
    prices[CASH] = path((29, 0.001))
    prices[BENCHMARK] = path((29, 0.002))
    special = {CASH: "defensive", GILT: "defensive"}
    includes = {name: special.get(name, "core") for name in prices}
    ranks = pd.DataFrame({"A": 1.0, "B": 2.0, "C": 3.0}, index=WEEKS)
    return prices, includes, (ranks, -ranks)


def config(**stop) -> Config:
    return Config(
        top_n=1,
        exit_rank=3,
        cost_pct=0.0,
        start="2020-01-01",
        universe=("A", "B", "C"),
        max_position=None,
        min_ranked=1,
        **stop,
    )


def run(cfg: Config, **kw):
    prices, includes, external = setup()
    return run_backtest(prices, includes, cfg, external_ranks=external, **kw)


def stop_sells(result, asset: str = "A") -> pd.DataFrame:
    t = result.trades
    return t[(t["action"] == "SELL") & (t["asset"] == asset) & t["reason"].str.startswith("stop")]


def first_fall_week(level: float, *, from_peak: bool) -> pd.Timestamp:
    a = setup()[0]["A"]
    ref = a.cummax() if from_peak else a.iloc[0]
    return a.index[(1 - a / ref >= level).to_numpy()][0]


def test_off_by_default_changes_nothing() -> None:
    plain = run(config())
    explicit = run(config(stop_from_buy=None, stop_from_peak=None, stop_proceeds="top"))
    pd.testing.assert_series_equal(plain.equity, explicit.equity)
    assert stop_sells(plain).empty


def test_peak_stop_sells_on_the_week_the_fall_is_seen() -> None:
    result = run(config(stop_from_peak=0.30))
    sells = stop_sells(result)
    assert list(sells["week"])[:1] == [first_fall_week(0.30, from_peak=True)]
    assert "below the peak" in sells["reason"].iloc[0]


def test_buy_price_stop_measures_from_the_average_buy_price() -> None:
    result = run(config(stop_from_buy=0.20))
    assert list(stop_sells(result)["week"])[:1] == [first_fall_week(0.20, from_peak=False)]


def test_delay_one_sells_a_week_later_at_that_weeks_close() -> None:
    now = stop_sells(run(config(stop_from_peak=0.30)))["week"].iloc[0]
    later = stop_sells(run(config(stop_from_peak=0.30, stop_delay=1)))
    assert later["week"].iloc[0] == WEEKS[WEEKS.get_loc(now) + 1]
    prices = setup()[0]
    assert later["fill_price"].iloc[0] == pytest.approx(prices.at[later["week"].iloc[0], "A"])


def test_the_stop_uses_no_later_prices() -> None:
    full = stop_sells(run(config(stop_from_peak=0.30)))["week"].iloc[0]
    cut = run(config(stop_from_peak=0.30, end=str(WEEKS[WEEKS.get_loc(full) + 1].date())))
    assert stop_sells(cut)["week"].iloc[0] == full


def test_a_lower_circuit_lock_delays_the_stop() -> None:
    week = stop_sells(run(config(stop_from_peak=0.30)))["week"].iloc[0]
    locked = pd.DataFrame(False, index=WEEKS, columns=["A"])
    locked.loc[week, "A"] = True
    sells = stop_sells(run(config(stop_from_peak=0.30), lc_locked=locked))
    assert sells["week"].iloc[0] == WEEKS[WEEKS.get_loc(week) + 1]


def test_cash_waits_for_the_next_rebalance_and_top_buys_at_once() -> None:
    from momentum_backtesting.engine import cadence_weeks

    week = stop_sells(run(config(stop_from_peak=0.30)))["week"].iloc[0]
    # a cadence on which the stop week is NOT a rebalance week
    offset = next(o for o in range(4) if week not in cadence_weeks(list(WEEKS), 4, o))
    every = dict(stop_from_peak=0.30, rebalance_every=4, rebalance_offset=offset)
    cash = run(config(**every, stop_proceeds="cash"))
    top = run(config(**every, stop_proceeds="top"))
    assert stop_sells(cash)["week"].iloc[0] == week == stop_sells(top)["week"].iloc[0]
    c, t = cash.trades, top.trades
    assert not ((c["week"] == week) & c["action"].isin(["BUY", "ADD"])).any()
    bought = t[(t["week"] == week) & (t["action"] == "BUY")]
    assert list(bought["asset"]) == ["B"]
    assert bought["reason"].iloc[0].endswith("(after a stop)")
    nxt = WEEKS[WEEKS.get_loc(week) + 1]
    assert top.equity[nxt] != pytest.approx(cash.equity[nxt])


def test_a_stopped_name_is_not_bought_back_the_same_week() -> None:
    result = run(config(stop_from_peak=0.30))
    week = stop_sells(result)["week"].iloc[0]
    t = result.trades
    rebought = (t["week"] == week) & (t["asset"] == "A") & t["action"].isin(["BUY", "ADD"])
    assert not rebought.any()


@pytest.mark.parametrize(
    "bad",
    [
        dict(stop_from_buy=0.0),
        dict(stop_from_peak=1.0),
        dict(stop_from_peak=0.3, stop_proceeds="bonds"),
        dict(stop_from_peak=0.3, stop_delay=2),
        dict(stop_from_peak=0.3, portfolio="slots"),
    ],
)
def test_bad_settings_are_refused(bad) -> None:
    with pytest.raises(ValueError):
        config(**bad)
