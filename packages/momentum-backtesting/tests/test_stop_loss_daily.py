"""BL-054 L4: the daily stop (`Config.stop_granularity="daily"`).

A fixed rank table keeps A the top name throughout, so A is only sold by the stop. A's daily path
is built by hand so the day a stop must trigger and the morning it must fill on are known."""

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting.categories.daily_moves import DailyMoves
from momentum_backtesting.engine import BENCHMARK, CASH, GILT, Config, run_backtest

WEEKS = pd.date_range("2020-01-03", periods=30, freq="W-FRI")
DAYS = pd.bdate_range("2019-12-30", WEEKS[-1])


def day(week: int, weekday: int) -> pd.Timestamp:
    """The date `weekday` (0 = Monday .. 4 = Friday) of the week ending WEEKS[week]."""
    return WEEKS[week] - pd.Timedelta(days=4 - weekday)


def daily_close(a_levels: dict[pd.Timestamp, float]) -> pd.DataFrame:
    """A holds each level from its date on (100 before the first); B and C creep upward."""
    a = pd.Series(100.0, index=DAYS)
    for when, level in sorted(a_levels.items()):
        a[a.index >= when] = level
    steps = np.arange(len(DAYS))
    return pd.DataFrame({"A": a, "B": 100 * 1.001**steps, "C": 100 * 1.0005**steps}, index=DAYS)


def build(a_levels, gaps=None, locked=None, cut=None):
    closes = daily_close(a_levels)
    move = closes.pct_change().fillna(0.0)
    gap = pd.DataFrame(0.0, index=DAYS, columns=closes.columns)
    for (when, name), value in (gaps or {}).items():
        gap.at[when, name] = value
    lock = pd.DataFrame(False, index=DAYS, columns=closes.columns)
    for when in locked or []:
        lock.at[when, "A"] = True
    if cut is not None:
        move, gap, lock = move.loc[:cut], gap.loc[:cut], lock.loc[:cut]
    prices = closes.reindex(WEEKS)
    prices[CASH] = 100 * 1.0002 ** np.arange(len(WEEKS))
    prices[BENCHMARK] = 100 * 1.001 ** np.arange(len(WEEKS))
    special = {CASH: "defensive", GILT: "defensive"}
    includes = {name: special.get(name, "core") for name in prices}
    ranks = pd.DataFrame({"A": 1.0, "B": 2.0, "C": 3.0}, index=WEEKS)
    return prices, includes, (ranks, -ranks), DailyMoves(move, gap, lock)


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


def run(cfg, levels, **kw):
    prices, includes, external, daily = build(levels, **kw)
    return run_backtest(prices, includes, cfg, external_ranks=external, daily=daily)


def daily_sells(result) -> pd.DataFrame:
    t = result.trades
    return t[(t["action"] == "SELL") & t["reason"].astype(str).str.startswith("daily stop")]


def test_a_stop_that_never_fires_changes_nothing() -> None:
    levels = {day(10, 2): 90.0}  # a 10% dip
    plain = run(config(), levels)
    with_stop = run(config(stop_from_buy=0.25, stop_granularity="daily"), levels)
    pd.testing.assert_series_equal(plain.equity, with_stop.equity)
    assert daily_sells(with_stop).empty


def test_a_fall_sells_at_the_next_mornings_open() -> None:
    levels = {day(4, 2): 70.0}  # Wednesday of week 4: a 30% fall at the close
    gaps = {(day(4, 3), "A"): -0.02}  # Thursday opens 2% lower
    sells = daily_sells(
        run(config(stop_from_buy=0.25, stop_granularity="daily"), levels, gaps=gaps)
    )
    assert len(sells) == 1
    row = sells.iloc[0]
    assert row["fill_price"] == pytest.approx(70.0 * 0.98)
    assert "buy price" in row["reason"] and str(day(4, 3).date()) in row["reason"]


def test_a_friday_trigger_sells_on_monday() -> None:
    levels = {WEEKS[4]: 70.0}  # the close of Friday of week 4
    gaps = {(day(5, 0), "A"): -0.03}
    sells = daily_sells(
        run(config(stop_from_buy=0.25, stop_granularity="daily"), levels, gaps=gaps)
    )
    assert len(sells) == 1
    assert sells.iloc[0]["fill_price"] == pytest.approx(70.0 * 0.97)
    assert str(day(5, 0).date()) in sells.iloc[0]["reason"]


def test_the_peak_is_the_highest_daily_close() -> None:
    # up to 130, then 27% down from that peak (still above the 100 buy price)
    levels = {day(3, 1): 130.0, day(6, 2): 94.0}
    cfg = config(stop_from_peak=0.25, stop_granularity="daily")
    sells = daily_sells(run(cfg, levels))
    assert len(sells) == 1 and "peak" in sells.iloc[0]["reason"]
    assert (
        run(config(stop_from_buy=0.25, stop_granularity="daily"), levels)
        .trades.query("action == 'SELL'")
        .empty
    )


def test_a_locked_morning_delays_the_sale_one_day() -> None:
    levels = {day(4, 2): 70.0}
    gaps = {(day(4, 3), "A"): -0.05, (day(4, 4), "A"): -0.01}
    locked = [day(4, 3)]
    cfg = config(stop_from_buy=0.25, stop_granularity="daily")
    row = daily_sells(run(cfg, levels, gaps=gaps, locked=locked)).iloc[0]
    assert str(day(4, 4).date()) in row["reason"]
    assert row["fill_price"] == pytest.approx(70.0 * 0.99)


def test_the_stop_uses_no_later_data() -> None:
    levels = {day(8, 1): 60.0}
    cfg = config(stop_from_buy=0.25, stop_granularity="daily")
    full = run(cfg, levels)
    cut = WEEKS[12]
    prices, includes, external, daily = build(levels, cut=cut)
    short_cfg = config(stop_from_buy=0.25, stop_granularity="daily", end=str(cut.date()))
    short = run_backtest(prices, includes, short_cfg, external_ranks=external, daily=daily)
    before = short.equity.index[:-1]
    pd.testing.assert_series_equal(short.equity.loc[before], full.equity.loc[before])
    assert list(daily_sells(short)["fill_price"]) == list(
        daily_sells(full).query("week < @cut")["fill_price"]
    )


def test_the_cash_waits_in_the_equity_curve_the_week_it_is_sold() -> None:
    levels = {day(4, 2): 70.0}
    stop = run(config(stop_from_buy=0.25, stop_granularity="daily"), levels)
    plain = run(config(), levels)
    # the stop avoids Thursday and Friday of that week: its curve is higher at the Friday close
    assert stop.equity[WEEKS[4]] > plain.equity[WEEKS[4]] * 0.999


@pytest.mark.parametrize(
    "bad",
    [
        dict(stop_granularity="daily"),  # no stop level
        dict(stop_from_buy=0.2, stop_granularity="daily", stop_delay=1),
        dict(stop_from_buy=0.2, stop_granularity="hourly"),
    ],
)
def test_bad_settings_are_refused(bad) -> None:
    with pytest.raises(ValueError):
        config(**bad)


def test_daily_needs_the_daily_moves() -> None:
    prices, includes, external, _ = build({})
    cfg = config(stop_from_buy=0.2, stop_granularity="daily")
    with pytest.raises(ValueError, match="daily moves"):
        run_backtest(prices, includes, cfg, external_ranks=external)
