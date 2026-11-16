"""BL-233: sell or halve a holding stretched above its 200-day EMA (`Config.extension_exit`).

A fixed rank table keeps A the top name throughout, so A leaves only through the extension exit;
the extension table is given by hand so the weeks it must act on are known in advance."""

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting.categories import extension
from momentum_backtesting.engine import BENCHMARK, CASH, GILT, Config, run_backtest

WEEKS = pd.date_range("2020-01-03", periods=30, freq="W-FRI")


def setup() -> tuple[pd.DataFrame, dict[str, str], tuple[pd.DataFrame, pd.DataFrame]]:
    growth = {"A": 0.03, "B": 0.01, "C": 0.005, CASH: 0.001, BENCHMARK: 0.002}
    prices = pd.DataFrame(
        {k: 100 * (1 + g) ** np.arange(len(WEEKS)) for k, g in growth.items()}, index=WEEKS
    )
    special = {CASH: "defensive", GILT: "defensive"}
    includes = {name: special.get(name, "core") for name in prices}
    ranks = pd.DataFrame({"A": 1.0, "B": 2.0, "C": 3.0}, index=WEEKS)
    return prices, includes, (ranks, -ranks)


def stretched() -> pd.DataFrame:
    """A is above 0.70 in weeks 5-8 and 15-16, below otherwise; B and C never."""
    table = pd.DataFrame(0.2, index=WEEKS, columns=["A", "B", "C"])
    table.iloc[5:9, 0] = 0.8
    table.iloc[15:17, 0] = 0.9
    return table


def config(exit_rank: int = 3, **kw) -> Config:
    return Config(
        top_n=1,
        exit_rank=exit_rank,
        cost_pct=0.0,
        start="2020-01-01",
        universe=("A", "B", "C"),
        max_position=None,
        min_ranked=1,
        **kw,
    )


def run(cfg: Config, table: pd.DataFrame | None = None):
    prices, includes, external = setup()
    return run_backtest(prices, includes, cfg, external_ranks=external, extension=table)


def acted(result, action: str) -> list[pd.Timestamp]:
    t = result.trades
    hit = t[(t["action"] == action) & (t["asset"] == "A") & t["reason"].str.startswith("extension")]
    return list(hit["week"])


def a_buys(result) -> list[pd.Timestamp]:
    t = result.trades
    return list(t[(t["action"].isin(["BUY", "ADD"])) & (t["asset"] == "A")]["week"])


def test_off_changes_nothing_even_with_a_table() -> None:
    plain = run(config())
    with_table = run(config(), stretched())
    pd.testing.assert_series_equal(plain.equity, with_table.equity)
    assert acted(with_table, "SELL") == []


def test_needs_the_table() -> None:
    with pytest.raises(ValueError, match="extension table"):
        run(config(extension_exit=0.7))


def test_sell_exits_and_does_not_buy_back_while_stretched() -> None:
    # exit_rank 1: whatever replaced A is sold again once A may be bought, so A comes back
    result = run(config(exit_rank=1, extension_exit=0.7), stretched())
    assert acted(result, "SELL") == [WEEKS[5], WEEKS[15]]
    buys = a_buys(result)
    assert WEEKS[9] in buys and WEEKS[17] in buys
    assert not any(WEEKS[5] <= w <= WEEKS[8] or WEEKS[15] <= w <= WEEKS[16] for w in buys)


def test_sell_money_goes_to_the_next_name_on_a_buy_week() -> None:
    result = run(config(extension_exit=0.7), stretched())
    t = result.trades
    assert acted(result, "SELL") == [WEEKS[5]]  # B then holds the slot; A is not bought back
    assert WEEKS[5] in list(t[(t["action"] == "BUY") & (t["asset"] == "B")]["week"])


def test_trim_halves_once_per_crossing_and_never_tops_up() -> None:
    result = run(config(extension_exit=0.7, extension_action="trim"), stretched())
    assert acted(result, "TRIM") == [WEEKS[5], WEEKS[15]]
    t = result.trades
    first = t[(t["week"] == WEEKS[5]) & (t["action"] == "TRIM") & (t["asset"] == "A")].iloc[0]
    assert first["units"] == pytest.approx(first["prev_units"] / 2)
    buys = a_buys(result)
    assert not any(WEEKS[5] <= w <= WEEKS[8] for w in buys)


def test_signal_delay_acts_a_week_later() -> None:
    result = run(config(extension_exit=0.7, signal_delay=1), stretched())
    assert acted(result, "SELL")[:1] == [WEEKS[6]]


def test_label_names_the_exit() -> None:
    assert "_ext70trim" in config(extension_exit=0.7, extension_action="trim").label


def test_extension_is_causal_and_starts_at_the_first_bar() -> None:
    days = pd.bdate_range("2020-01-01", periods=600)
    rng = np.random.default_rng(1)
    move = pd.DataFrame({"X": rng.normal(0.002, 0.02, 600), "Y": 0.0}, index=days)
    has_bar = pd.DataFrame({"X": True, "Y": days >= days[300]}, index=days)
    move.loc[~has_bar["Y"], "Y"] = 0.0
    full = extension.from_moves(move, has_bar, span=200)
    cut = extension.from_moves(move.iloc[:450], has_bar.iloc[:450], span=200)
    pd.testing.assert_frame_equal(full.iloc[:450], cut)
    assert full["X"].iloc[:199].isna().all() and full["X"].iloc[199:].notna().all()
    assert full["Y"].iloc[: 300 + 199].isna().all() and np.isfinite(full["Y"].iloc[300 + 199])


def test_weekly_reads_the_last_day_on_or_before_the_week() -> None:
    days = pd.DatetimeIndex(["2020-01-01", "2020-01-02", "2020-01-06"])
    daily = pd.DataFrame({"X": [1.0, 2.0, 3.0]}, index=days)
    weeks = pd.DatetimeIndex(["2019-12-27", "2020-01-03", "2020-01-10"])
    out = extension.weekly(daily, weeks)
    assert np.isnan(out["X"].iloc[0])
    assert list(out["X"].iloc[1:]) == [2.0, 3.0]
