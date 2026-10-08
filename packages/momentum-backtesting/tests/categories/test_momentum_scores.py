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


# --------------------------------------------------------------------------
# BL-049: the composite rank, per-stock statistics, breadth, tags and the payload.
# --------------------------------------------------------------------------


def _series(n: int, start: float, weekly: float) -> list[float]:
    return [start * (1 + weekly) ** i for i in range(n)]


def _long_universe(**kwargs) -> broad.StockUniverseFrame:
    """90 weeks, five stocks with clearly different, steady weekly drifts (so every rank is
    unambiguous): A the strongest .. E the weakest."""
    n = 90
    return _make_universe(
        {
            "A": _series(n, 100, 0.012),
            "B": _series(n, 100, 0.008),
            "C": _series(n, 100, 0.004),
            "D": _series(n, 100, 0.0),
            "E": _series(n, 100, -0.004),
        },
        **kwargs,
    )


def test_composite_rank_is_the_engines_own_ranksum_this_week_and_last():
    from momentum_backtesting import engine

    universe = _long_universe()
    snap = ms.compute_stock_momentum_scores(universe, {})
    ranks, _ = engine.compute_ranks(universe.frame, engine.Config())
    by_symbol = {r.symbol: r for r in snap.rows}
    for symbol in "ABCDE":
        assert by_symbol[symbol].composite_rank == int(ranks.iloc[-1][symbol])
        assert by_symbol[symbol].composite_rank_prev == int(ranks.iloc[-2][symbol])
    assert [by_symbol[s].composite_rank for s in "ABCDE"] == [1, 2, 3, 4, 5]
    assert snap.ranked_count == 5


def test_composite_rank_is_among_the_members_of_that_week_only():
    # E is not a member at the last week: the others are ranked without it, and last week's
    # ranks (when it still was one) include it.
    universe = _long_universe(not_a_member_at_end={"E"})
    snap = ms.compute_stock_momentum_scores(universe, {})
    by_symbol = {r.symbol: r for r in snap.rows}
    assert "E" not in by_symbol
    assert snap.ranked_count == 4
    assert [by_symbol[s].composite_rank for s in "ABCD"] == [1, 2, 3, 4]
    assert [by_symbol[s].composite_rank_prev for s in "ABCD"] == [1, 2, 3, 4]


def test_a_stock_without_a_full_year_of_history_has_no_rank_and_no_year_statistics():
    n = 90
    prices = {"OLD": _series(n, 100, 0.01), "NEW": [float("nan")] * 60 + _series(30, 100, 0.02)}
    snap = ms.compute_stock_momentum_scores(_make_universe(prices), {})
    new = {r.symbol: r for r in snap.rows}["NEW"]
    assert new.composite_rank is None and new.composite_rank_prev is None
    assert new.high_52w_gap is None and new.volatility_52w is None
    assert new.above_ma40 is None  # 30 closes, a 40-week average needs 40
    assert new.up_weeks_26 == pytest.approx(1.0)  # 30 closes cover 26 weekly returns
    assert len(new.spark) == 26


def test_price_statistics_match_hand_arithmetic():
    n = 90
    # Rises 1%/week to week 70, then falls 2%/week: the 52-week high is week 70's close.
    prices = _series(71, 100, 0.01) + [
        _series(71, 100, 0.01)[-1] * 0.98 ** (i + 1) for i in range(n - 71)
    ]
    row = ms.compute_stock_momentum_scores(_make_universe({"X": prices}), {}).rows[0]
    peak = max(prices[-53:])
    assert peak == pytest.approx(prices[70])
    assert row.high_52w_gap == pytest.approx(prices[-1] / peak - 1)
    assert row.above_ma40 == pytest.approx(prices[-1] / (sum(prices[-40:]) / 40) - 1)
    weekly = pd.Series(prices[-53:]).pct_change().dropna()
    assert row.volatility_52w == pytest.approx(weekly.std() * 52**0.5)
    # Weeks 65..70 rose, 71..89 fell: of the last 26 weekly returns (weeks 64..89) 7 are up.
    assert row.up_weeks_26 == pytest.approx(7 / 26)
    assert row.spark[0] == pytest.approx(100.0)
    assert row.spark[-1] == pytest.approx(prices[-1] / prices[-26] * 100)


def test_breadth_counts_members_above_their_40_week_average_now_and_before():
    n = 90
    # RISER is always above its 40-week average; FALLER always below. TURNER rises until week 87,
    # dips 5% at week 88 (still above its average) and falls 40% at week 89 (below it).
    peak = 100 * 1.01**87
    turner = _series(88, 100, 0.01) + [peak * 0.95, peak * 0.60]
    universe = _make_universe(
        {"RISER": _series(n, 100, 0.01), "FALLER": _series(n, 100, -0.01), "TURNER": turner}
    )
    breadth = ms.compute_stock_momentum_scores(universe, {}).breadth
    assert breadth is not None
    assert breadth.above_ma40["now"] == pytest.approx(1 / 3)
    assert breadth.above_ma40["week_ago"] == pytest.approx(2 / 3)
    assert breadth.above_ma40["month_ago"] == pytest.approx(2 / 3)
    assert breadth.positive_13w["now"] == pytest.approx(1 / 3)
    assert breadth.positive_13w["week_ago"] == pytest.approx(2 / 3)


def test_breadth_on_a_short_history_is_none_not_an_error():
    snap = ms.compute_stock_momentum_scores(_make_universe({"A": [100.0] * 10}), {})
    assert snap.breadth is not None
    assert snap.breadth.above_ma40["now"] is None
    assert snap.breadth.median_26w is None


def test_a_stock_tagged_to_a_sector_and_a_theme_names_the_sector(tmp_path):
    (tmp_path / broad.STOCK_GROUPS_FILENAME).write_text(
        "parent_group,subgroup,symbol,company_name,note\n"
        "Cross-Sector Themes,PSU / CPSE Stocks,SBIN,State Bank of India,\n"
        "Financials,PSU Banks,SBIN,State Bank of India,\n"
        "Cross-Sector Themes,PSU / CPSE Stocks,ONLYTHEME,Only Theme Ltd,\n"
        "Healthcare,Hospitals,APOLLO,Apollo Hospitals,\n"
    )
    info = ms.load_stock_group_info(tmp_path)
    assert (info["SBIN"].parent_group, info["SBIN"].subgroup) == ("Financials", "PSU Banks")
    assert info["SBIN"].tags == (
        ("Cross-Sector Themes", "PSU / CPSE Stocks"),
        ("Financials", "PSU Banks"),
    )
    # A stock that is only in a theme keeps it; a single-tag stock has one tag.
    assert info["ONLYTHEME"].parent_group == "Cross-Sector Themes"
    assert info["APOLLO"].tags == (("Healthcare", "Hospitals"),)


def test_the_payload_is_rounded_json_with_no_nan():
    import json

    universe = _long_universe()
    stock = ms.compute_stock_momentum_scores(universe, {})
    sector = ms.compute_sector_momentum_scores(stock, {"Sector :: Group": {"A", "B", "Z"}})
    payload = ms.to_payload(stock, sector, missing_symbols=["Q"], membership_quality=None)
    text = json.dumps(payload, allow_nan=False)  # raises on NaN / inf
    assert payload["lookbacks"] == [1, 2, 4, 8, 13, 26, 52]
    assert payload["ranked_count"] == 5 and payload["missing_symbols"] == ["Q"]
    a = {s["symbol"]: s for s in payload["stocks"]}["A"]
    assert a["composite_rank"] == 1 and a["composite_rank_prev"] == 1
    assert set(a["scores"]) == {"1", "2", "4", "8", "13", "26", "52"}
    assert a["scores"]["26"] == 100.0 and len(a["spark"]) == 26
    assert a["returns"]["13"] == round(a["returns"]["13"], 4)
    assert payload["sectors"][0]["qualifying_count"] == 2
    assert len(text) < 20_000


# --------------------------------------------------------------------------
# BL-049 Phase 2: scores week by week, the rotation map's groups and the stock drawer.
# --------------------------------------------------------------------------


def _ten_stocks(**kwargs) -> broad.StockUniverseFrame:
    n = 90
    return _make_universe(
        {f"S{i}": _series(n, 100, 0.012 - i * 0.002) for i in range(10)}, **kwargs
    )


def test_weekly_percentile_scores_equal_the_single_week_scores_for_every_week():
    universe = _ten_stocks()
    table = ms.weekly_percentile_scores(universe, 13, 5)
    assert len(table.index) == 5
    frame = universe.frame
    for week in table.index:
        pos = frame.index.get_loc(week)
        expected = ms._percentile_scores(frame.iloc[pos] / frame.iloc[pos - 13] - 1)
        assert table.loc[week].dropna().to_dict() == pytest.approx(expected.to_dict())


def test_weekly_percentile_scores_rank_only_that_weeks_members():
    universe = _ten_stocks(not_a_member_at_end={"S0"})
    table = ms.weekly_percentile_scores(universe, 13, 2)
    last, before = table.iloc[-1], table.iloc[-2]
    assert pd.isna(last["S0"]) and not pd.isna(before["S0"])
    # Ranked among nine at the last week, ten the week before.
    assert last.max() == pytest.approx(100.0) and last.min() == pytest.approx(0.0)
    assert before["S1"] == pytest.approx(
        ms._percentile_scores(universe.frame.iloc[-2] / universe.frame.iloc[-15] - 1)["S1"]
    )


def test_rotation_averages_each_groups_members_and_counts_a_stock_once_per_parent():
    universe = _ten_stocks()
    members = {
        "Fin :: Banks": {"S0", "S1", "S2"},
        "Fin :: Insurance": {"S2", "S3"},  # S2 is in both sub-sectors of one parent
        "Cross-Sector Themes :: PSU": {"S9"},
        "Health :: Pharma": {"S8", "NOT_IN_FRAME"},
    }
    rotation = ms.compute_rotation(universe, members)
    assert len(rotation.weeks) == ms.HISTORY_WEEKS
    assert rotation.weeks[-1] == universe.frame.index[-1].strftime("%Y-%m-%d")
    parents = {g.key: g for g in rotation.groups}
    assert set(parents) == {"Fin", "Cross-Sector Themes", "Health"}
    assert parents["Fin"].member_count == 4  # S0 S1 S2 S3: S2 once
    assert parents["Cross-Sector Themes"].theme and not parents["Fin"].theme
    scores26 = ms._by_symbol(ms.weekly_percentile_scores(universe, 26, ms.HISTORY_WEEKS), universe)
    expected = scores26[["S0", "S1", "S2", "S3"]].mean(axis=1).iloc[-1]
    assert parents["Fin"].s26[-1] == pytest.approx(expected)
    subs = {g.key: g for g in rotation.subs}
    assert subs["Fin :: Banks"].subgroup == "Banks" and subs["Fin :: Banks"].parent_group == "Fin"
    assert subs["Fin :: Banks"].scored_count == 3
    assert subs["Health :: Pharma"].scored_count == 1  # the unknown symbol is not counted
    assert len(subs["Fin :: Banks"].s4) == ms.HISTORY_WEEKS


def test_rotation_has_no_scores_before_there_is_history():
    universe = _make_universe({f"S{i}": _series(20, 100, 0.01 * i) for i in range(1, 4)})
    group = ms.compute_rotation(universe, {"P :: G": {"S1", "S2", "S3"}}).subs[0]
    assert all(v is None for v in group.s26)  # 20 weeks cannot score a 26-week return
    assert group.scored_count == 0


def test_composite_rank_history_matches_the_single_week_ranks_and_is_kept():
    universe = _ten_stocks()
    table = ms.composite_rank_history(universe, weeks=6)
    assert len(table.index) == 6 and list(table.columns) == sorted(table.columns)
    for week in table.index:
        pos = universe.frame.index.get_loc(week)
        expected = ms._composite_ranks(universe.frame, pos, list(universe.frame.columns))
        assert {s: int(r) for s, r in table.loc[week].dropna().items()} == expected
    assert ms.composite_rank_history(universe, weeks=6) is table  # same frame: not rebuilt
    assert ms.composite_rank_history(_ten_stocks(), weeks=6) is not table  # a new frame is


def test_composite_rank_history_is_kept_per_week_count():
    universe = _ten_stocks()
    six = ms.composite_rank_history(universe, weeks=6)
    four = ms.composite_rank_history(universe, weeks=4)
    assert len(six.index) == 6 and len(four.index) == 4  # not the first call's table again


def test_universe_memo_builds_once_per_frame_and_key_and_does_not_keep_a_dead_frame():
    import gc
    import weakref

    memo = ms.UniverseMemo()
    universe = _ten_stocks()
    built: list[int] = []

    def build():
        built.append(1)
        return object()

    first = memo.get(universe, "a", build)
    assert memo.get(universe, "a", build) is first and len(built) == 1
    assert memo.get(universe, "b", build) is not first and len(built) == 2  # another key
    ref = weakref.ref(universe)
    del universe
    gc.collect()
    assert ref() is None  # the memo does not pin the replaced frame


def test_stock_detail_gives_closes_average_scores_and_ranks():
    universe = _ten_stocks()
    detail = ms.stock_detail(universe, "S3")
    assert detail is not None
    closes = universe.frame["S3"]
    assert len(detail["closes"]) == 53 == len(detail["weeks"])
    assert detail["closes"][-1] == pytest.approx(closes.iloc[-1], abs=0.01)
    assert detail["ma40"][-1] == pytest.approx(closes.iloc[-40:].mean(), abs=0.01)
    assert set(detail["scores"]) == {str(k) for k in ms.DEFAULT_LOOKBACKS}
    assert len(detail["score_weeks"]) == ms.DRAWER_SCORE_WEEKS
    assert detail["scores"]["13"][-1] == pytest.approx(
        ms.weekly_percentile_scores(universe, 13, 1)["S3"].iloc[-1], abs=0.1
    )
    assert len(detail["ranks"]) == ms.DRAWER_RANK_WEEKS == len(detail["rank_weeks"])
    assert detail["ranks"][-1] == 4  # the fourth strongest drift of ten


def test_stock_detail_is_none_for_an_unknown_or_non_member_symbol():
    universe = _ten_stocks(not_a_member_at_end={"S0"})
    assert ms.stock_detail(universe, "S0") is None
    assert ms.stock_detail(universe, "NOPE") is None


def test_the_payload_carries_the_rotation_as_json():
    import json

    universe = _ten_stocks()
    stock = ms.compute_stock_momentum_scores(universe, {})
    members = {"Fin :: Banks": {"S0", "S1", "S2"}}
    sector = ms.compute_sector_momentum_scores(stock, members)
    payload = ms.to_payload(
        stock,
        sector,
        missing_symbols=[],
        membership_quality=None,
        rotation=ms.compute_rotation(universe, members),
    )
    json.dumps(payload, allow_nan=False)
    rotation = payload["rotation"]
    assert len(rotation["weeks"]) == ms.HISTORY_WEEKS
    assert rotation["groups"][0]["key"] == "Fin" and rotation["subs"][0]["key"] == "Fin :: Banks"
    assert rotation["subs"][0]["scored_count"] == 3


def test_live_column_names_the_column_of_a_live_member_only():
    universe = _ten_stocks(not_a_member_at_end={"S0"})
    assert ms.live_column(universe, "S3") == "S3"
    assert ms.live_column(universe, "S0") is None  # left the universe at the latest week
    assert ms.live_column(universe, "NOPE") is None
