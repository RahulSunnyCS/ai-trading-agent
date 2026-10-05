"""The engine problems BL-010 Phase 2 found (E10 to E12), each pinned by a test that failed on
the code before the fix."""

from __future__ import annotations

import pandas as pd
import pytest
from test_audit_replay import HALT, small_market  # noqa: F401 - the fixture

from momentum_backtesting import engine
from momentum_backtesting.categories import broad
from momentum_backtesting.categories import circuit_exposure as cx
from momentum_backtesting.engine import CASH, Config
from momentum_backtesting.tax import TaxRules


def test_e10_a_stock_with_no_session_in_a_week_can_be_neither_bought_nor_sold(small_market):  # noqa: F811
    weeks = pd.date_range("2021-06-04", "2021-10-29", freq="W-FRI")
    names = {"BBB": "BBB", "CCC": "CCC"}
    uc, lc = cx.lock_masks(names, weeks, root=small_market)
    halted = [
        w for w in weeks if HALT[0] <= (w - pd.Timedelta(days=4)).date() and w.date() <= HALT[1]
    ]
    assert len(halted) == 3
    for mask in (uc, lc):
        assert mask.loc[halted, "BBB"].all()
        assert not mask.drop(index=halted)["BBB"].any()  # trading again: free again
        assert not mask["CCC"].any()


def test_e10_weeks_before_listing_and_after_the_last_session_are_not_a_halt(small_market):  # noqa: F811
    weeks = pd.date_range("2020-11-06", "2022-01-28", freq="W-FRI")
    uc, lc = cx.lock_masks({"CCC": "CCC"}, weeks, root=small_market)
    assert not uc["CCC"].any() and not lc["CCC"].any()


def test_e11_a_series_that_has_ended_leaves_the_pool_at_once():
    weeks = pd.date_range("2021-01-01", periods=30, freq="W-FRI")
    frame = pd.DataFrame(
        {"OLD": [100.0 + i for i in range(30)], "NEW": [50.0 + i for i in range(30)]}, index=weeks
    )
    frame.loc[weeks[12:], "OLD"] = frame.at[weeks[11], "OLD"]  # carried forward after it ended
    universe = broad.StockUniverseFrame(
        frame=frame,
        weeks=list(weeks),
        column_to_base_symbol={"OLD": "OLD", "NEW": "NEW"},
        stock_membership=pd.DataFrame(True, index=weeks, columns=frame.columns),
        events=pd.DataFrame(),
        stale_columns={"OLD": weeks[11]},
        missing_symbols=[],
    )
    full = frame.assign(**dict.fromkeys(broad.ATOMIC_NAMES, float("nan")))
    ranks = pd.DataFrame({"OLD": 1.0, "NEW": 2.0}, index=weeks).reindex(columns=full.columns)
    base = broad.UniverseBase(universe, full, None, list(weeks), ranks)
    ranking = broad.finish_universe_ranking(base, pool_top_n=2, pool_exit_rank=2)
    assert ranking.pool_membership.loc[weeks[:12], "OLD"].all()
    assert not ranking.pool_membership.loc[weeks[12:], "OLD"].any()
    assert ranking.stock_pool_ranks.loc[weeks[12:], "OLD"].isna().all()
    assert ranking.pool_membership["NEW"].all()


def test_e12_selling_everything_at_the_end_pays_one_depository_charge_per_stock():
    weeks = pd.date_range("2021-01-01", periods=12, freq="W-FRI")
    prices = pd.DataFrame(
        {"A": [100.0 * 1.02**i for i in range(12)], "B": [100.0] * 12, CASH: [100.0] * 12},
        index=weeks,
    )
    ranks = pd.DataFrame({"A": 1.0, "B": 2.0}, index=weeks)
    ranks.loc[weeks[5] :, "B"] = float("nan")  # B is sold; the money tops up A as a second lot
    config = Config(
        top_n=2,
        exit_rank=2,
        universe=("A", "B"),
        benchmark="A",
        start=str(weeks[0].date()),
        max_position=None,
        cost_model="itemised",
        capital=10_000,
        slippage_bps=0.0,
        tax=TaxRules(),
        min_ranked=1,
    )
    result = engine.run_backtest(
        prices,
        {"A": "core", "B": "core", CASH: "defensive"},
        config,
        external_ranks=(ranks, -ranks),
        tax_classes={"A": "equity", "B": "equity", CASH: "debt"},
    )
    assert int(result.open_positions.set_index("asset").at["A", "lots"]) == 2
    before_last = result.equity.iloc[-2]
    held = before_last * prices["A"].iloc[-1] / prices["A"].iloc[-2]  # all of it is A by then
    rupees = held * config.capital
    costs = rupees * (engine.STT_RATE + engine.EXCHANGE_FEES_RATE) + engine.DP_CHARGE_RS
    after_costs = (rupees - costs) / config.capital
    trades = result.trades
    bought = trades[trades.action.isin(["BUY", "ADD"])]
    basis = {a: float((g.value - g.cost).sum()) for a, g in bought.groupby("asset")}
    sold_b = trades[(trades.asset == "B") & (trades.action == "SELL")].iloc[0]
    loss_on_b = basis["B"] - (sold_b.value - sold_b.cost)  # banked, then set against A's gain
    tax = (after_costs - basis["A"] - loss_on_b) * 0.20 * 1.04  # everything held under a year
    assert result.equity.iloc[-1] == pytest.approx(after_costs - tax, rel=1e-12)
