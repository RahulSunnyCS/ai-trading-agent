"""BL-001 F6: a past week's ranks must not depend on stocks that only join the universe later.

The cross-section (who is ranked against whom) is the point-in-time members, and a gap inside a
stock's history is filled the same whether or not the stock stops trading later."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from momentum_backtesting import engine
from momentum_backtesting.categories import broad
from momentum_backtesting.categories.prices import _forward_filled

WEEKS = pd.date_range("2020-01-03", periods=90, freq="W-FRI")


def _prices(n_stocks: int = 12, seed: int = 3) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    steps = rng.normal(0.004, 0.04, size=(len(WEEKS), n_stocks))
    return pd.DataFrame(
        100 * np.cumprod(1 + steps, axis=0), index=WEEKS, columns=list("ABCDEFGHIJKL")
    )


CONFIGS = {
    "ranksum": engine.Config(lookbacks=(4, 13, 26), score="ranksum", universe=("A",)),
    "voladj": engine.Config(lookbacks=(4, 13, 26, 52), score="voladj", universe=("A",)),
    "voladj_lookbacks": engine.Config(
        lookbacks=(4, 13, 26, 52), score="voladj", voladj_lookbacks=True, universe=("A",)
    ),
    "blend": engine.Config(lookbacks=(4, 13, 26, 52), score="blend", universe=("A",)),
}


@pytest.mark.parametrize("name", CONFIGS)
def test_an_instrument_outside_the_cross_section_changes_nobody_elses_rank(name):
    prices = _prices()
    # An outlier that would move every mean, spread and rank position if it took part.
    prices["L"] = prices["L"] * np.linspace(1, 6, len(WEEKS))
    inside = [c for c in prices.columns if c != "L"]
    mask = pd.DataFrame(True, index=prices.index, columns=prices.columns)
    mask["L"] = False

    with_mask, _ = engine.compute_ranks(prices, CONFIGS[name], mask)
    alone, _ = engine.compute_ranks(prices[inside], CONFIGS[name])
    pd.testing.assert_frame_equal(with_mask[inside], alone, check_exact=False, rtol=1e-12)
    assert with_mask["L"].isna().all()

    # Without the mask the outlier does move the others: the test would not notice otherwise.
    unmasked, _ = engine.compute_ranks(prices, CONFIGS[name])
    assert not unmasked[inside].equals(alone)


@pytest.mark.parametrize("name", CONFIGS)
def test_ranks_at_a_week_do_not_depend_on_a_stock_that_joins_the_cross_section_later(name):
    """The shape of the real defect: a stock with history is in the frame from its first price,
    but joins the universe in week 60. Weeks before that must rank exactly as without it."""
    prices = _prices()
    joins = 60
    mask = pd.DataFrame(True, index=prices.index, columns=prices.columns)
    mask.loc[prices.index[:joins], "L"] = False
    early = prices.index[:joins]

    with_l, _ = engine.compute_ranks(prices, CONFIGS[name], mask)
    without_l, _ = engine.compute_ranks(prices.drop(columns="L"), CONFIGS[name])
    pd.testing.assert_frame_equal(
        with_l.loc[early].drop(columns="L"), without_l.loc[early], check_exact=False, rtol=1e-12
    )


def test_no_cross_section_keeps_every_other_caller_unchanged():
    prices = _prices()
    full = pd.DataFrame(True, index=prices.index, columns=prices.columns)
    for config in CONFIGS.values():
        a, _ = engine.compute_ranks(prices, config)
        b, _ = engine.compute_ranks(prices, config, full)
        pd.testing.assert_frame_equal(a, b)


def test_the_cross_section_is_members_plus_atomics():
    weeks = WEEKS[:4]
    membership = pd.DataFrame({"AAA": [True, True, False, True], "BBB": [False] * 4}, index=weeks)
    atomic = next(iter(broad.ATOMIC_NAMES))
    frame = pd.DataFrame(1.0, index=weeks, columns=["AAA", "BBB", "CCC", atomic])
    mask = broad.cross_section_mask(membership, frame)
    assert mask["AAA"].tolist() == [True, True, False, True]
    assert not mask["BBB"].any() and not mask["CCC"].any()  # CCC is in no universe list
    assert mask[atomic].all()


def test_tail_only_fill_leaves_a_gap_inside_the_history_and_fills_after_the_end():
    weeks = WEEKS[:8]
    frame = pd.DataFrame(
        {
            "ENDED": [1.0, 2.0, np.nan, np.nan, 5.0, 6.0, np.nan, np.nan],
            "LIVE": [1.0, np.nan, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0],
        },
        index=weeks,
    )
    whole = _forward_filled(frame, ["ENDED"])
    assert whole["ENDED"].tolist() == [1, 2, 2, 2, 5, 6, 6, 6]  # the old behaviour: gap filled
    tail = _forward_filled(frame, ["ENDED"], tail_only=True)
    expected = [1.0, 2.0, np.nan, np.nan, 5.0, 6.0, 6.0, 6.0]
    np.testing.assert_array_equal(tail["ENDED"].to_numpy(), np.asarray(expected))
    pd.testing.assert_series_equal(tail["LIVE"], frame["LIVE"])  # untouched columns stay


def test_a_gap_is_treated_the_same_whether_or_not_the_stock_ends_later():
    """The F6 defect: a run stopped at a past date and one on later data must see the same gap."""
    weeks = WEEKS[:10]
    base = [1.0, 2.0, np.nan, np.nan, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0]
    still_trading = pd.DataFrame({"X": base}, index=weeks)
    ends_later = pd.DataFrame({"X": [*base[:8], np.nan, np.nan]}, index=weeks)
    a = _forward_filled(still_trading, [], tail_only=True)["X"].iloc[:8]
    b = _forward_filled(ends_later, ["X"], tail_only=True)["X"].iloc[:8]
    np.testing.assert_array_equal(a.to_numpy(), b.to_numpy())


def _ranking_with_membership():
    weeks = WEEKS[:6]
    prices = pd.DataFrame({"AAA": 1.0, "BBB": 2.0}, index=weeks)
    membership = pd.DataFrame(
        {"AAA": [True] * 6, "BBB": [False, False, False, True, True, True]}, index=weeks
    )
    nan = pd.DataFrame(float("nan"), index=weeks, columns=prices.columns)
    return broad.UniverseRanking(
        prices=prices,
        weeks=list(weeks),
        global_ranks=nan,
        pool_membership=pd.DataFrame(False, index=weeks, columns=prices.columns),
        stock_pool_ranks=nan,
        combined_pool_ranks=nan,
        column_to_base_symbol={"AAA": "AAA", "BBB": "BBB"},
        events=pd.DataFrame(),
        stale_columns={},
        missing_symbols=[],
        stock_membership=membership,
    )


def test_the_sentinel_week_carries_membership_so_the_tilt_still_ranks_it():
    """BL-001 F6: the stock tilt reads ranking.cross_section() on the persisted (sentinel) ranking.
    A sentinel week without membership would give every tilt strategy no picks, silently."""
    from momentum_backtesting import rebalance

    ranking = _ranking_with_membership()
    week = ranking.prices.index[-1]
    persisted = rebalance.persisted_broad_ranking(ranking)
    mask = persisted.cross_section()
    sentinel = week + pd.Timedelta(days=7)
    assert list(mask.index) == list(persisted.prices.index) and sentinel in mask.index
    assert mask.loc[sentinel, ["AAA", "BBB"]].tolist() == [True, True]  # last week's members
    # stopped at an earlier week: the later weeks are dropped and that week's members carry over
    through = ranking.prices.index[2]
    earlier = rebalance.persisted_broad_ranking(ranking, through=through).cross_section()
    assert earlier.index[-1] == through + pd.Timedelta(days=7)
    assert earlier.iloc[-1][["AAA", "BBB"]].tolist() == [True, False]


def test_a_mask_that_does_not_cover_the_prices_is_refused_not_read_as_nobody():
    prices = _prices()
    short = pd.DataFrame(True, index=prices.index[:-3], columns=prices.columns)
    with pytest.raises(ValueError, match="cross_section lacks"):
        engine.compute_ranks(prices, CONFIGS["ranksum"], short)
    narrow = pd.DataFrame(True, index=prices.index, columns=prices.columns[:-1])
    with pytest.raises(ValueError, match="cross_section lacks"):
        engine.compute_ranks(prices, CONFIGS["voladj"], narrow)
