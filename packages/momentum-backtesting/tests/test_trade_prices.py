"""Signal prices vs fill prices: ranking on the index, P&L on what you'd actually trade."""

import numpy as np
import pandas as pd
import pytest
from test_engine import WEEKS, cfg, frame, includes, path

from momentum_backtesting.engine import CASH, Config, compute_ranks, run_backtest
from momentum_backtesting.fetch import Instrument
from momentum_backtesting.sources import split_factors
from momentum_backtesting.tracking import premium_on_trades
from momentum_backtesting.trade_prices import build_trade_prices, fills, splice_proxy


def rotating_prices() -> pd.DataFrame:
    """Leadership changes a few times, so the strategy trades."""
    return frame(
        A=path((8, 0.04), (21, -0.01)),
        B=path((8, 0.0), (10, 0.03), (11, -0.01)),
        C=path((18, 0.0), (11, 0.03)),
    )


def test_passing_the_signal_prices_as_trade_prices_changes_nothing():
    prices = rotating_prices()
    plain = run_backtest(prices, includes(prices), cfg())
    same = run_backtest(prices, includes(prices), cfg(), trade_prices=prices.copy())
    pd.testing.assert_series_equal(plain.equity, same.equity)
    pd.testing.assert_frame_equal(plain.trades, same.trades)


def test_ranks_never_depend_on_trade_prices():
    prices = rotating_prices()
    rng = np.random.default_rng(1)
    noisy = prices * rng.uniform(0.8, 1.2, prices.shape)
    base = run_backtest(prices, includes(prices), cfg())
    moved = run_backtest(prices, includes(prices), cfg(track="etf"), trade_prices=noisy)
    pd.testing.assert_frame_equal(base.ranks, moved.ranks)
    assert list(base.trades["asset"]) == list(moved.trades["asset"])
    assert list(base.trades["week"]) == list(moved.trades["week"])


def test_a_constant_premium_costs_nothing():
    prices = rotating_prices()
    etf = prices * 1.05
    base = run_backtest(prices, includes(prices), cfg())
    at_premium = run_backtest(prices, includes(prices), cfg(track="etf"), trade_prices=etf)
    np.testing.assert_allclose(base.equity.to_numpy(), at_premium.equity.to_numpy())


def test_buying_at_a_premium_that_then_vanishes_loses_the_premium():
    # A leads throughout and is held from the first week. Its ETF trades 5% above the index
    # while it's bought, and at NAV by the end.
    prices = frame(A=path((29, 0.03)), B=path((29, 0.0)))
    etf = prices.copy()
    etf["A"] = prices["A"] * np.where(np.arange(len(WEEKS)) < 5, 1.05, 1.0)
    base = run_backtest(prices, includes(prices), cfg())
    real = run_backtest(prices, includes(prices), cfg(track="etf"), trade_prices=etf)
    assert real.equity.iloc[-1] / base.equity.iloc[-1] == pytest.approx(1 / 1.05, rel=1e-9)


def test_etf_or_monday_fills_without_trade_prices_are_refused():
    prices = rotating_prices()
    with pytest.raises(ValueError, match="needs trade prices"):
        run_backtest(prices, includes(prices), cfg(track="etf"))
    with pytest.raises(ValueError, match="needs trade prices"):
        run_backtest(prices, includes(prices), cfg(execution="mon_open"))


def test_signal_weeks_without_a_fill_yet_are_left_out():
    prices = rotating_prices()
    fills_table = prices.copy()
    fills_table.iloc[-1] = np.nan  # Monday after the last Friday hasn't happened
    result = run_backtest(
        prices, includes(prices), cfg(execution="mon_open"), None, None, fills_table
    )
    assert result.equity.index[-1] == WEEKS[-2]


def test_label_only_changes_when_fills_differ():
    assert "etf" not in Config().label
    assert Config(track="etf", execution="mon_open").label.endswith("_etf-mon_open")
    with pytest.raises(ValueError):
        Config(track="nav")


# --- building the fill table -------------------------------------------------------------------


def test_proxy_joins_the_etf_without_a_jump_and_grows_slower_by_the_expense_ratio():
    days = pd.bdate_range("2020-01-01", "2022-12-30")
    index = pd.DataFrame({"close": 100.0 * 1.0003 ** np.arange(len(days))}, index=days)
    listed = pd.Timestamp("2022-01-03")
    etf = (index[index.index >= listed] / 10).copy()
    spliced, first = splice_proxy(etf, index, ter_pct=1.0)
    assert first == listed
    before = spliced.index[spliced.index < listed][-1]
    ratio = spliced["close"] / index["close"]
    assert ratio[before] == pytest.approx(ratio[listed], rel=1e-4)  # no jump at the join
    one_year_back = spliced.index[spliced.index <= listed - pd.Timedelta(days=365)][-1]
    years = (listed - one_year_back).days / 365.25
    assert ratio[one_year_back] / ratio[listed] == pytest.approx(1 / 0.99**years, rel=1e-9)


def test_monday_fills_use_the_next_weekday_open_and_the_10am_price_when_known():
    days = pd.to_datetime(["2024-01-05", "2024-01-06", "2024-01-08", "2024-01-12", "2024-01-15"])
    daily = pd.DataFrame(
        {"open": [1.0, 2.0, 3.0, 4.0, 5.0], "close": [1.5, 2.5, 3.5, 4.5, 5.5]}, index=days
    )
    weeks = pd.DatetimeIndex(["2024-01-05", "2024-01-12", "2024-01-19"])
    friday, _ = fills(daily, weeks, "fri_close")
    assert list(friday[:2]) == [1.5, 4.5]  # each week's last close, as weekly() does
    monday, _ = fills(daily, weeks, "mon_open")
    assert list(monday[:2]) == [3.0, 5.0]  # Saturday skipped: first weekday after Friday
    assert pd.isna(monday.iloc[2])  # no Monday yet
    at_ten = pd.Series({pd.Timestamp("2024-01-08"): 3.2})
    ten, fallbacks = fills(daily, weeks, "mon_10am", at_ten)
    assert list(ten[:2]) == [3.2, 5.0] and fallbacks == 1


def test_series_without_an_open_fill_at_that_days_close():
    days = pd.to_datetime(["2024-01-05", "2024-01-08"])
    nav = pd.DataFrame({"close": [10.0, 10.1]}, index=days)
    monday, fallbacks = fills(nav, pd.DatetimeIndex(["2024-01-05"]), "mon_open")
    assert monday.iloc[0] == 10.1 and fallbacks == 0


def _inst(name, etf="SAME", ter=None):
    return Instrument("core", "Sector", name, name + "ETF", "equity", "NSE:X", "", "", etf, "", ter)


def test_build_marks_proxy_weeks_and_prices_listed_weeks_on_the_etf(tmp_path):
    days = pd.bdate_range("2023-01-02", "2023-06-30")
    idx = pd.DataFrame({"open": 100.0, "close": 100.0 + np.arange(len(days))}, index=days)
    etf = (idx[idx.index >= "2023-04-03"] * 0.5).copy()
    etf.loc["2023-05-01":, "close"] *= 1.02  # trades at a premium later
    cash = pd.DataFrame({"close": 1.0 + 0.0001 * np.arange(len(days))}, index=days)
    for folder, name, data in [
        ("daily", "Alpha", idx),
        ("daily_etf", "Alpha", etf),
        ("daily", CASH, cash),
    ]:
        (tmp_path / folder).mkdir(exist_ok=True)
        data.to_csv(tmp_path / folder / f"{name}.csv", index_label="date")
    signal = pd.DataFrame(
        {
            "Alpha": idx["close"].resample("W-FRI").last(),
            CASH: cash["close"].resample("W-FRI").last(),
        }
    )
    universe = [_inst("Alpha", "NSE:ALPHA-EQ"), _inst(CASH)]
    assert build_trade_prices(signal, "index", "fri_close", universe, tmp_path) is None
    table = build_trade_prices(signal, "etf", "fri_close", universe, tmp_path)
    assert table.proxy["Alpha"].sum() == (signal.index < pd.Timestamp("2023-04-03")).sum()
    assert not table.proxy[CASH].any()
    late = signal.index[-1]
    assert table.prices.at[late, "Alpha"] == pytest.approx(etf["close"].iloc[-1])
    assert table.notes.at["Alpha", "priced on"] == "AlphaETF"


def test_build_explains_when_daily_files_are_missing(tmp_path):
    signal = pd.DataFrame({"Alpha": [1.0]}, index=pd.DatetimeIndex(["2024-01-05"]))
    with pytest.raises(ValueError, match="mbt fetch"):
        build_trade_prices(signal, "etf", "fri_close", [_inst("Alpha")], tmp_path)


def test_a_unit_split_is_undone_against_the_index():
    days = pd.bdate_range("2024-01-01", periods=6)
    index = pd.Series([100, 101, 102, 101, 103, 104], index=days, dtype=float)
    etf = pd.Series([50, 50.5, 5.1, 5.05, 5.15, 5.2], index=days)  # 1:10 split on day 3
    adjusted = etf * split_factors(etf, index)
    assert adjusted.iloc[:2].tolist() == pytest.approx([5.0, 5.05])
    assert adjusted.iloc[2:].tolist() == etf.iloc[2:].tolist()
    assert (split_factors(index * 0.5, index) == 1).all()


def test_premium_paid_on_buys_vs_received_on_sells():
    prices = rotating_prices()
    result = run_backtest(prices, includes(prices), cfg())
    traded = result.trades["asset"].unique()
    premiums = pd.DataFrame({a: 0.0 for a in traded}, index=WEEKS)
    for row in result.trades.itertuples():
        premiums.at[row.week, row.asset] = 0.03 if row.action in ("BUY", "ADD") else -0.01
    table = premium_on_trades(result, premiums)
    assert table["premium lost per round trip"].dropna().round(6).eq(0.04).all()
    assert compute_ranks(prices[["A", "B", "C"]], cfg())[0].notna().any().any()
