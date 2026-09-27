"""Engine rules on small synthetic price series, one rule per test."""

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting import metrics
from momentum_backtesting.engine import BENCHMARK, CASH, GILT, Config, compute_ranks, run_backtest

WEEKS = pd.date_range("2020-01-03", periods=30, freq="W-FRI")


def path(*weekly_returns_by_segment: tuple[int, float]) -> pd.Series:
    """Price path from (number of weeks, weekly return) segments, starting at 100."""
    rets = [r for n, r in weekly_returns_by_segment for _ in range(n)]
    prices = 100 * np.cumprod([1.0, *(1 + r for r in rets)])
    return pd.Series(prices[: len(WEEKS)], index=WEEKS[: len(prices)])


def frame(**series: pd.Series) -> pd.DataFrame:
    data = pd.DataFrame(series).reindex(WEEKS)
    data.columns = [c.replace("_", " ") for c in data.columns]
    if CASH not in data:
        data[CASH] = path((29, 0.001))
    if BENCHMARK not in data:
        data[BENCHMARK] = path((29, 0.002))
    return data


def includes(prices: pd.DataFrame) -> dict[str, str]:
    special = {CASH: "defensive", GILT: "defensive"}
    return {name: special.get(name, "core") for name in prices}


def cfg(**overrides) -> Config:
    base = dict(
        lookbacks=(1, 2),
        top_n=1,
        exit_rank=2,
        cost_pct=0.0,
        start="2020-01-01",
        portfolio="slots",
    )
    return Config(**{**base, **overrides})


def test_best_recent_performer_ranks_first():
    prices = frame(A=path((29, 0.03)), B=path((29, 0.01)), C=path((29, -0.01)))
    ranks, _ = compute_ranks(prices[["A", "B", "C"]], cfg())
    assert ranks.iloc[-1].to_dict() == {"A": 1.0, "B": 2.0, "C": 3.0}


def test_instrument_joins_ranking_only_once_it_has_the_longest_lookback():
    late = path((29, 0.05)).where(WEEKS[10] <= WEEKS)
    prices = frame(A=path((29, 0.01)), Late=late)
    ranks, _ = compute_ranks(prices[["A", "Late"]], cfg(lookbacks=(1, 4)))
    assert ranks["Late"].first_valid_index() == WEEKS[14]  # 10 weeks late + 4-week lookback


def test_holding_is_kept_inside_the_exit_rank_and_sold_outside_it():
    # A leads early, then slips to 2nd (kept: exit_rank 2), then to 3rd (sold).
    prices = frame(
        A=path((8, 0.05), (21, 0.0)),
        B=path((8, 0.0), (21, 0.02)),
        C=path((14, 0.0), (15, 0.04)),
    )
    result = run_backtest(prices, includes(prices), cfg())
    held = result.holdings["slot 1"]
    assert held.iloc[2] == "A"
    a_rank_2 = result.ranks["A"].eq(2) & held.eq("A")
    assert a_rank_2.any(), "A should still be held while ranked 2nd"
    sells = result.trades.query("action == 'SELL' and asset == 'A'")
    assert (result.ranks.loc[sells["week"], "A"] > 2).all()


def test_filter_mode_moves_to_cash_when_everything_falls():
    prices = frame(
        A=path((10, 0.02), (19, -0.03)),
        B=path((10, 0.01), (19, -0.02)),
        Nifty_50=path((10, 0.005), (19, -0.01)),
    )
    result = run_backtest(prices, includes(prices), cfg(defensive="filter", filter_lookback=2))
    assert result.holdings["slot 1"].iloc[3] == "A"
    assert result.holdings["slot 1"].iloc[-1] == f"({CASH})"
    # Off mode stays invested through the same fall.
    off = run_backtest(prices, includes(prices), cfg())
    assert off.holdings["slot 1"].iloc[-1] != f"({CASH})"


def test_ranked_mode_can_choose_cash_as_a_holding():
    prices = frame(A=path((29, -0.02)), B=path((29, -0.03)), Nifty_50=path((29, -0.01)))
    result = run_backtest(prices, includes(prices), cfg(defensive="ranked"))
    assert CASH in result.ranked_names
    assert result.holdings["slot 1"].iloc[-1] == CASH


def test_costs_are_charged_once_on_entry_and_not_while_holding():
    prices = frame(A=pd.Series(100.0, index=WEEKS))
    prices[BENCHMARK] = 100.0
    result = run_backtest(prices, includes(prices), cfg(cost_pct=0.5))
    assert result.equity.iloc[-1] == pytest.approx(1 - 0.005)
    assert len(result.trades) == 1


def test_decisions_never_use_future_prices():
    prices = frame(A=path((29, 0.02)), B=path((29, 0.01)), C=path((29, 0.0)))
    base = run_backtest(prices, includes(prices), cfg())
    changed = prices.copy()
    changed.loc[WEEKS[15] :, "C"] *= 10  # a huge move that only happens later
    later = run_backtest(changed, includes(changed), cfg())
    pd.testing.assert_frame_equal(base.holdings.iloc[:15], later.holdings.iloc[:15])


def test_equity_matches_holding_returns():
    prices = frame(A=path((29, 0.01)))
    result = run_backtest(prices, includes(prices), cfg())
    first = result.equity.index[0]
    expected = prices["A"] / prices.at[first, "A"]
    pd.testing.assert_series_equal(
        result.equity, expected.loc[first:].rename("strategy"), check_freq=False
    )


def test_summary_and_yearly_tables_are_consistent():
    prices = frame(A=path((29, 0.01)), B=path((29, 0.005)))
    result = run_backtest(prices, includes(prices), cfg())
    stats = metrics.summary(result)
    assert stats["total return"] == pytest.approx(result.equity.iloc[-1] - 1)
    assert stats["max drawdown"] == pytest.approx(0.0)
    assert metrics.yearly(result)["strategy"].add(1).prod() - 1 == pytest.approx(
        stats["total return"]
    )


def test_config_rejects_an_exit_rank_inside_the_buy_zone():
    with pytest.raises(ValueError, match="exit_rank"):
        Config(top_n=5, exit_rank=3)


def test_signal_delay_acts_one_week_later():
    prices = frame(A=path((6, 0.03), (23, -0.02)), B=path((6, 0.0), (23, 0.02)))
    now = run_backtest(prices, includes(prices), cfg())
    late = run_backtest(prices, includes(prices), cfg(signal_delay=1))
    first_b_now = now.holdings["slot 1"].eq("B").idxmax()
    first_b_late = late.holdings["slot 1"].eq("B").idxmax()
    assert first_b_late == first_b_now + pd.Timedelta(weeks=1)


# --- tax -------------------------------------------------------------------------------------
from momentum_backtesting.tax import TaxLedger, TaxRules  # noqa: E402

RULES = TaxRules(slab_rate=0.30, cess=0.0)


def test_equity_short_term_gain_taxed_at_20_percent_and_long_term_at_12_5():
    ledger = TaxLedger(RULES)
    assert ledger.sale("equity", 100.0, 60) == pytest.approx(20.0)
    assert ledger.sale("equity", 100.0, 400) == pytest.approx(12.5)
    assert ledger.long_term_sales == 1


def test_other_assets_use_the_slab_rate_when_short_term_and_debt_is_never_long_term():
    ledger = TaxLedger(RULES)
    assert ledger.sale("gold_silver", 100.0, 60) == pytest.approx(30.0)
    assert ledger.sale("gold_silver", 100.0, 400) == pytest.approx(12.5)
    assert ledger.sale("debt", 100.0, 900) == pytest.approx(30.0)  # slab even after 2+ years


def test_cess_is_added_on_top_of_the_tax():
    ledger = TaxLedger(TaxRules(cess=0.04))
    assert ledger.sale("equity", 100.0, 10) == pytest.approx(20.8)


def test_losses_are_carried_forward_and_offset_later_gains():
    ledger = TaxLedger(RULES)
    assert ledger.sale("equity", -60.0, 30) == 0.0
    assert ledger.sale("equity", 100.0, 30) == pytest.approx(8.0)  # only 40 taxed at 20%
    assert ledger.short_loss == 0.0


def test_a_long_term_loss_cannot_offset_a_short_term_gain():
    ledger = TaxLedger(RULES)
    ledger.sale("equity", -100.0, 400)
    assert ledger.sale("equity", 100.0, 30) == pytest.approx(20.0)
    assert ledger.sale("equity", 100.0, 400) == pytest.approx(0.0)  # now the LT loss applies


def test_tax_lowers_final_equity_and_reports_what_was_paid():
    prices = frame(A=path((6, 0.05), (23, -0.03)), B=path((6, 0.0), (23, 0.03)))
    pre = run_backtest(prices, includes(prices), cfg())
    classes = {name: "equity" for name in prices}
    post = run_backtest(prices, includes(prices), cfg(tax=RULES), classes)
    assert post.equity.iloc[-1] < pre.equity.iloc[-1]
    assert post.tax_ledger.paid > 0
    assert post.trades["tax"].sum() <= post.tax_ledger.paid + 1e-12  # rest is tax at liquidation


def test_no_tax_on_a_series_of_losses():
    prices = frame(A=path((29, -0.02)), Nifty_50=path((29, -0.01)))
    classes = {name: "equity" for name in prices}
    result = run_backtest(prices, includes(prices), cfg(tax=RULES), classes)
    assert result.tax_ledger.paid == 0.0


def test_tax_requires_instrument_classes():
    prices = frame(A=path((29, 0.01)))
    with pytest.raises(ValueError, match="tax_classes"):
        run_backtest(prices, includes(prices), cfg(tax=RULES))


# --- sweep / walk-forward --------------------------------------------------------------------
def test_grid_only_contains_valid_combinations():
    from momentum_backtesting import sweep

    configs = sweep.grid(Config())
    assert all(c.exit_rank >= c.top_n for c in configs)
    assert len({(c.defensive, c.lookbacks, c.top_n, c.exit_rank) for c in configs}) == len(configs)


def test_end_date_limits_the_window_and_matches_a_full_run_up_to_that_week():
    prices = frame(A=path((29, 0.01)), B=path((29, 0.005)))
    full = run_backtest(prices, includes(prices), cfg())
    cut = run_backtest(prices, includes(prices), cfg(end=str(WEEKS[15].date())))
    assert cut.equity.index[-1] == WEEKS[15]
    pd.testing.assert_series_equal(full.equity.loc[: WEEKS[15]], cut.equity)


def test_rank_cache_gives_identical_results():
    prices = frame(A=path((29, 0.02)), B=path((29, 0.01)), C=path((29, 0.0)))
    cache: dict = {}
    first = run_backtest(prices, includes(prices), cfg(), rank_cache=cache)
    second = run_backtest(prices, includes(prices), cfg(top_n=2, exit_rank=3), rank_cache=cache)
    assert len(cache) == 1  # same lookbacks and universe: ranking computed once
    pd.testing.assert_series_equal(
        first.equity, run_backtest(prices, includes(prices), cfg()).equity
    )
    assert second.config.top_n == 2


def test_rank_correlation_is_one_for_identical_orderings_and_minus_one_for_reversed():
    fit = pd.Series([0.1, 0.5, 0.3, 0.9])
    assert fit.rank().corr((fit * 2 + 1).rank()) == pytest.approx(1.0)
    assert fit.rank().corr((-fit).rank()) == pytest.approx(-1.0)


def test_ranked_cash_dropping_out_is_relabelled_without_cost():
    # Falling market: cash ranks first and is bought. Then A and B rally past it, cash drops
    # out, and A is bought. Exactly three cost hits: the first buy, then leaving the liquid
    # fund and buying A. Relabelling cash as parked must not add a fourth.
    c = 0.01
    prices = frame(
        A=path((10, -0.02), (19, 0.03)),
        B=path((10, -0.03), (19, 0.02)),
        Nifty_50=path((10, -0.01), (19, 0.0)),
    )
    result = run_backtest(prices, includes(prices), cfg(defensive="ranked", cost_pct=c * 100))
    trades = result.trades
    assert list(zip(trades["action"], trades["asset"], strict=True)) == [
        ("BUY", CASH),
        ("SELL", CASH),
        ("BUY", "A"),
    ]
    first, switch, end = result.equity.index[0], trades["week"].iloc[1], result.equity.index[-1]
    expected = (
        (1 - c) ** 3
        * prices.at[switch, CASH]
        / prices.at[first, CASH]
        * prices.at[end, "A"]
        / prices.at[switch, "A"]
    )
    assert result.equity.iloc[-1] == pytest.approx(expected)


# --- buffer rule (the default): hold top N .. exit rank, reinvest sales across the top N ------
def bcfg(**overrides) -> Config:
    """Buffer rule without the position cap, so the tests above isolate the rule itself."""
    return cfg(**{"portfolio": "buffer", "max_position": None, **overrides})


def trades_in(result, week):
    return result.trades[result.trades["week"] == week]


def test_buffer_splits_sale_money_equally_across_the_current_top_n():
    # A and B lead and are bought. Later A slides to 3rd (sold, exit rank 2) while C rises:
    # the proceeds are split between B (topped up) and C (bought), half each.
    prices = frame(
        A=path((8, 0.03), (21, -0.02)),
        B=path((29, 0.02)),
        C=path((8, 0.0), (21, 0.04)),
        Nifty_50=path((29, -0.01)),
    )
    result = run_backtest(prices, includes(prices), bcfg(top_n=2, exit_rank=2))
    sale = result.trades.query("action == 'SELL' and asset == 'A'").iloc[0]
    after = trades_in(result, sale["week"]).query("action in ['BUY', 'ADD']")
    assert set(after["asset"]) == {"B", "C"}
    assert dict(zip(after["asset"], after["action"], strict=True)) == {"B": "ADD", "C": "BUY"}
    assert after["value"].iloc[0] == pytest.approx(after["value"].iloc[1])
    assert after["value"].sum() == pytest.approx(sale["value"])  # cost 0: all money reinvested


def test_buffer_keeps_holdings_until_the_exit_rank_so_the_count_floats():
    # A and B lead and are bought, then both stall while C and D surge. A slips to 4th (kept,
    # exit rank 4) and B to 5th (sold) once C and D are the top 2 - B's money goes to them,
    # so three names are held.
    prices = frame(
        A=path((8, 0.04), (21, 0.0)),
        B=path((8, 0.05), (21, 0.0)),
        C=path((8, 0.0), (21, 0.04)),
        D=path((8, 0.0), (21, 0.03)),
        E=path((29, 0.005)),
        Nifty_50=path((29, -0.01)),
    )
    result = run_backtest(prices, includes(prices), bcfg(top_n=2, exit_rank=4))
    counts = result.holdings["count"]
    assert counts.max() > 2  # more than top N held at times...
    assert counts.max() <= 4  # ...but never more than the exit rank
    for week, row in result.weights.iterrows():
        for asset, share in row.items():
            if share > 0 and asset in result.ranks:
                assert result.ranks.at[week, asset] <= 4


def test_wait_mode_leaves_a_new_leader_unbought_until_something_is_sold():
    # A leads, then B overtakes it but A only slips to 2nd - inside the exit rank, so kept.
    prices = frame(
        A=path((6, 0.03), (23, 0.01)),
        B=path((6, 0.0), (23, 0.03)),
        Nifty_50=path((29, -0.01)),
    )
    wait = run_backtest(prices, includes(prices), bcfg(top_n=1, exit_rank=2, entry="wait"))
    assert set(wait.trades["asset"]) == {"A"}
    assert wait.weights["A"].iloc[-1] == pytest.approx(1.0)

    room = run_backtest(prices, includes(prices), bcfg(top_n=1, exit_rank=2, entry="make_room"))
    assert "B" in set(room.trades.query("action == 'BUY'")["asset"])
    trims = room.trades.query("action == 'TRIM'")
    assert list(trims["asset"]) == ["A"]
    # B bought as an equal share: A trimmed by half, so the two are level on the day.
    week = trims["week"].iloc[0]
    assert room.weights.at[week, "A"] == pytest.approx(room.weights.at[week, "B"])


def test_make_room_holds_every_top_n_name_every_week():
    prices = frame(
        A=path((8, 0.04), (21, 0.0)),
        B=path((12, 0.02), (17, 0.01)),
        C=path((8, 0.0), (21, 0.03)),
        Nifty_50=path((29, -0.01)),
    )
    result = run_backtest(prices, includes(prices), bcfg(top_n=2, exit_rank=3, entry="make_room"))
    for week, row in result.weights.iterrows():
        top = result.ranks.loc[week][result.ranks.loc[week] <= 2].index
        assert all(row.get(name, 0) > 0 for name in top)


def test_top_ups_are_separate_purchases_for_tax():
    prices = frame(
        A=path((8, 0.03), (21, -0.02)),
        B=path((29, 0.02)),
        C=path((8, 0.0), (21, 0.04)),
        Nifty_50=path((29, -0.01)),
    )
    result = run_backtest(prices, includes(prices), bcfg(top_n=2, exit_rank=2))
    open_b = result.open_positions.set_index("asset").loc["B"]
    assert open_b["lots"] == 2  # the first buy and the top-up
    assert open_b["entry_week"] == result.trades.query("asset == 'B'")["week"].min()


def test_buffer_filter_parks_money_then_puts_it_back_to_work():
    prices = frame(
        A=path((12, -0.02), (17, 0.03)),
        B=path((12, -0.03), (17, 0.02)),
        Nifty_50=path((12, -0.01), (17, 0.01)),
    )
    result = run_backtest(prices, includes(prices), bcfg(defensive="filter", filter_lookback=2))
    actions = list(result.trades["action"])
    assert "PARK" in actions and "UNPARK" in actions
    assert actions.index("UNPARK") > actions.index("PARK")
    assert result.weights["Idle cash"].max() == pytest.approx(1.0)
    assert result.weights.iloc[-1].get("Idle cash", 0) == pytest.approx(0.0)


def test_buffer_with_flat_prices_and_no_costs_neither_makes_nor_loses_money():
    flat = pd.Series(100.0, index=WEEKS)
    prices = frame(A=flat, B=flat, C=flat, Nifty_50=flat, **{"Cash_(liquid_fund)": flat})
    result = run_backtest(prices, includes(prices), bcfg(top_n=2, exit_rank=3, entry="make_room"))
    assert result.equity.round(12).eq(1.0).all()
    assert result.weights.sum(axis=1).round(12).eq(1.0).all()


def test_the_default_config_is_the_buffer_rule_waiting_for_sales_capped_at_35_percent():
    assert (Config().portfolio, Config().entry, Config().max_position) == ("buffer", "wait", 0.35)


# --- position cap ------------------------------------------------------------------------------
def runaway_winner():
    # A rockets and would otherwise take over the portfolio; the rest drift.
    return frame(
        A=path((29, 0.06)),
        B=path((29, 0.01)),
        C=path((29, 0.008)),
        D=path((29, 0.006)),
        E=path((29, 0.004)),
        Nifty_50=path((29, 0.0)),
    )


def test_no_holding_passes_the_cap_plus_band_after_each_weeks_trades():
    prices = runaway_winner()
    capped = run_backtest(prices, includes(prices), bcfg(top_n=3, exit_rank=5, max_position=0.35))
    positions = capped.weights.drop(columns=["Idle cash"], errors="ignore")
    assert positions.max().max() <= 0.35 + 0.05 + 1e-9
    trims = capped.trades.query("action == 'TRIM'")
    assert len(trims) and set(trims["asset"]) == {"A"}
    assert trims["reason"].str.contains("35% cap").all()
    # Without the cap, A takes over.
    free = run_backtest(prices, includes(prices), bcfg(top_n=3, exit_rank=5, max_position=None))
    assert free.weights["A"].max() > 0.5


def test_a_trim_is_back_to_the_cap_and_the_money_goes_to_the_other_top_n():
    prices = runaway_winner()
    result = run_backtest(prices, includes(prices), bcfg(top_n=3, exit_rank=5, max_position=0.35))
    week = result.trades.query("action == 'TRIM'")["week"].iloc[0]
    assert result.weights.at[week, "A"] == pytest.approx(0.35, abs=1e-6)
    adds = trades_in(result, week).query("action in ['ADD', 'BUY']")
    assert len(adds) and "A" not in set(adds["asset"])


def test_money_that_cannot_fit_under_the_cap_waits_in_cash_without_weekly_churn():
    # Only two ETFs can be held and each is capped at 35%, so 30% has nowhere to go.
    prices = frame(A=path((29, 0.01)), B=path((29, 0.008)), Nifty_50=path((29, -0.01)))
    result = run_backtest(prices, includes(prices), bcfg(top_n=2, exit_rank=2, max_position=0.35))
    assert result.weights["Idle cash"].iloc[0] == pytest.approx(0.30, abs=1e-6)
    assert result.weights[["A", "B"]].max().max() <= 0.40 + 1e-9
    # Parked cash isn't shuffled in and out every week for tiny amounts.
    assert (result.trades["action"] == "UNPARK").sum() <= 3


def test_a_cap_of_100_percent_is_the_same_as_no_cap():
    prices = runaway_winner()
    a = run_backtest(prices, includes(prices), bcfg(top_n=3, exit_rank=5, max_position=1.0))
    b = run_backtest(prices, includes(prices), bcfg(top_n=3, exit_rank=5, max_position=None))
    pd.testing.assert_series_equal(a.equity, b.equity)


def test_invalid_caps_are_rejected():
    with pytest.raises(ValueError, match="max_position"):
        Config(max_position=0)
    with pytest.raises(ValueError, match="max_position"):
        Config(max_position=1.5)
