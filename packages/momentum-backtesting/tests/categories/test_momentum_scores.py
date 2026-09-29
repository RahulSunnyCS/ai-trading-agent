"""categories/momentum_scores.py: the Momentum Scores page (TODO.md 3.9.16) -- percentile-rank
scoring math on hand-built fixtures, the stock-level snapshot's point-in-time membership gate,
and the sector-level aggregation. No network, no real data/ files (except the one sanity check
against the real committed stock_groups.csv, mirroring test_broad.py's own
test_load_stock_groups_reads_real_curated_file)."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from momentum_backtesting.categories import broad
from momentum_backtesting.categories import momentum_scores as ms

# --------------------------------------------------------------------------
# _percentile_scores: rank 1 (best) -> ~100, worst -> ~0, hand-verified.
# --------------------------------------------------------------------------


def test_percentile_scores_best_worst_and_middling():
    # 5 names, returns ascending A (worst) .. E (best). Hand arithmetic:
    # rank(ascending) A=1,B=2,C=3,D=4,E=5 -> score = (rank-1)/(5-1)*100 = 0,25,50,75,100.
    returns = pd.Series({"A": -0.30, "B": -0.10, "C": 0.00, "D": 0.20, "E": 0.50})
    scores = ms._percentile_scores(returns)
    assert scores["A"] == pytest.approx(0.0)
    assert scores["B"] == pytest.approx(25.0)
    assert scores["C"] == pytest.approx(50.0)
    assert scores["D"] == pytest.approx(75.0)
    assert scores["E"] == pytest.approx(100.0)


def test_percentile_scores_best_performer_near_100_worst_near_0_large_n():
    # 11 evenly-spaced returns -- the best gets exactly 100, the worst exactly 0, a true
    # middling one (the 6th of 11, dead centre) lands at exactly 50.
    returns = pd.Series({f"n{i}": float(i) for i in range(11)})  # n0=0 (worst) .. n10=10 (best)
    scores = ms._percentile_scores(returns)
    assert scores["n10"] == pytest.approx(100.0)
    assert scores["n0"] == pytest.approx(0.0)
    assert scores["n5"] == pytest.approx(50.0)  # (rank 6 - 1) / (11 - 1) * 100 = 50


def test_percentile_scores_ties_share_the_same_score():
    # B and C tie for the best return. rank(method="min"): A=1 (worst, alone), B=C=2 (tied,
    # both take the lower of the two positions they'd otherwise split). score=(rank-1)/(n-1)*100
    # with n=3 -> A=0, B=C=(2-1)/2*100=50 -- tied inputs must produce the SAME score, not two
    # different ones, and NOT the 100 a naive "best return -> 100" rule would wrongly give both.
    returns = pd.Series({"A": 0.0, "B": 1.0, "C": 1.0})
    scores = ms._percentile_scores(returns)
    assert scores["B"] == scores["C"]
    assert scores["B"] == pytest.approx(50.0)
    assert scores["A"] == pytest.approx(0.0)


def test_percentile_scores_nan_entries_are_excluded_from_the_universe():
    returns = pd.Series({"A": -0.10, "B": float("nan"), "C": 0.10})
    scores = ms._percentile_scores(returns)
    assert "B" not in scores
    assert set(scores.index) == {"A", "C"}
    assert scores["A"] == pytest.approx(0.0)
    assert scores["C"] == pytest.approx(100.0)


def test_percentile_scores_single_eligible_name_is_neutral():
    returns = pd.Series({"A": 0.37})
    scores = ms._percentile_scores(returns)
    assert scores["A"] == pytest.approx(50.0)


def test_percentile_scores_empty_input_returns_empty():
    scores = ms._percentile_scores(pd.Series(dtype=float))
    assert scores.empty


# --------------------------------------------------------------------------
# compute_stock_momentum_scores: a small hand-built StockUniverseFrame.
# --------------------------------------------------------------------------


def _make_universe(
    prices: dict[str, list[float]], *, not_a_member_at_end: set[str] = frozenset()
) -> broad.StockUniverseFrame:
    n_weeks = len(next(iter(prices.values())))
    weeks = [pd.Timestamp("2020-01-03") + pd.Timedelta(weeks=i) for i in range(n_weeks)]
    frame = pd.DataFrame(prices, index=weeks)
    columns = list(frame.columns)
    column_to_base_symbol = {c: c for c in columns}
    membership = pd.DataFrame(True, index=weeks, columns=columns)
    for symbol in not_a_member_at_end:
        membership.loc[weeks[-1], symbol] = False
    return broad.StockUniverseFrame(
        frame=frame,
        weeks=weeks,
        column_to_base_symbol=column_to_base_symbol,
        stock_membership=membership,
        events=pd.DataFrame(),
        stale_columns={},
        missing_symbols=[],
    )


def test_compute_stock_momentum_scores_returns_and_prices_match_hand_arithmetic():
    # 27 weeks so a 26-week lookback has a divisor row (position 0). GOOD doubles over the
    # window (100% return), FLAT is unchanged (0%), BAD halves (-50%). 1-week change is read
    # off the last two rows directly.
    n = 27
    good = [100.0 + i for i in range(n - 1)] + [200.0]  # last week jumps to exactly 2x week 0
    flat = [50.0] * n
    bad = [80.0 + i * 0.1 for i in range(n - 1)] + [40.0]
    universe = _make_universe({"GOOD": good, "FLAT": flat, "BAD": bad})
    group_info: dict[str, ms.StockGroupInfo] = {}

    snap = ms.compute_stock_momentum_scores(universe, group_info, lookbacks=(26,))

    by_symbol = {r.symbol: r for r in snap.rows}
    assert set(by_symbol) == {"GOOD", "FLAT", "BAD"}

    good_row = by_symbol["GOOD"]
    assert good_row.last_price == pytest.approx(200.0)
    assert good_row.returns[26] == pytest.approx(200.0 / good[0] - 1.0)
    assert good_row.change_1w_pct == pytest.approx(200.0 / good[-2] - 1.0)

    flat_row = by_symbol["FLAT"]
    assert flat_row.returns[26] == pytest.approx(0.0)

    bad_row = by_symbol["BAD"]
    assert bad_row.returns[26] == pytest.approx(40.0 / bad[0] - 1.0)

    # GOOD has the highest 26w return, BAD the lowest, FLAT in between -> percentile scores
    # follow the same order as test_percentile_scores_best_worst_and_middling above.
    assert good_row.scores[26] == pytest.approx(100.0)
    assert bad_row.scores[26] == pytest.approx(0.0)
    assert flat_row.scores[26] == pytest.approx(50.0)

    assert snap.universe_size == 3
    assert snap.as_of == universe.weeks[-1]


def test_compute_stock_momentum_scores_excludes_a_symbol_not_a_member_at_the_latest_week():
    # DELISTED has a real (forward-filled) price at the last week, but its Total Market
    # membership/segment-liveness gate is False there -- e.g. it stopped trading or dropped out
    # of the index. A "right now" snapshot must not show it, even though its price column still
    # has a non-NaN value (see broad.py's own "Any column can go stale" docstring).
    n = 27
    live = [10.0 + i for i in range(n)]
    delisted = [10.0 + i for i in range(n)]
    universe = _make_universe(
        {"LIVE": live, "DELISTED": delisted}, not_a_member_at_end={"DELISTED"}
    )

    snap = ms.compute_stock_momentum_scores(universe, {}, lookbacks=(26,))

    symbols = {r.symbol for r in snap.rows}
    assert symbols == {"LIVE"}


def test_compute_stock_momentum_scores_uses_group_info_for_display_fields():
    universe = _make_universe({"ABC": [10.0 + i for i in range(27)]})
    group_info = {
        "ABC": ms.StockGroupInfo(
            parent_group="Financials", subgroup="Banks", company_name="ABC Bank Ltd."
        )
    }
    snap = ms.compute_stock_momentum_scores(universe, group_info, lookbacks=(4,))
    row = snap.rows[0]
    assert row.company_name == "ABC Bank Ltd."
    assert row.parent_group == "Financials"
    assert row.subgroup == "Banks"


def test_compute_stock_momentum_scores_missing_group_info_falls_back_to_symbol():
    universe = _make_universe({"XYZ": [10.0 + i for i in range(27)]})
    snap = ms.compute_stock_momentum_scores(universe, {}, lookbacks=(4,))
    row = snap.rows[0]
    assert row.company_name == "XYZ"
    assert row.parent_group == ""
    assert row.subgroup == ""


def test_compute_stock_momentum_scores_empty_frame_returns_empty_snapshot():
    universe = broad.StockUniverseFrame(
        frame=pd.DataFrame(),
        weeks=[],
        column_to_base_symbol={},
        stock_membership=pd.DataFrame(),
        events=pd.DataFrame(),
        stale_columns={},
        missing_symbols=[],
    )
    snap = ms.compute_stock_momentum_scores(universe, {})
    assert snap.rows == []
    assert snap.universe_size == 0


# --------------------------------------------------------------------------
# compute_sector_momentum_scores: average of qualifying members' own scores.
# --------------------------------------------------------------------------


def _snapshot_from_scores(
    scores_by_symbol: dict[str, dict[int, float | None]],
) -> ms.StockMomentumSnapshot:
    rows = [
        ms.StockMomentumRow(
            symbol=symbol,
            company_name=symbol,
            parent_group="",
            subgroup="",
            last_price=100.0,
            change_1w_pct=0.0,
            returns=dict.fromkeys(scores, 0.0),
            scores=scores,
        )
        for symbol, scores in scores_by_symbol.items()
    ]
    return ms.StockMomentumSnapshot(
        as_of=pd.Timestamp("2020-01-03"), universe_size=len(rows), lookbacks=(4, 13, 26), rows=rows
    )


def test_compute_sector_momentum_scores_averages_qualifying_members():
    snap = _snapshot_from_scores(
        {
            "A": {4: 80.0, 13: 60.0, 26: 40.0},
            "B": {4: 40.0, 13: 60.0, 26: 80.0},
            "C": {4: 60.0, 13: 60.0, 26: 60.0},
        }
    )
    group_members = {"Sector :: Group": {"A", "B", "C"}}

    sector_snap = ms.compute_sector_momentum_scores(snap, group_members)

    row = sector_snap.rows[0]
    assert row.cid == "Sector :: Group"
    assert row.parent_group == "Sector"
    assert row.subgroup == "Group"
    assert row.member_count == 3
    assert row.qualifying_count == 3
    assert row.scores[4] == pytest.approx((80.0 + 40.0 + 60.0) / 3)
    assert row.scores[13] == pytest.approx(60.0)
    assert row.scores[26] == pytest.approx((40.0 + 80.0 + 60.0) / 3)


def test_compute_sector_momentum_scores_ignores_non_qualifying_members_in_the_average():
    # "D" is a tagged member of the group but never made it into the stock-level snapshot (not
    # currently live/in-universe) -- member_count counts it, qualifying_count and the score
    # average must not.
    snap = _snapshot_from_scores({"A": {4: 100.0}, "B": {4: 0.0}})
    group_members = {"Sector :: Group": {"A", "B", "D"}}

    sector_snap = ms.compute_sector_momentum_scores(snap, group_members)

    row = sector_snap.rows[0]
    assert row.member_count == 3
    assert row.qualifying_count == 2
    assert row.scores[4] == pytest.approx(50.0)


def test_compute_sector_momentum_scores_zero_qualifying_members_gives_none_not_dropped():
    snap = _snapshot_from_scores({"A": {4: 100.0}})
    group_members = {"Sector :: Empty": {"X", "Y"}}  # neither is in the snapshot at all

    sector_snap = ms.compute_sector_momentum_scores(snap, group_members)

    assert len(sector_snap.rows) == 1
    row = sector_snap.rows[0]
    assert row.qualifying_count == 0
    assert row.member_count == 2
    assert row.scores[4] is None


def test_compute_sector_momentum_scores_partial_lookback_coverage_per_member():
    # "A" is missing a 13w score (e.g. it was eligible for 4w but not yet for 13w) -- the 13w
    # sector average must only include "B", not treat A's missing value as 0.
    snap = _snapshot_from_scores(
        {
            "A": {4: 100.0, 13: None, 26: 100.0},
            "B": {4: 0.0, 13: 40.0, 26: 0.0},
        }
    )
    group_members = {"Sector :: Group": {"A", "B"}}

    sector_snap = ms.compute_sector_momentum_scores(snap, group_members)

    row = sector_snap.rows[0]
    assert row.scores[4] == pytest.approx(50.0)
    assert row.scores[13] == pytest.approx(40.0)  # only B counts
    assert row.scores[26] == pytest.approx(50.0)


# --------------------------------------------------------------------------
# load_stock_group_info: sanity check against the real committed curated file (mirrors
# test_broad.py's own test_load_stock_groups_reads_real_curated_file).
# --------------------------------------------------------------------------


def test_load_stock_group_info_reads_real_curated_file():
    curated_dir = (
        Path(__file__).resolve().parents[2]
        / "src"
        / "momentum_backtesting"
        / "categories"
        / "curated"
    )
    info = ms.load_stock_group_info(curated_dir)
    assert len(info) > 0
    sample = next(iter(info.values()))
    assert sample.company_name
    assert sample.parent_group
    assert sample.subgroup
