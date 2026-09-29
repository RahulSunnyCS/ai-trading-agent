"""Stock-momentum additions to the backtest engine: the voladj/blend ranking methods,
membership-gated buying, monthly rebalancing and the itemised cost model (engine.py), plus the
stocks/ui_data.py loader. One rule per test, mirroring tests/test_engine.py's style.

The voladj/blend tests reuse the "exactly two ranked instruments" trick: with n=2, a
cross-sectional z-score (mean/std across instruments, pandas' default ddof=1) is *always*
exactly +-1/sqrt(2) for whichever instrument leads that component, regardless of the raw
magnitudes involved. That turns "hand-computable expected ranks" into an exact closed-form
assertion instead of an approximate one - see test_voladj_rank_matches_the_documented_formula.

Everything else reuses tests/test_engine.py's WEEKS/path/frame/includes/cfg helpers, importable
because pytest puts tests/ on sys.path (test_trade_prices.py already relies on the same import).
"""

import math
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
from test_engine import WEEKS, cfg, frame, includes, path

from momentum_backtesting.engine import (
    BENCHMARK,
    CASH,
    DP_CHARGE_FRACTION_CAP,
    DP_CHARGE_RS,
    EXCHANGE_FEES_RATE,
    STAMP_DUTY_BUY_RATE,
    STT_RATE,
    Config,
    _Sim,
    compute_ranks,
    run_backtest,
)
from momentum_backtesting.stocks.ui_data import (
    NIFTY50_EQUAL_WEIGHT_TRI,
    NIFTY50_TRI,
    NIFTY200_MOMENTUM30_TRI,
    load_stock_dataset,
)

# --- score modes: voladj / blend -------------------------------------------------------------
# A longer week span than test_engine's WEEKS (30) - voladj needs 52+ weeks of history.
LONG_WEEKS = pd.date_range("2020-01-03", periods=60, freq="W-FRI")


def alt_path(r1: float, r2: float, n: int) -> pd.Series:
    """A price path alternating between two weekly returns, starting at 100. Any run of `k`
    consecutive steps (k even) contains exactly k/2 of each return - the closed form this
    module's tests lean on for vol/return math that's exact, not approximate."""
    rets = [r1 if i % 2 == 0 else r2 for i in range(n)]
    prices = 100 * np.cumprod([1.0, *(1 + r for r in rets)])
    return pd.Series(prices[: len(LONG_WEEKS)], index=LONG_WEEKS[: len(prices)])


def test_voladj_rank_matches_the_documented_formula():
    # A: steady, low-volatility grind (+2%/0% alternating). B: choppier but a much bigger raw
    # return (+10%/-6% alternating) - so voladj (risk-adjusted) prefers A while a raw-return
    # ranking would prefer B. See the module docstring for why the composite is exactly +-sqrt(2).
    prices = pd.DataFrame({"A": alt_path(0.02, 0.0, 59), "B": alt_path(0.10, -0.06, 59)})
    config = Config(
        top_n=1, exit_rank=1, start="2020-01-01", score="voladj", voladj_skip_recent_month=False
    )
    ranks, scores = compute_ranks(prices, config)
    last = LONG_WEEKS[-1]
    assert scores.at[last, "A"] == pytest.approx(math.sqrt(2))
    assert scores.at[last, "B"] == pytest.approx(-math.sqrt(2))
    assert (ranks.at[last, "A"], ranks.at[last, "B"]) == (1.0, 2.0)


def test_voladj_skip_recent_month_shifts_the_lookback_by_four_weeks():
    prices = pd.DataFrame({"A": alt_path(0.02, 0.0, 59), "B": alt_path(0.10, -0.06, 59)})
    skip = Config(score="voladj", voladj_skip_recent_month=True, start="2020-01-01")
    no_skip = Config(score="voladj", voladj_skip_recent_month=False, start="2020-01-01")
    ranks_skip, _ = compute_ranks(prices, skip)
    ranks_no_skip, _ = compute_ranks(prices, no_skip)
    # Eligibility needs 52 (+4 if skipping) weeks of history, so the skip variant starts ranking
    # four weeks later.
    first_skip = ranks_skip["A"].first_valid_index()
    first_no_skip = ranks_no_skip["A"].first_valid_index()
    assert first_skip == first_no_skip + pd.Timedelta(weeks=4)


def test_blend_averages_the_two_ranks_and_ties_break_by_name():
    # Ranksum (raw return) prefers B at every one of the default lookbacks (1/4/13/26/52 weeks);
    # voladj (risk-adjusted) prefers A. With exactly two instruments that disagree completely,
    # the averaged rank is a dead-heat 1.5/1.5 for both, so the re-rank falls through to the name
    # tie-break - "A" before "B" - regardless of which sub-method "should" win.
    prices = pd.DataFrame({"A": alt_path(0.02, 0.0, 59), "B": alt_path(0.10, -0.06, 59)})
    last = LONG_WEEKS[-1]

    ranksum_ranks, _ = compute_ranks(prices, Config(score="ranksum", start="2020-01-01"))
    voladj_ranks, _ = compute_ranks(
        prices, Config(score="voladj", voladj_skip_recent_month=False, start="2020-01-01")
    )
    assert (ranksum_ranks.at[last, "A"], ranksum_ranks.at[last, "B"]) == (2.0, 1.0)
    assert (voladj_ranks.at[last, "A"], voladj_ranks.at[last, "B"]) == (1.0, 2.0)

    blend_ranks, blend_scores = compute_ranks(
        prices, Config(score="blend", voladj_skip_recent_month=False, start="2020-01-01")
    )
    assert blend_scores.at[last, "A"] == pytest.approx(1.5)
    assert blend_scores.at[last, "B"] == pytest.approx(1.5)
    assert (blend_ranks.at[last, "A"], blend_ranks.at[last, "B"]) == (1.0, 2.0)


def test_blend_only_ranks_instruments_eligible_in_both_sub_rankings():
    # C has 54 weeks of history: enough for ranksum's default 52-week lookback, but short of
    # voladj's default 56 weeks (52 + the 4-week skip-recent-month offset) - so it must be
    # eligible for the ranksum sub-ranking but not voladj, and blend must exclude it either way.
    late = pd.Series(100.0, index=LONG_WEEKS).where(LONG_WEEKS[6] <= LONG_WEEKS)
    prices = pd.DataFrame(
        {"A": alt_path(0.02, 0.0, 59), "B": alt_path(0.10, -0.06, 59), "C": late}
    )
    last = LONG_WEEKS[-1]
    ranksum_ranks, _ = compute_ranks(prices, Config(score="ranksum", start="2020-01-01"))
    assert pd.notna(ranksum_ranks.at[last, "C"])  # confirms the scenario actually diverges

    blend_ranks, _ = compute_ranks(prices, Config(score="blend", start="2020-01-01"))
    assert pd.isna(blend_ranks.at[last, "C"])


# --- membership-gated buying --------------------------------------------------------------------
def test_membership_gate_blocks_a_new_buy_of_a_non_member():
    prices = frame(A=path((29, 0.05)), B=path((29, 0.01)), C=path((29, -0.01)))
    membership = pd.DataFrame({"A": False}, index=WEEKS)  # A is never an index member
    gated = run_backtest(prices, includes(prices), cfg(top_n=2, exit_rank=2), membership=membership)
    assert "A" not in set(gated.trades["asset"])
    assert "B" in set(gated.trades["asset"])  # the next-best eligible name is bought instead
    # Without the gate, the same prices buy A too - proving the gate (not the ranking) excluded it.
    free = run_backtest(prices, includes(prices), cfg(top_n=2, exit_rank=2))
    assert "A" in set(free.trades["asset"])


def test_membership_gate_never_force_sells_an_existing_holding():
    # A leads early (bought while a member), then drops out of the index while still comfortably
    # top-ranked - it must stay held. Only once its own rank later deteriorates (via the normal
    # exit_reason path, which never looks at membership) does it get sold.
    prices = frame(A=path((20, 0.05), (9, -0.02)), B=path((29, 0.01)))
    membership = pd.DataFrame({"A": [True] * 10 + [False] * 20}, index=WEEKS)
    result = run_backtest(prices, includes(prices), cfg(exit_rank=1), membership=membership)

    buys = result.trades.query("action == 'BUY' and asset == 'A'")
    assert len(buys) == 1 and buys["week"].iloc[0] < WEEKS[10]  # bought while still a member

    assert not membership.at[WEEKS[15], "A"]  # sanity: genuinely non-member by week 15
    assert result.holdings["slot 1"].loc[WEEKS[15]] == "A"  # still held, 5 weeks non-member

    sells = result.trades.query("action == 'SELL' and asset == 'A'")
    assert len(sells) == 1
    assert "rank" in sells["reason"].iloc[0]  # sold for falling out of rank, not membership


def test_membership_none_disables_the_gate_entirely():
    # membership=None (the default) is a no-op: identical to a run with no membership argument.
    prices = frame(A=path((29, 0.05)), B=path((29, 0.01)))
    a = run_backtest(prices, includes(prices), cfg())
    b = run_backtest(prices, includes(prices), cfg(), membership=None)
    pd.testing.assert_series_equal(a.equity, b.equity)


# --- monthly rebalance ---------------------------------------------------------------------------
def test_monthly_rebalance_trades_at_most_once_per_calendar_month():
    # Leadership between A and B flips every ~3 weeks, so a weekly-rebalancing run trades inside
    # the same calendar month more than once; monthly rebalancing must never do that.
    prices = frame(
        A=path(
            (3, 0.05),
            (3, -0.04),
            (3, 0.05),
            (3, -0.04),
            (3, 0.05),
            (3, -0.04),
            (3, 0.05),
            (5, -0.04),
        ),
        B=path((29, 0.01)),
    )
    weekly = run_backtest(prices, includes(prices), cfg(exit_rank=1))
    monthly = run_backtest(prices, includes(prices), cfg(exit_rank=1, rebalance="monthly"))

    weekly_months = [(w.year, w.month) for w in sorted(set(weekly.trades["week"]))]
    # sanity: weekly rebalancing does trade more than once within some calendar month here.
    assert len(weekly_months) > len(set(weekly_months))

    monthly_weeks = sorted(set(monthly.trades["week"]))
    monthly_months = [(w.year, w.month) for w in monthly_weeks]
    assert monthly_months  # the scenario does trade at least once
    assert len(monthly_months) == len(set(monthly_months))  # never twice in the same month

    # Holdings still mark to market every week (not just trade weeks): equity moves far more
    # often than trades happen.
    changes = monthly.equity.diff().dropna()
    assert (changes != 0).sum() > len(monthly_weeks)


def test_rebalance_weekly_is_the_default_and_matches_omitting_it():
    prices = frame(A=path((14, 0.03), (15, -0.02)), B=path((29, 0.01)))
    default = run_backtest(prices, includes(prices), cfg())
    explicit = run_backtest(prices, includes(prices), cfg(rebalance="weekly"))
    pd.testing.assert_series_equal(default.equity, explicit.equity)
    pd.testing.assert_frame_equal(default.trades, explicit.trades)


# --- itemised costs -------------------------------------------------------------------------------
def _sim(config: Config) -> _Sim:
    return _Sim(
        prices=pd.DataFrame(),
        ranks=pd.DataFrame(),
        filter_ret=pd.DataFrame(),
        config=config,
        ledger=None,
        tax_classes={},
    )


def test_flat_cost_model_is_unchanged_and_symmetric():
    config = Config(cost_pct=0.25, cost_model="flat")
    sim = _sim(config)
    assert sim.buy_cost(0.4) == pytest.approx(0.0025)
    assert sim.sell_cost(0.4) == pytest.approx(0.0025)
    assert sim.buy_cost(0.4) == sim.sell_cost(0.4) == pytest.approx(config.cost_pct / 100)


def test_itemised_cost_matches_the_hand_computed_formula():
    config = Config(cost_model="itemised", capital=1_000_000.0, slippage_bps=5.0)
    sim = _sim(config)
    value_fraction = 0.1  # Rs 100,000 of a Rs 1,000,000 portfolio
    slippage = 5.0 / 10000
    expected_buy = STT_RATE + STAMP_DUTY_BUY_RATE + EXCHANGE_FEES_RATE + slippage
    expected_sell = (
        STT_RATE + EXCHANGE_FEES_RATE + slippage + DP_CHARGE_RS / (value_fraction * config.capital)
    )
    assert sim.buy_cost(value_fraction) == pytest.approx(expected_buy)
    assert sim.sell_cost(value_fraction) == pytest.approx(expected_sell)
    # Buying never carries the (sell-only) DP charge, so it's always cheaper than selling here.
    assert sim.buy_cost(value_fraction) < sim.sell_cost(value_fraction)


def test_itemised_dp_charge_fraction_is_capped_for_a_dust_sized_sell():
    config = Config(cost_model="itemised", capital=1_000_000.0, slippage_bps=5.0)
    sim = _sim(config)
    dust = 0.00001  # Rs 10 of a Rs 1,000,000 portfolio - the flat Rs 16 DP charge alone is 160%
    expected = STT_RATE + EXCHANGE_FEES_RATE + config.slippage_bps / 10000 + DP_CHARGE_FRACTION_CAP
    assert sim.sell_cost(dust) == pytest.approx(expected)


def test_itemised_dp_charge_is_zero_for_a_non_positive_value_fraction():
    config = Config(cost_model="itemised")
    sim = _sim(config)
    expected = STT_RATE + EXCHANGE_FEES_RATE + config.slippage_bps / 10000
    assert sim.sell_cost(0.0) == pytest.approx(expected)
    assert sim.sell_cost(-0.01) == pytest.approx(expected)


def test_itemised_cost_reduces_equity_by_the_hand_computed_buy_cost_on_entry():
    # Flat prices, top_n=1: mirrors test_engine.py's test_costs_are_charged_once_on_entry, but
    # for the itemised model - a single BUY, costed at entry, never again while holding.
    prices = frame(A=pd.Series(100.0, index=WEEKS))
    prices[BENCHMARK] = 100.0
    config = cfg(cost_model="itemised", capital=1_000_000.0, slippage_bps=5.0)
    result = run_backtest(prices, includes(prices), config)
    expected_buy_cost = STT_RATE + STAMP_DUTY_BUY_RATE + EXCHANGE_FEES_RATE + 5.0 / 10000
    assert result.equity.iloc[-1] == pytest.approx(1 - expected_buy_cost)
    assert len(result.trades) == 1


# --- Config validation / label -------------------------------------------------------------------
def test_new_config_fields_default_to_todays_behaviour():
    config = Config()
    assert (config.score, config.rebalance, config.cost_model) == ("ranksum", "weekly", "flat")
    assert config.voladj_skip_recent_month is True
    assert config.capital == 1_000_000.0
    assert config.slippage_bps == 5.0
    for token in ("ranksum", "weekly", "flat"):
        assert token not in config.label


def test_invalid_new_config_fields_are_rejected():
    with pytest.raises(ValueError, match="score"):
        Config(score="bogus")
    with pytest.raises(ValueError, match="rebalance"):
        Config(rebalance="bogus")
    with pytest.raises(ValueError, match="cost_model"):
        Config(cost_model="bogus")
    with pytest.raises(ValueError, match="capital"):
        Config(capital=0)
    with pytest.raises(ValueError, match="slippage_bps"):
        Config(slippage_bps=-1)


# --- stocks/ui_data.py -----------------------------------------------------------------------
DATA = Path(__file__).resolve().parents[2] / "data" / "stocks"


@pytest.mark.skipif(not (DATA / "nifty50_weekly_tr.csv").exists(), reason="stock data not built")
def test_load_stock_dataset_smoke():
    ds = load_stock_dataset()
    assert not ds.prices.empty and not ds.price_only.empty and not ds.membership.empty
    assert ds.prices.shape == ds.price_only.shape
    for column in (NIFTY50_TRI, NIFTY200_MOMENTUM30_TRI, NIFTY50_EQUAL_WEIGHT_TRI, CASH):
        assert column in ds.prices.columns
        assert column in ds.price_only.columns
    assert ds.last_week == ds.prices.index.max()
    assert ds.companies and all(isinstance(v, str) and v for v in ds.companies.values())
    # Every company_id is still "equity"; the 4 extra instruments (Gold/Silver/Cash/Gilt) added
    # their own gold_silver/debt tax classes on top - see ui_data._EXTRA_TAX_CLASSES.
    assert ds.tax_classes and {ds.tax_classes[c] for c in ds.companies} == {"equity"}
    assert ds.extra_instruments  # Gold/Silver/Gilt present in this repo's real weekly_closes.csv
    # CASH and the benchmarks are dense full-history series (unlike individual stocks, which can
    # legitimately have leading NaN before their listing date).
    dense = [CASH, NIFTY50_TRI, NIFTY200_MOMENTUM30_TRI, NIFTY50_EQUAL_WEIGHT_TRI]
    assert not ds.prices[dense].isna().any().any()
