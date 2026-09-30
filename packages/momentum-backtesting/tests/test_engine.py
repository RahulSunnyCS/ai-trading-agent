"""Engine rules on small synthetic price series, one rule per test."""

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting import metrics
from momentum_backtesting.engine import (
    BENCHMARK,
    CASH,
    GILT,
    IDLE,
    Config,
    _win_rate_multiplier,
    compute_ranks,
    run_backtest,
)

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


# --- group cap (max_group): several positions counting as one bet, e.g. a category's 2 stocks ---
def two_pairs():
    # A and B (group G1) both rocket; C and D (group G2) drift. Left alone, G1 takes over.
    return frame(
        A=path((29, 0.06)),
        B=path((29, 0.05)),
        C=path((29, 0.004)),
        D=path((29, 0.003)),
        Nifty_50=path((29, 0.0)),
    )


def pair_groups(prices: pd.DataFrame) -> pd.DataFrame:
    labels = {"A": "G1", "B": "G1", "C": "G2", "D": "G2"}
    return pd.DataFrame({n: g for n, g in labels.items()}, index=prices.index)


def group_share(result, members) -> pd.Series:
    return result.weights[members].sum(axis=1)


def test_a_group_is_trimmed_back_to_its_cap_once_past_the_band():
    prices = two_pairs()
    kw = dict(top_n=4, exit_rank=6, max_position=None)
    free = run_backtest(prices, includes(prices), bcfg(**kw), groups=pair_groups(prices))
    assert group_share(free, ["A", "B"]).max() > 0.6  # no group cap: G1 takes over

    capped = run_backtest(
        prices, includes(prices), bcfg(**kw, max_group=0.5), groups=pair_groups(prices)
    )
    assert group_share(capped, ["A", "B"]).max() <= 0.5 + 0.05 + 1e-9
    trims = capped.trades.query("action == 'TRIM'")
    assert len(trims) and set(trims["asset"]) == {"A", "B"}
    assert trims["reason"].str.contains("G1 above the 50% group cap").all()
    week = trims["week"].iloc[0]  # both members are cut by the same fraction, back to the cap
    assert group_share(capped, ["A", "B"]).at[week] == pytest.approx(0.5, abs=1e-6)


def test_group_room_is_shared_by_the_names_in_it_when_money_is_first_deployed():
    # Top 4 would each get 25% - 50% per pair. With a 30% group cap each pair takes 30%, and
    # the remaining 40% has nowhere to go, so it waits in cash.
    prices = two_pairs()
    result = run_backtest(
        prices,
        includes(prices),
        bcfg(top_n=4, exit_rank=6, max_group=0.3),
        groups=pair_groups(prices),
    )
    first = result.weights.iloc[0]
    assert first["A"] + first["B"] == pytest.approx(0.30, abs=1e-6)
    assert first["C"] + first["D"] == pytest.approx(0.30, abs=1e-6)
    assert first[IDLE] == pytest.approx(0.40, abs=1e-6)
    parks = result.trades.query("action == 'PARK'")
    assert parks["reason"].str.contains("position/group cap").any()


def test_a_group_cap_can_spread_money_to_a_group_with_room():
    # Only G1 is capped; the money it can't take goes to C and D instead of sitting idle.
    prices = two_pairs()
    groups = pair_groups(prices)
    groups[["C", "D"]] = "G2"
    result = run_backtest(
        prices,
        includes(prices),
        bcfg(top_n=4, exit_rank=6, max_group=0.6),
        groups=groups,
    )
    first = result.weights.iloc[0]
    assert first["A"] + first["B"] == pytest.approx(0.5, abs=1e-6)  # under 60%: not binding
    assert first.get(IDLE, 0.0) == pytest.approx(0.0, abs=1e-6)  # fully invested


def test_groups_do_nothing_unless_max_group_is_set():
    prices = two_pairs()
    kw = dict(top_n=4, exit_rank=6, max_position=0.35)
    with_groups = run_backtest(prices, includes(prices), bcfg(**kw), groups=pair_groups(prices))
    without = run_backtest(prices, includes(prices), bcfg(**kw))
    pd.testing.assert_series_equal(with_groups.equity, without.equity)


def test_a_group_cap_without_a_groups_table_is_inert():
    prices = two_pairs()
    kw = dict(top_n=4, exit_rank=6, max_position=None)
    a = run_backtest(prices, includes(prices), bcfg(**kw, max_group=0.3))
    b = run_backtest(prices, includes(prices), bcfg(**kw))
    pd.testing.assert_series_equal(a.equity, b.equity)


def test_a_group_cap_and_a_position_cap_work_together():
    prices = two_pairs()
    result = run_backtest(
        prices,
        includes(prices),
        bcfg(top_n=4, exit_rank=6, max_position=0.30, max_group=0.5),
        groups=pair_groups(prices),
    )
    positions = result.weights.drop(columns=[IDLE], errors="ignore")
    assert positions.max().max() <= 0.30 + 0.05 + 1e-9
    assert group_share(result, ["A", "B"]).max() <= 0.5 + 0.05 + 1e-9


def test_invalid_group_caps_are_rejected():
    with pytest.raises(ValueError, match="max_group"):
        Config(max_group=0)
    with pytest.raises(ValueError, match="max_group"):
        Config(max_group=1.5)


# --- momentum sizing (win-rate position-size multiplier, buffer rule only) ---------------------
# _win_rate_multiplier is tested directly on hand-built trade_rows first (no backtest needed to
# pin down the weighting/normalisation arithmetic exactly), then _run_buffer's wiring is checked
# end to end on a synthetic losing streak, then the momentum_sizing=False default is checked for
# byte-identical output against an existing buffer fixture (regression safety - _run_buffer is
# shared by every dataset).


def test_win_rate_multiplier_is_1_with_no_closed_trades_yet():
    week = pd.Timestamp("2021-01-01")
    assert _win_rate_multiplier([], week) == pytest.approx(1.0)


def test_win_rate_multiplier_excludes_a_sell_on_the_same_week_being_sized():
    weeks = pd.date_range("2021-01-01", periods=2, freq="W-FRI")
    # A loss recorded ON the sizing week itself hasn't "closed before" that week - no lookahead.
    rows = [{"action": "SELL", "week": weeks[1], "position_return": -0.5}]
    assert _win_rate_multiplier(rows, weeks[1]) == pytest.approx(1.0)
    # The same trade, sized a week later, DOES count.
    assert _win_rate_multiplier(rows, weeks[1] + pd.Timedelta(weeks=1)) == pytest.approx(0.0)


def test_win_rate_multiplier_is_1_when_the_last_10_closes_were_all_wins():
    weeks = pd.date_range("2021-01-01", periods=11, freq="W-FRI")
    rows = [{"action": "SELL", "week": weeks[i], "position_return": 0.02} for i in range(10)]
    assert _win_rate_multiplier(rows, weeks[10]) == pytest.approx(1.0)  # capped, not > 1.0


def test_win_rate_multiplier_is_0_when_the_last_10_closes_were_all_losses():
    weeks = pd.date_range("2021-01-01", periods=11, freq="W-FRI")
    rows = [{"action": "SELL", "week": weeks[i], "position_return": -0.02} for i in range(10)]
    assert _win_rate_multiplier(rows, weeks[10]) == pytest.approx(0.0)


def test_win_rate_multiplier_only_looks_at_the_most_recent_10_closes():
    # 2 old losses, then 10 wins: if the old losses leaked in, the multiplier would be < 1.0.
    weeks = pd.date_range("2021-01-01", periods=13, freq="W-FRI")
    rows = [{"action": "SELL", "week": weeks[i], "position_return": -0.5} for i in range(2)]
    rows += [{"action": "SELL", "week": weeks[i], "position_return": 0.02} for i in range(2, 12)]
    assert _win_rate_multiplier(rows, weeks[12]) == pytest.approx(1.0)


def test_win_rate_multiplier_weights_fewer_than_10_trades_starting_at_10_not_3_2_1():
    # 3 closed trades, oldest -> newest: win, loss, loss. Weights are anchored at 10 for the
    # MOST RECENT and count down - 8, 9, 10 here - never a fixed 10-n-slot scheme (which would
    # give 1, 2, 3 for these three).
    weeks = pd.date_range("2021-01-01", periods=4, freq="W-FRI")
    rows = [
        {"action": "SELL", "week": weeks[0], "position_return": 0.05},  # oldest -> weight 8, win
        {"action": "SELL", "week": weeks[1], "position_return": -0.05},  # weight 9, loss
        {"action": "SELL", "week": weeks[2], "position_return": -0.05},  # newest -> weight 10, loss
    ]
    # Hand-computed, independent of the implementation: score = 8 - 9 - 10 = -11, weights_used
    # = 8 + 9 + 10 = 27, win_rate_pct = (-11/27 + 1) / 2 * 100 = 800/27 = 29.629...%,
    # multiplier = win_rate_pct / 50 = 16/27.
    score, weights_used = 8 - 9 - 10, 8 + 9 + 10
    win_rate_pct = (score / weights_used + 1) / 2 * 100
    expected = win_rate_pct / 50
    assert expected == pytest.approx(16 / 27)
    assert _win_rate_multiplier(rows, weeks[3]) == pytest.approx(expected)


def test_win_rate_multiplier_reproduces_the_35_percent_to_0_70_worked_example():
    # 5 closed trades (fewer than 10 -> weights still anchored at 10, counting down: 10,9,8,7,6),
    # oldest -> newest: win, loss, win, loss, loss. Losses carry weight {10, 9, 7} (the newest,
    # 2nd-newest and 4th-newest), wins carry weight {8, 6}.
    weeks = pd.date_range("2021-01-01", periods=6, freq="W-FRI")
    outcomes = [True, False, True, False, False]  # oldest -> newest; True = win
    rows = [
        {"action": "SELL", "week": weeks[i], "position_return": 0.05 if win else -0.05}
        for i, win in enumerate(outcomes)
    ]
    # Hand-computed: score = -10 - 9 + 8 - 7 + 6 = -12, weights_used = 10+9+8+7+6 = 40,
    # win_rate_pct = (-12/40 + 1) / 2 * 100 = 35%, multiplier = 35 / 50 = 0.70 - the task brief's
    # own "50k -> 35k" example (a 30% cut), reproduced from first principles.
    score, weights_used = -10 - 9 + 8 - 7 + 6, 10 + 9 + 8 + 7 + 6
    win_rate_pct = (score / weights_used + 1) / 2 * 100
    assert win_rate_pct == pytest.approx(35.0)
    expected = win_rate_pct / 50
    assert expected == pytest.approx(0.70)
    assert _win_rate_multiplier(rows, weeks[5]) == pytest.approx(expected)


def test_win_rate_multiplier_window_is_configurable():
    # Same 3-trade setup as the "fewer than 10" test above, but with window=5: weights anchor at
    # 5 instead of 10 - oldest -> newest: win(weight 3), loss(weight 4), loss(weight 5).
    weeks = pd.date_range("2021-01-01", periods=4, freq="W-FRI")
    rows = [
        {"action": "SELL", "week": weeks[0], "position_return": 0.05},
        {"action": "SELL", "week": weeks[1], "position_return": -0.05},
        {"action": "SELL", "week": weeks[2], "position_return": -0.05},
    ]
    score, weights_used = 3 - 4 - 5, 3 + 4 + 5
    win_rate_pct = (score / weights_used + 1) / 2 * 100
    expected = win_rate_pct / 50
    assert _win_rate_multiplier(rows, weeks[3], window=5) == pytest.approx(expected)
    # A shorter window also changes how many closes are even looked at: with window=1, only the
    # single most-recent close (a loss) matters -> multiplier 0.0, not the 3-trade blend above.
    assert _win_rate_multiplier(rows, weeks[3], window=1) == pytest.approx(0.0)


def test_win_rate_multiplier_floor_raises_the_worst_case_multiplier():
    weeks = pd.date_range("2021-01-01", periods=11, freq="W-FRI")
    rows = [{"action": "SELL", "week": weeks[i], "position_return": -0.02} for i in range(10)]
    # All-loss streak: 0.0 with the default floor, clamped up to the floor when one is set.
    assert _win_rate_multiplier(rows, weeks[10]) == pytest.approx(0.0)
    assert _win_rate_multiplier(rows, weeks[10], floor=0.3) == pytest.approx(0.3)
    # The floor never raises a multiplier that's already above it (only clamps the low end).
    win_rows = [{"action": "SELL", "week": weeks[i], "position_return": 0.02} for i in range(10)]
    assert _win_rate_multiplier(win_rows, weeks[10], floor=0.3) == pytest.approx(1.0)


def test_config_rejects_invalid_momentum_sizing_window_or_floor():
    with pytest.raises(ValueError, match="momentum_sizing_window"):
        Config(momentum_sizing_window=0)
    with pytest.raises(ValueError, match="momentum_sizing_floor"):
        Config(momentum_sizing_floor=1.5)
    with pytest.raises(ValueError, match="momentum_sizing_floor"):
        Config(momentum_sizing_floor=-0.1)


def test_momentum_sizing_off_leaves_existing_buffer_behaviour_unchanged():
    """momentum_sizing defaults to False. Reruns an existing buffer-rule fixture (the position-cap
    test above) with the field passed explicitly False and checks the Result is byte-identical -
    regression safety for code shared by every dataset (_run_buffer backs ETF, stock and Custom
    Index alike)."""
    assert Config().momentum_sizing is False
    prices = runaway_winner()
    a = run_backtest(prices, includes(prices), bcfg(top_n=3, exit_rank=5, max_position=0.35))
    b = run_backtest(
        prices,
        includes(prices),
        bcfg(top_n=3, exit_rank=5, max_position=0.35, momentum_sizing=False),
    )
    pd.testing.assert_series_equal(a.equity, b.equity)
    pd.testing.assert_frame_equal(a.weights, b.weights)
    pd.testing.assert_frame_equal(a.trades, b.trades)


def _pulse_crash_prices(n_assets: int, weeks: pd.DatetimeIndex) -> pd.DataFrame:
    """n_assets, each flat at 100 until its own turn, then +7%/week for 2 weeks, then -15%/week
    forever after - scheduled back to back (asset i's turn is weeks [2i, 2i+1]) so leadership
    hands off from one to the next with no overlap. Under top_n=1/exit_rank=1 the engine buys
    whichever asset is currently pulsing and sells it once the NEXT asset's pulse overtakes it -
    which happens either right at, or one week into, its own crash. The crash is steep enough
    (-15%) that BOTH possible buy points (first or second pulse week) net a loss by the time
    that happens - 1.07 * 0.85 - 1 = -9.05% even from the earlier, more generous entry - so this
    doesn't rely on hitting the engine's exact rotation timing to produce a real losing streak.
    """
    data = {}
    for i in range(n_assets):
        pulse_start = 2 * i
        levels, price = [], 100.0
        for w in range(len(weeks)):
            if w >= pulse_start:
                price *= 1.07 if w - pulse_start < 2 else 0.85
            levels.append(price)
        data[f"P{i}"] = pd.Series(levels, index=weeks)
    prices = pd.DataFrame(data)
    prices[CASH] = pd.Series(100 * 1.0005 ** np.arange(len(weeks)), index=weeks)
    prices[BENCHMARK] = pd.Series(100 * 1.001 ** np.arange(len(weeks)), index=weeks)
    return prices


def test_momentum_sizing_deploys_less_capital_after_a_realistic_losing_streak():
    weeks = pd.date_range("2020-01-03", periods=42, freq="W-FRI")
    prices = _pulse_crash_prices(18, weeks)
    base = dict(
        lookbacks=(1, 2),
        top_n=1,
        exit_rank=1,
        cost_pct=0.0,
        start="2020-01-01",
        portfolio="buffer",
        max_position=None,  # isolate the sizing effect from cap-driven parking
    )
    unsized = run_backtest(prices, includes(prices), Config(**base, momentum_sizing=False))
    sized = run_backtest(prices, includes(prices), Config(**base, momentum_sizing=True))

    # Confirm the fixture actually produced a real losing streak (a meaningful number of the
    # trades are closed at a loss) before trusting comparisons built on top of it.
    sells = unsized.trades.query("action == 'SELL'")
    assert len(sells) >= 10
    assert (sells["position_return"] < 0).sum() >= 8

    idle_unsized = unsized.weights.get(IDLE, pd.Series(0.0, index=unsized.weights.index))
    idle_sized = sized.weights.get(IDLE, pd.Series(0.0, index=sized.weights.index))
    # With no position cap, every trade week's proceeds are fully deployed to the single top-
    # ranked name when sizing is off - nothing is ever parked.
    assert idle_unsized.max() == pytest.approx(0.0, abs=1e-9)
    # With sizing on, the losing streak above pushes the multiplier well below 1.0, so a real
    # share of the portfolio sits in cash instead.
    assert idle_sized.max() > 0.10
    # Directly: less capital ends up deployed into the ranked holding once sizing is on.
    checkpoint = weeks[35]
    invested_unsized = unsized.weights.drop(columns=[IDLE], errors="ignore").loc[checkpoint].sum()
    invested_sized = sized.weights.drop(columns=[IDLE], errors="ignore").loc[checkpoint].sum()
    assert invested_sized < invested_unsized

    # And this isn't simply proportional de-risking that preserves relative drawdown for free -
    # a fair read also checks whether it actually cut into the loss: over this losing stretch the
    # sized run's equity should have fallen by less than the unsized run's.
    drawdown_unsized = unsized.equity.loc[checkpoint] / unsized.equity.cummax().loc[checkpoint] - 1
    drawdown_sized = sized.equity.loc[checkpoint] / sized.equity.cummax().loc[checkpoint] - 1
    assert drawdown_sized > drawdown_unsized  # smaller (less negative) drawdown


# --------------------------------------------------------------------------
# mass_exit_throttle (TODO.md 3.9.20, response variant A -- "capital throttle"): the "on/off +
# how much" setting lives on Config, but WHICH weeks are flagged is per-run computed data passed
# to run_backtest's own `mass_exit_weeks` argument (see categories/broad.py's
# compute_category_selection_mass_exit for how a real caller derives that set) -- these tests
# drive it directly with a hand-picked frozenset, the same way membership/trade_prices tests do.
# --------------------------------------------------------------------------


def test_config_rejects_invalid_mass_exit_throttle_fraction():
    with pytest.raises(ValueError, match="mass_exit_throttle_fraction"):
        Config(mass_exit_throttle_fraction=1.5)
    with pytest.raises(ValueError, match="mass_exit_throttle_fraction"):
        Config(mass_exit_throttle_fraction=-0.1)


def test_mass_exit_throttle_off_leaves_existing_buffer_behaviour_unchanged():
    assert Config().mass_exit_throttle is False
    prices = runaway_winner()
    a = run_backtest(prices, includes(prices), bcfg(top_n=3, exit_rank=5, max_position=0.35))
    b = run_backtest(
        prices,
        includes(prices),
        bcfg(top_n=3, exit_rank=5, max_position=0.35, mass_exit_throttle=False),
    )
    pd.testing.assert_series_equal(a.equity, b.equity)
    pd.testing.assert_frame_equal(a.weights, b.weights)
    pd.testing.assert_frame_equal(a.trades, b.trades)


def test_mass_exit_weeks_argument_is_inert_without_mass_exit_throttle_on():
    """Passing mass_exit_weeks to run_backtest does nothing unless config.mass_exit_throttle is
    also True - mirrors membership=None/momentum_sizing=False's own inertness elsewhere."""
    prices = frame(A=path((29, 0.03)), B=path((29, 0.01)))
    config = bcfg(top_n=1, exit_rank=2)
    baseline = run_backtest(prices, includes(prices), config)
    flagged_week = baseline.trades["week"].iloc[0]

    still = run_backtest(
        prices, includes(prices), config, mass_exit_weeks=frozenset({flagged_week})
    )
    pd.testing.assert_series_equal(baseline.equity, still.equity)
    pd.testing.assert_frame_equal(baseline.trades, still.trades)


def test_mass_exit_throttle_withholds_capital_on_a_flagged_week():
    prices = frame(A=path((29, 0.03)), B=path((29, 0.01)))
    baseline = run_backtest(prices, includes(prices), bcfg(top_n=1, exit_rank=2))
    flagged_week = baseline.trades["week"].iloc[0]

    throttled = run_backtest(
        prices,
        includes(prices),
        bcfg(top_n=1, exit_rank=2, mass_exit_throttle=True, mass_exit_throttle_fraction=0.5),
        mass_exit_weeks=frozenset({flagged_week}),
    )

    invested_baseline = (
        baseline.weights.drop(columns=[IDLE], errors="ignore").loc[flagged_week].sum()
    )
    invested_throttled = (
        throttled.weights.drop(columns=[IDLE], errors="ignore").loc[flagged_week].sum()
    )
    assert invested_baseline == pytest.approx(1.0)
    # Half of that week's fresh capital is withheld into cash instead of being deployed.
    assert invested_throttled == pytest.approx(0.5, abs=1e-6)
    assert throttled.weights.loc[flagged_week, IDLE] == pytest.approx(0.5, abs=1e-6)

    park_reasons = throttled.trades.query("week == @flagged_week and action == 'PARK'")["reason"]
    assert any("mass exit" in r for r in park_reasons)

    # A later, unflagged week is unaffected - the throttle never recurs on its own.
    later_park_reasons = throttled.trades.query("week != @flagged_week and action == 'PARK'")[
        "reason"
    ]
    assert not any("mass exit" in r for r in later_park_reasons)


def test_mass_exit_throttle_fraction_controls_how_much_is_withheld():
    prices = frame(A=path((29, 0.03)), B=path((29, 0.01)))
    baseline = run_backtest(prices, includes(prices), bcfg(top_n=1, exit_rank=2))
    flagged_week = baseline.trades["week"].iloc[0]

    throttled = run_backtest(
        prices,
        includes(prices),
        bcfg(top_n=1, exit_rank=2, mass_exit_throttle=True, mass_exit_throttle_fraction=0.25),
        mass_exit_weeks=frozenset({flagged_week}),
    )
    assert throttled.weights.loc[flagged_week, IDLE] == pytest.approx(0.25, abs=1e-6)


def test_mass_exit_throttle_stacks_with_momentum_sizing_on_the_same_week():
    """Both mechanisms are independently toggled and, per engine.py's own comment on the
    reservation order, mass_exit_throttle's cut is taken from what's LEFT after momentum_sizing's
    own reservation - not from the original proceeds. Confirmed here: turning both on withholds
    strictly more than momentum_sizing alone."""
    prices = frame(A=path((29, 0.03)), B=path((29, 0.01)))
    baseline = run_backtest(prices, includes(prices), bcfg(top_n=1, exit_rank=2))
    flagged_week = baseline.trades["week"].iloc[0]

    sizing_only = run_backtest(
        prices,
        includes(prices),
        bcfg(top_n=1, exit_rank=2, momentum_sizing=True),  # no closed trades yet -> multiplier 1.0
    )
    both = run_backtest(
        prices,
        includes(prices),
        bcfg(
            top_n=1,
            exit_rank=2,
            momentum_sizing=True,
            mass_exit_throttle=True,
            mass_exit_throttle_fraction=0.5,
        ),
        mass_exit_weeks=frozenset({flagged_week}),
    )
    idle_sizing_only = (
        sizing_only.weights.loc[flagged_week, IDLE] if IDLE in sizing_only.weights else 0.0
    )
    idle_both = both.weights.loc[flagged_week, IDLE]
    assert idle_both > idle_sizing_only
    assert idle_both == pytest.approx(0.5, abs=1e-6)  # no closed trades yet: sizing itself is inert


# --- no_buy: an entry-only gate (e.g. a share-price ceiling); holdings are never sold for it ---
def test_a_no_buy_name_is_skipped_and_the_next_best_fills_its_slot():
    prices = two_pairs()
    blocked = pd.DataFrame(False, index=prices.index, columns=prices.columns)
    blocked["A"] = True
    kw = dict(top_n=2, exit_rank=4, max_position=None)
    free = run_backtest(prices, includes(prices), bcfg(**kw))
    gated = run_backtest(prices, includes(prices), bcfg(**kw), no_buy=blocked)
    assert "A" in set(free.trades.query("action == 'BUY'")["asset"])
    assert set(gated.trades.query("action in ['BUY', 'ADD']")["asset"]) == {"B", "C"}
    assert "A" not in gated.weights.columns or gated.weights["A"].fillna(0).max() == 0


def test_a_no_buy_name_already_held_is_held_through_not_sold():
    prices = two_pairs()
    blocked = pd.DataFrame(False, index=prices.index, columns=prices.columns)
    blocked.loc[prices.index[8:], "A"] = True  # A becomes unbuyable after it was bought
    kw = dict(top_n=2, exit_rank=4, max_position=None)
    result = run_backtest(prices, includes(prices), bcfg(**kw), no_buy=blocked)
    assert "A" in set(result.trades.query("action == 'BUY'")["asset"])
    assert "A" not in set(result.trades.query("action == 'SELL'")["asset"])
    assert result.weights["A"].iloc[-1] > 0


def test_no_buy_of_all_false_changes_nothing():
    prices = two_pairs()
    none = pd.DataFrame(False, index=prices.index, columns=prices.columns)
    kw = dict(top_n=2, exit_rank=4, max_position=None)
    a = run_backtest(prices, includes(prices), bcfg(**kw))
    b = run_backtest(prices, includes(prices), bcfg(**kw), no_buy=none)
    pd.testing.assert_series_equal(a.equity, b.equity)
