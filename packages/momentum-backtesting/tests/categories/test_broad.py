"""categories/broad.py: the pure, non-network pieces of the "Broad Momentum" feature
(TODO.md 3.9.13) -- Step 1's point-in-time membership resolution (mirroring
test_snapshots.py's own shape, for the generic-fallback fix this task made), the generic
top_n/exit_rank hysteresis helper, the quarterly-rebalance helper, and Step 3's category-
selection pure function on hand-built rank fixtures. No network, no real data/ files.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import pandas as pd
import pytest

from momentum_backtesting.categories import broad, snapshots, sources
from momentum_backtesting.categories.sources import BASE_URL
from momentum_backtesting.stocks.nse import NseClient

# --------------------------------------------------------------------------
# Step 1: the CONSTANT_CURRENT fallback must work for a (label, slug) pair that is NOT one of
# sources.CATEGORY_SLUGS's 16 sector categories -- e.g. "Total Market" -- this was a real bug
# found during implementation (build_category_year_membership's fallback called
# sources.fetch_category_current, which re-derives the slug from CATEGORY_SLUGS and silently
# returns None for any unmapped category, ignoring the slug this function was actually given).
# --------------------------------------------------------------------------

_TOTAL_MARKET_URL = f"{BASE_URL}/ind_{sources.TOTAL_MARKET_SLUG}.csv"

_CSV_BODY = (
    b"Company Name,Industry,Symbol,Series,ISIN Code\r\n"
    b"Reliance Industries Ltd.,Oil Gas & Consumable Fuels,RELIANCE,EQ,INE002A01018\r\n"
    b"Tata Consultancy Services Ltd.,Information Technology,TCS,EQ,INE467B01029\r\n"
)


class _FakeResponse:
    def __init__(self, body: bytes):
        self._buf = io.BytesIO(body)

    def read(self, n: int = -1) -> bytes:
        return self._buf.read(n)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _dispatching_client(rules: list[tuple[str, bytes]]) -> NseClient:
    client = NseClient()

    def fake_open(req, timeout=None):  # noqa: ARG001
        for substring, body in rules:
            if substring in req.full_url:
                return _FakeResponse(body)
        raise AssertionError(f"no rule matched {req.full_url}")

    client._opener.open = fake_open
    return client


def test_build_category_year_membership_constant_current_works_for_an_unmapped_slug():
    """ "Total Market" is not in sources.CATEGORY_SLUGS at all -- the CONSTANT_CURRENT fallback
    (zero Wayback history) must still resolve it via the SLUG this function was given, not via
    a CATEGORY_SLUGS lookup keyed on the category label."""
    empty_cdx = json.dumps([]).encode("utf-8")
    client = _dispatching_client([(snapshots.CDX_URL, empty_cdx), (_TOTAL_MARKET_URL, _CSV_BODY)])

    rows, reports = snapshots.build_category_year_membership(
        "Total Market", sources.TOTAL_MARKET_SLUG, [2020, 2021], client
    )

    row_df = pd.DataFrame(rows)
    assert set(row_df.loc[row_df["year"] == 2020, "symbol"]) == {"RELIANCE", "TCS"}
    assert set(row_df.loc[row_df["year"] == 2021, "symbol"]) == {"RELIANCE", "TCS"}
    assert (row_df["source_tier"] == snapshots.SourceTier.CONSTANT_CURRENT.value).all()
    assert len(reports) == 2


def test_run_fetch_total_market_writes_both_csvs(tmp_path):
    empty_cdx = json.dumps([]).encode("utf-8")
    client = _dispatching_client([(snapshots.CDX_URL, empty_cdx), (_TOTAL_MARKET_URL, _CSV_BODY)])

    summary = broad.run_fetch_total_market(tmp_path, client, [2019])

    assert summary.rows_written == 2
    assert summary.tier_counts == {"constant_current": 1}  # 1 report row (1 requested year)
    membership_path = tmp_path / broad.TOTAL_MARKET_MEMBERSHIP_FILENAME
    report_path = tmp_path / broad.TOTAL_MARKET_FETCH_REPORT_FILENAME
    assert membership_path.exists()
    assert report_path.exists()

    members = broad.total_market_members_by_year(tmp_path)
    assert members == {2019: {"RELIANCE", "TCS"}}


def test_total_market_members_by_year_raises_when_file_missing(tmp_path):
    with pytest.raises(broad.TotalMarketDataNotFoundError):
        broad.total_market_members_by_year(tmp_path)


# --------------------------------------------------------------------------
# apply_hysteresis: the generic top_n/exit_rank buffer, shared by Step 2's pool cut and Step 3's
# category cut.
# --------------------------------------------------------------------------


def test_apply_hysteresis_fresh_entry_within_top_n():
    held = broad.apply_hysteresis([], ["A", "B", "C"], top_n=2, exit_rank=4)
    assert held == ["A", "B"]


def test_apply_hysteresis_never_held_name_outside_top_n_does_not_enter():
    # "C" is ranked 3rd (inside exit_rank=4) but was never held before, and top_n=2 -- it must
    # NOT enter just because it's inside the exit band. Only a name that already IS held gets
    # the benefit of the wider exit_rank buffer.
    held = broad.apply_hysteresis([], ["A", "B", "C", "D"], top_n=2, exit_rank=4)
    assert held == ["A", "B"]


def test_apply_hysteresis_holds_a_previously_held_name_past_top_n_until_exit_rank():
    # "C" was held; this period it ranks 3rd (outside top_n=2, inside exit_rank=4) -- stays held.
    held = broad.apply_hysteresis(["C"], ["A", "B", "C", "D"], top_n=2, exit_rank=4)
    assert held == ["A", "B", "C"]


def test_apply_hysteresis_drops_a_held_name_once_it_crosses_exit_rank():
    # "Z" was held; this period it ranks 5th, past exit_rank=4 -- dropped.
    held = broad.apply_hysteresis(["Z"], ["A", "B", "C", "D", "Z"], top_n=2, exit_rank=4)
    assert held == ["A", "B"]


def test_apply_hysteresis_a_name_missing_from_the_ranked_list_entirely_is_dropped():
    # "Z" was held but isn't ranked at all this period (e.g. it fell below the coverage floor,
    # or the whole category vanished) -- must be dropped, not KeyError.
    held = broad.apply_hysteresis(["Z"], ["A", "B"], top_n=2, exit_rank=4)
    assert held == ["A", "B"]


def test_apply_hysteresis_never_exceeds_exit_rank_size():
    held = broad.apply_hysteresis(
        ["A", "B", "C", "D"], ["E", "F", "A", "B", "C", "D"], top_n=2, exit_rank=4
    )
    assert len(held) <= 4


# --------------------------------------------------------------------------
# _quarter_end_weeks
# --------------------------------------------------------------------------


def test_quarter_end_weeks_picks_the_last_friday_of_each_calendar_quarter():
    weeks = list(pd.date_range("2023-01-06", "2023-08-04", freq="W-FRI"))
    ends = broad._quarter_end_weeks(weeks)
    # Q1 2023 ends 2023-03-31 (a Friday); Q2 ends 2023-06-30 (a Friday).
    assert pd.Timestamp("2023-03-31") in ends
    assert pd.Timestamp("2023-06-30") in ends
    # The very last week in the list is always included (partial/ongoing quarter).
    assert weeks[-1] in ends
    # Strictly increasing, no duplicates.
    assert ends == sorted(set(ends))


def test_quarter_end_weeks_empty_input():
    assert broad._quarter_end_weeks([]) == []


# --------------------------------------------------------------------------
# score_categories: coverage floor + atomic scoring.
# --------------------------------------------------------------------------


def test_score_categories_excludes_a_category_below_the_coverage_floor():
    row = pd.Series({"A": 1.0, "B": 2.0, "C": 3.0})
    group_members = {"thin": {"A", "X", "Y", "Z"}}  # only 1 of 4 members qualifies -> 25%
    scores = broad.score_categories(row, group_members, atomic_names=(), coverage_floor=0.4)
    assert "thin" not in scores


def test_score_categories_includes_a_category_at_or_above_the_coverage_floor():
    row = pd.Series({"A": 1.0, "B": 2.0})
    group_members = {"ok": {"A", "B", "X"}}  # 2 of 3 -> 66.7%, clears a 50% floor
    scores = broad.score_categories(row, group_members, atomic_names=(), coverage_floor=0.5)
    assert scores["ok"] == pytest.approx((1.0 + 2.0) / 2)


def test_score_categories_zero_qualifying_members_is_the_extreme_case_of_the_floor():
    row = pd.Series({"A": 1.0})
    group_members = {"empty": {"X", "Y"}}  # none of these are in `row` at all
    scores = broad.score_categories(row, group_members, atomic_names=(), coverage_floor=0.0)
    assert "empty" not in scores


def test_score_categories_atomic_uses_its_own_value_directly():
    row = pd.Series({"Gold": 3.0})
    scores = broad.score_categories(row, {}, atomic_names=("Gold", "Silver"), coverage_floor=0.4)
    assert scores == {"Gold": 3.0}
    assert "Silver" not in scores  # not present in the row this week -> no valid rank


# --------------------------------------------------------------------------
# compute_category_selection: multi-period hysteresis sequence, incl. coverage floor and an
# atomic outranking every real category.
# --------------------------------------------------------------------------


def test_compute_category_selection_hysteresis_and_atomic_competition():
    weeks = [pd.Timestamp(f"2023-01-{d:02d}") for d in (6, 13, 20, 27)]
    group_members = {
        "steady": {"A1", "A2"},
        "flaky": {"B1", "B2"},  # will dip below the coverage floor in week 3
    }
    # week1: steady best (avg 1.5), flaky ok (avg 3.5), Gold weak (10) -> steady, flaky both in
    #        (top_n=1 picks steady; flaky enters top_n range too if top_n>=2 -- use top_n=1,
    #        exit_rank=2 so only 1 enters fresh but 2 may be HELD once already in).
    rows = {
        weeks[0]: pd.Series({"A1": 1.0, "A2": 2.0, "B1": 3.0, "B2": 4.0, "Gold": 10.0}),
        # week2: flaky becomes best; steady drops to 2nd (still <= exit_rank=2, held).
        weeks[1]: pd.Series({"A1": 5.0, "A2": 6.0, "B1": 1.0, "B2": 2.0, "Gold": 10.0}),
        # week3: flaky loses coverage (only B1 present) -> excluded entirely at a 0.6 floor.
        # steady still ranks well enough (its own avg becomes the best available) to be re-held.
        weeks[2]: pd.Series({"A1": 1.0, "A2": 2.0, "B1": 3.0, "Gold": 10.0}),
        # week4: Gold now has the best score of anything -> outranks every real category.
        weeks[3]: pd.Series({"A1": 5.0, "A2": 6.0, "B1": 3.0, "B2": 4.0, "Gold": 0.5}),
    }
    combined_pool_ranks = pd.DataFrame(rows).T

    held_by_week = broad.compute_category_selection(
        combined_pool_ranks,
        group_members,
        weeks,
        atomic_names=("Gold",),
        coverage_floor=0.6,
        top_n=1,
        exit_rank=2,
    )

    assert held_by_week[weeks[0]] == ["steady"]
    # flaky enters fresh (rank 1 this week) while steady, previously held, stays inside exit_rank
    assert held_by_week[weeks[1]] == ["flaky", "steady"]
    # flaky drops below the coverage floor -> excluded entirely, steady remains the sole holding
    assert held_by_week[weeks[2]] == ["steady"]
    # Gold's own score (0.5) is now the best of anything -> becomes the fresh pick
    assert held_by_week[weeks[3]][0] == "Gold"


# --------------------------------------------------------------------------
# build_effective_stock_ranks: bucket math (fresh vs lingering) + atomic single-slot gap.
# --------------------------------------------------------------------------


def test_build_effective_stock_ranks_fresh_and_lingering_buckets():
    weeks = [pd.Timestamp("2023-01-06")]
    group_members = {"cat1": {"S1", "S2", "S3"}, "cat2": {"T1", "T2"}}
    row = pd.Series({"S1": 1.0, "S2": 2.0, "S3": 3.0, "T1": 4.0, "T2": 5.0, "Gold": 6.0})
    combined_pool_ranks = pd.DataFrame([row], index=weeks)

    # held order: cat1 (fresh, position 1), Gold (fresh, position 2), cat2 (lingering, position 3)
    held_by_week = {weeks[0]: ["cat1", "Gold", "cat2"]}

    result = broad.build_effective_stock_ranks(
        held_by_week,
        combined_pool_ranks,
        group_members,
        weeks,
        columns=["S1", "S2", "S3", "T1", "T2", "Gold"],
        atomic_names=("Gold",),
        category_top_n=2,
        category_exit_rank=3,
        picks_per_category=2,
    )

    assert result.top_n == 4  # category_top_n(2) * picks_per_category(2)
    assert result.exit_rank == 6  # category_exit_rank(3) * picks_per_category(2)

    week_ranks = result.ranks.loc[weeks[0]]
    # cat1 (position 1, fresh): its top-2 by rank are S1 (1.0) and S2 (2.0) -> ranks 1, 2.
    assert week_ranks["S1"] == 1
    assert week_ranks["S2"] == 2
    assert pd.isna(week_ranks["S3"])  # not in the top-2 picks for its category
    # Gold (position 2, fresh, atomic): occupies only its own first slot -> rank 3; its second
    # reserved slot (rank 4) is simply unused (a gap), not filled by anything else.
    assert week_ranks["Gold"] == 3
    # cat2 (position 3, lingering): its top-2 (T1, T2) land in the lingering bucket (ranks 5, 6).
    assert week_ranks["T1"] == 5
    assert week_ranks["T2"] == 6

    # Every fresh-bucket rank is <= top_n, every lingering-bucket rank is > top_n and <= exit_rank.
    for name in ("S1", "S2", "Gold"):
        assert week_ranks[name] <= result.top_n
    for name in ("T1", "T2"):
        assert result.top_n < week_ranks[name] <= result.exit_rank


def test_build_effective_stock_ranks_shared_stock_keeps_its_better_category_rank():
    """S1 is tagged to both held categories. It must keep the fresh rank it gets as cat1's top
    pick, not be overwritten with the lingering rank it would get through cat2."""
    weeks = [pd.Timestamp("2023-01-06")]
    group_members = {"cat1": {"S1", "S2"}, "cat2": {"S1", "T1"}}
    row = pd.Series({"S1": 1.0, "S2": 2.0, "T1": 3.0})
    result = broad.build_effective_stock_ranks(
        {weeks[0]: ["cat1", "cat2"]},
        pd.DataFrame([row], index=weeks),
        group_members,
        weeks,
        columns=["S1", "S2", "T1"],
        atomic_names=(),
        category_top_n=1,
        category_exit_rank=2,
        picks_per_category=2,
    )
    week_ranks = result.ranks.loc[weeks[0]]
    assert week_ranks["S1"] == 1  # cat1, fresh, slot 1 - not 3 (cat2, lingering, slot 1)
    assert week_ranks["S2"] == 2
    assert week_ranks["T1"] == 4  # cat2's second pick keeps its own reserved slot
    assert result.groups.loc[weeks[0], "S1"] == "cat1"


def test_build_effective_stock_ranks_empty_held_produces_all_nan():
    weeks = [pd.Timestamp("2023-01-06")]
    row = pd.Series({"S1": 1.0})
    combined_pool_ranks = pd.DataFrame([row], index=weeks)
    result = broad.build_effective_stock_ranks(
        {weeks[0]: []}, combined_pool_ranks, {}, weeks, columns=["S1"]
    )
    assert result.ranks.loc[weeks[0], "S1"] != result.ranks.loc[weeks[0], "S1"]  # NaN


def test_build_off_mode_ranks_passthrough():
    weeks = [pd.Timestamp("2023-01-06")]
    stock_pool_ranks = pd.DataFrame([{"S1": 1.0, "S2": 2.0}], index=weeks)
    result = broad.build_off_mode_ranks(stock_pool_ranks, top_n=5, exit_rank=10)
    assert result.ranks is stock_pool_ranks
    assert result.top_n == 5
    assert result.exit_rank == 10


# --------------------------------------------------------------------------
# compute_category_selection_mass_exit (TODO.md 3.9.20): the mass-exit trigger itself, on
# hand-built fixtures using bare atomics (no real category/coverage-floor machinery needed to
# isolate the trigger logic - group_members stays empty throughout).
# --------------------------------------------------------------------------

_ATOMICS_4 = ("C1", "C2", "C3", "C4")


def test_mass_exit_trigger_never_fires_on_the_first_week():
    """prev_held is empty coming into the very first week - there's nothing to have exited yet."""
    weeks = [pd.Timestamp("2023-01-06")]
    row = pd.Series({"C1": 1.0, "C2": 2.0, "C3": 3.0, "C4": 4.0})
    combined_pool_ranks = pd.DataFrame([row], index=weeks)

    selection = broad.compute_category_selection_mass_exit(
        combined_pool_ranks,
        {},
        weeks,
        atomic_names=_ATOMICS_4,
        coverage_floor=0.0,
        top_n=4,
        exit_rank=4,
    )
    assert selection.mass_exit_weeks == frozenset()
    assert selection.held_by_week[weeks[0]] == ["C1", "C2", "C3", "C4"]


def test_mass_exit_trigger_does_not_fire_at_exactly_half():
    """Exactly half of the previously-held names exiting is NOT '>half' - the boundary is
    strict, matching the brief's own '>50%' wording, not '>=50%'."""
    weeks = [pd.Timestamp("2023-01-06"), pd.Timestamp("2023-01-13")]
    rows = {
        weeks[0]: pd.Series({"C1": 1.0, "C2": 2.0, "C3": 3.0, "C4": 4.0}),
        # C3, C4 drop out of the ranking entirely this week (absent -> ineligible -> exited,
        # same "missing = dropped" semantics apply_hysteresis already uses). Exactly 2 of the 4
        # previously-held names exit.
        weeks[1]: pd.Series({"C1": 1.0, "C2": 2.0}),
    }
    combined_pool_ranks = pd.DataFrame(rows).T

    selection = broad.compute_category_selection_mass_exit(
        combined_pool_ranks,
        {},
        weeks,
        atomic_names=_ATOMICS_4,
        coverage_floor=0.0,
        top_n=4,
        exit_rank=4,
    )
    assert selection.mass_exit_weeks == frozenset()  # 2/4 = 50%, not > 50%
    assert selection.held_by_week[weeks[1]] == ["C1", "C2"]


def test_mass_exit_trigger_fires_just_over_half():
    """Same shape as the boundary test above, but 3 of 4 (75%) exit instead of 2 of 4 (50%)."""
    weeks = [pd.Timestamp("2023-01-06"), pd.Timestamp("2023-01-13")]
    rows = {
        weeks[0]: pd.Series({"C1": 1.0, "C2": 2.0, "C3": 3.0, "C4": 4.0}),
        weeks[1]: pd.Series({"C1": 1.0}),  # C2, C3, C4 all drop out -> 3 of 4 exit
    }
    combined_pool_ranks = pd.DataFrame(rows).T

    selection = broad.compute_category_selection_mass_exit(
        combined_pool_ranks,
        {},
        weeks,
        atomic_names=_ATOMICS_4,
        coverage_floor=0.0,
        top_n=4,
        exit_rank=4,
    )
    assert selection.mass_exit_weeks == frozenset({weeks[1]})
    assert weeks[0] not in selection.mass_exit_weeks


def test_mass_exit_trigger_threshold_is_configurable():
    """A stricter threshold (e.g. 0.75) means the same 3-of-4 (75%) exit no longer fires, since
    75% is not STRICTLY greater than 75%."""
    weeks = [pd.Timestamp("2023-01-06"), pd.Timestamp("2023-01-13")]
    rows = {
        weeks[0]: pd.Series({"C1": 1.0, "C2": 2.0, "C3": 3.0, "C4": 4.0}),
        weeks[1]: pd.Series({"C1": 1.0}),
    }
    combined_pool_ranks = pd.DataFrame(rows).T

    selection = broad.compute_category_selection_mass_exit(
        combined_pool_ranks,
        {},
        weeks,
        atomic_names=_ATOMICS_4,
        coverage_floor=0.0,
        top_n=4,
        exit_rank=4,
        mass_exit_threshold=0.75,
    )
    assert selection.mass_exit_weeks == frozenset()


def test_mass_exit_trigger_rejects_invalid_threshold_or_response():
    weeks = [pd.Timestamp("2023-01-06")]
    combined_pool_ranks = pd.DataFrame([pd.Series({"C1": 1.0})], index=weeks)
    with pytest.raises(ValueError, match="mass_exit_threshold"):
        broad.compute_category_selection_mass_exit(
            combined_pool_ranks, {}, weeks, atomic_names=("C1",), mass_exit_threshold=0.0
        )
    with pytest.raises(ValueError, match="mass_exit_threshold"):
        broad.compute_category_selection_mass_exit(
            combined_pool_ranks, {}, weeks, atomic_names=("C1",), mass_exit_threshold=1.0
        )
    with pytest.raises(ValueError, match="mass_exit_response"):
        broad.compute_category_selection_mass_exit(
            combined_pool_ranks, {}, weeks, atomic_names=("C1",), mass_exit_response="bogus"
        )


def test_mass_exit_off_and_throttle_response_see_identical_held_sets():
    """ "throttle" never changes which categories are admitted (only how much fresh capital
    engine.py later deploys) - "off" and "throttle" must produce byte-identical held_by_week and
    an identical trigger-week set."""
    weeks = [pd.Timestamp("2023-01-06"), pd.Timestamp("2023-01-13")]
    rows = {
        weeks[0]: pd.Series({"C1": 1.0, "C2": 2.0, "C3": 3.0, "C4": 4.0}),
        weeks[1]: pd.Series({"C1": 1.0}),
    }
    combined_pool_ranks = pd.DataFrame(rows).T

    off = broad.compute_category_selection_mass_exit(
        combined_pool_ranks,
        {},
        weeks,
        atomic_names=_ATOMICS_4,
        coverage_floor=0.0,
        top_n=4,
        exit_rank=4,
        mass_exit_response="off",
    )
    throttle = broad.compute_category_selection_mass_exit(
        combined_pool_ranks,
        {},
        weeks,
        atomic_names=_ATOMICS_4,
        coverage_floor=0.0,
        top_n=4,
        exit_rank=4,
        mass_exit_response="throttle",
    )
    assert off.held_by_week == throttle.held_by_week
    assert off.mass_exit_weeks == throttle.mass_exit_weeks == frozenset({weeks[1]})


def test_mass_exit_halve_top_n_admits_fewer_fresh_names_on_a_triggered_week():
    """The response variant that DOES change admission: on a week its own trigger fires, only
    ceil(top_n / 2) freshly-ranked names may enter (existing holdings are never force-sold - they
    still only leave via the unchanged exit_rank test)."""
    weeks = [pd.Timestamp("2023-01-06"), pd.Timestamp("2023-01-13")]
    atomic_names = tuple(f"C{i}" for i in range(1, 13))
    rows = {
        # Week 0: 8 eligible names competing for top_n=4 -> only C1-C4 admitted (fresh); C5-C8
        # were never held before and stay outside even though they're within exit_rank=8.
        weeks[0]: pd.Series({f"C{i}": float(i) for i in range(1, 9)}),
        # Week 1: C1-C4 (everything currently held) all drop out of the ranking entirely (100%
        # exit -> triggers), while 8 fresh candidates (C5-C12) compete for the open slots.
        weeks[1]: pd.Series({f"C{i}": float(i - 4) for i in range(5, 13)}),
    }
    combined_pool_ranks = pd.DataFrame(rows).T

    off = broad.compute_category_selection_mass_exit(
        combined_pool_ranks,
        {},
        weeks,
        atomic_names=atomic_names,
        coverage_floor=0.0,
        top_n=4,
        exit_rank=8,
        mass_exit_response="off",
    )
    halved = broad.compute_category_selection_mass_exit(
        combined_pool_ranks,
        {},
        weeks,
        atomic_names=atomic_names,
        coverage_floor=0.0,
        top_n=4,
        exit_rank=8,
        mass_exit_response="halve_top_n",
    )

    # Identical up to the point of divergence (week 0, and the trigger detection itself).
    assert off.held_by_week[weeks[0]] == halved.held_by_week[weeks[0]] == ["C1", "C2", "C3", "C4"]
    assert off.mass_exit_weeks == halved.mass_exit_weeks == frozenset({weeks[1]})

    # Week 1: "off" admits the full top_n=4 fresh names; "halve_top_n" admits only ceil(4/2)=2.
    assert off.held_by_week[weeks[1]] == ["C5", "C6", "C7", "C8"]
    assert halved.held_by_week[weeks[1]] == ["C5", "C6"]


def test_mass_exit_halve_top_n_never_forces_out_an_existing_holding_early():
    """Halving top_n only restricts FRESH admissions - a name already held keeps its own
    exit_rank-based survival test untouched, even on a week the trigger fires."""
    weeks = [pd.Timestamp("2023-01-06"), pd.Timestamp("2023-01-13")]
    atomic_names = ("C1", "C2", "C3", "C4", "C5", "C6")
    rows = {
        weeks[0]: pd.Series({"C1": 1.0, "C2": 2.0, "C3": 3.0, "C4": 4.0}),
        # C1 alone drops (25% exit -> below the 50% threshold, does NOT trigger) while C2-C4
        # remain well inside exit_rank=8 and should simply stay held, regardless of top_n.
        weeks[1]: pd.Series({"C2": 1.0, "C3": 2.0, "C4": 3.0}),
    }
    combined_pool_ranks = pd.DataFrame(rows).T
    halved = broad.compute_category_selection_mass_exit(
        combined_pool_ranks,
        {},
        weeks,
        atomic_names=atomic_names,
        coverage_floor=0.0,
        top_n=4,
        exit_rank=8,
        mass_exit_response="halve_top_n",
    )
    assert halved.mass_exit_weeks == frozenset()  # 1/4 = 25%, no trigger
    assert set(halved.held_by_week[weeks[1]]) == {"C2", "C3", "C4"}


# --------------------------------------------------------------------------
# load_stock_groups: reads the real, committed curated/stock_groups.csv.
# --------------------------------------------------------------------------


def test_load_stock_groups_reads_real_curated_file():
    curated_dir = (
        Path(__file__).resolve().parents[2]
        / "src"
        / "momentum_backtesting"
        / "categories"
        / "curated"
    )
    groups = broad.load_stock_groups(curated_dir)
    assert len(groups) > 0
    assert all(members for members in groups.values())
    # Spot check: every id is "parent :: subgroup" shaped.
    assert all(" :: " in cid for cid in groups)


# --------------------------------------------------------------------------
# Share-price ceiling: price_ceiling_mask (pure).
# --------------------------------------------------------------------------


def _price_frame() -> pd.DataFrame:
    weeks = pd.date_range("2024-01-05", periods=3, freq="W-FRI")
    return pd.DataFrame(
        {
            "CHEAP": [100.0, 110.0, 120.0],
            "MRF": [90_000.0, 95_000.0, 130_000.0],
            "EDGE": [19_000.0, 20_000.0, 21_000.0],
            "Gold": [70_000.0, 71_000.0, 72_000.0],  # an index level, not a share price
        },
        index=weeks,
    )


def test_price_ceiling_mask_is_off_without_a_positive_ceiling():
    assert broad.price_ceiling_mask(_price_frame(), None) is None
    assert broad.price_ceiling_mask(_price_frame(), 0) is None


def test_price_ceiling_mask_flags_stocks_strictly_above_it_and_exempts_atomics():
    over = broad.price_ceiling_mask(_price_frame(), 20_000)
    assert over["CHEAP"].tolist() == [False, False, False]
    assert over["MRF"].tolist() == [True, True, True]
    assert over["EDGE"].tolist() == [False, False, True]  # exactly at the ceiling is fine
    assert over["Gold"].tolist() == [False, False, False]


def test_price_ceiling_mask_is_point_in_time_not_a_permanent_label():
    prices = _price_frame()
    prices["LATE"] = [500.0, 15_000.0, 60_000.0]
    over = broad.price_ceiling_mask(prices, 20_000)
    assert over["LATE"].tolist() == [False, False, True]


def test_ordered_categories_by_week_matches_score_categories_week_by_week():
    """The array-maths ordering the selection loop now uses must equal the original per-week
    `score_categories` + (score, name) sort, including coverage floors and atomics."""
    import numpy as np

    rng = np.random.default_rng(3)
    weeks = pd.date_range("2024-01-05", periods=30, freq="7D")
    stocks = [f"S{i}" for i in range(12)]
    ranks = pd.DataFrame(
        rng.integers(1, 40, size=(30, 14)).astype(float),
        index=weeks,
        columns=stocks + ["GOLD", "SILVER"],
    )
    ranks = ranks.mask(rng.random(ranks.shape) < 0.25)  # holes: names outside the pool that week
    groups = {
        "a :: x": {"S0", "S1", "S2"},
        "a :: y": {"S3", "S4", "NOT_IN_FRAME"},
        "b :: z": {"S5", "S6", "S7", "S8"},
        "b :: w": {"S9"},
        "c :: empty": set(),
    }
    broad._order_cache.clear()
    for floor in (0.0, 0.4, 0.75):
        fast = broad.ordered_categories_by_week(ranks, groups, ("GOLD", "SILVER"), floor)
        for i, w in enumerate(weeks):
            scores = broad.score_categories(
                ranks.loc[w], groups, ("GOLD", "SILVER"), coverage_floor=floor
            )
            assert fast[i] == sorted(scores, key=lambda n: (scores[n], n))
    # Same inputs again: served from the cache, same object.
    again = broad.ordered_categories_by_week(ranks, groups, ("GOLD", "SILVER"), 0.75)
    assert again is broad.ordered_categories_by_week(ranks, groups, ("GOLD", "SILVER"), 0.75)


def test_tax_classes_cover_stocks_atomics_and_idle_cash():
    from momentum_backtesting import tax as tax_mod

    classes = broad._tax_classes(
        ["AAA", "BBB#2", "Gold", "Silver", "Nasdaq 100", "Hang Seng", broad.CASH]
    )
    assert classes["AAA"] == classes["BBB#2"] == tax_mod.EQUITY
    assert classes["Gold"] == classes["Silver"] == tax_mod.GOLD_SILVER
    assert classes["Nasdaq 100"] == classes["Hang Seng"] == tax_mod.INTERNATIONAL
    assert classes[broad.CASH] == tax_mod.DEBT
