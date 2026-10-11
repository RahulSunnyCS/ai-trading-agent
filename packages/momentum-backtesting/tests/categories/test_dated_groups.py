"""Forward-dated categories (BL-092): a category in stock_groups_dated.csv is selectable only from
its launch week, and every existing category, week and result is untouched."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from momentum_backtesting.categories import broad

CURATED = Path(broad.__file__).parent / "curated"
WEEKS = pd.date_range("2026-09-18", periods=4, freq="W-FRI")  # 09-18, 09-25, 10-02, 10-09, ...


def _ranks(weeks: pd.DatetimeIndex) -> pd.DataFrame:
    # A and B are an old category, C and D a new one that ranks best (rank 1, 2) every week.
    return pd.DataFrame(
        {
            "A": [3.0] * len(weeks),
            "B": [4.0] * len(weeks),
            "C": [1.0] * len(weeks),
            "D": [2.0] * len(weeks),
        },
        index=weeks,
    )


GROUPS = {"Old :: Old": {"A", "B"}, "New :: Theme": {"C", "D"}}


def test_a_dated_category_is_never_ranked_before_its_launch_week():
    weeks = pd.date_range("2026-10-02", periods=4, freq="W-FRI")  # 10-02, 10-09, 10-16, 10-23
    launch = pd.Timestamp("2026-10-12")
    ordered = broad.ordered_categories_by_week(
        _ranks(weeks), GROUPS, (), 0.4, {"New :: Theme": launch}
    )
    assert [("New :: Theme" in row) for row in ordered] == [False, False, True, True]
    assert all("Old :: Old" in row for row in ordered)
    assert ordered[2][0] == "New :: Theme"  # it ranks best once it is allowed to


def test_no_launches_is_identical_to_before():
    weeks = pd.date_range("2026-10-02", periods=4, freq="W-FRI")
    plain = broad.ordered_categories_by_week(_ranks(weeks), GROUPS, (), 0.4)
    assert plain == broad.ordered_categories_by_week(_ranks(weeks), GROUPS, (), 0.4, {})
    assert plain == broad.ordered_categories_by_week(_ranks(weeks), GROUPS, (), 0.4, None)
    assert all("New :: Theme" in row for row in plain)


def test_launch_date_is_part_of_the_cache_key():
    ranks = _ranks(pd.date_range("2026-10-02", periods=4, freq="W-FRI"))
    early = broad.ordered_categories_by_week(
        ranks, GROUPS, (), 0.4, {"New :: Theme": pd.Timestamp("2026-10-01")}
    )
    late = broad.ordered_categories_by_week(
        ranks, GROUPS, (), 0.4, {"New :: Theme": pd.Timestamp("2026-10-20")}
    )
    assert early != late
    assert "New :: Theme" in early[0] and "New :: Theme" not in late[0]


def test_selection_never_holds_a_dated_category_before_launch():
    weeks = list(pd.date_range("2026-10-02", periods=4, freq="W-FRI"))
    ranks = _ranks(pd.DatetimeIndex(weeks))
    selection = broad.compute_category_selection_mass_exit(
        ranks,
        GROUPS,
        weeks,
        atomic_names=(),
        top_n=1,
        exit_rank=1,
        launches={"New :: Theme": pd.Timestamp("2026-10-12")},
    )
    held = {w: selection.held_by_week[w] for w in weeks}
    assert held[weeks[0]] == ["Old :: Old"] and held[weeks[1]] == ["Old :: Old"]
    assert held[weeks[2]] == ["New :: Theme"]  # first week on/after 12 Oct, and it is best


def test_loaders_merge_dated_members_only_when_asked(tmp_path):
    header = "parent_group,subgroup,symbol,company_name,note\n"
    (tmp_path / "stock_groups.csv").write_text(header + "Old,Old,A,A,n\nOld,Old,B,B,n\n")
    (tmp_path / "stock_groups_dated.csv").write_text(
        "parent_group,subgroup,symbol,company_name,launch_date,note\n"
        "New,Theme,C,C,2026-10-12,n\nNew,Theme,D,D,2026-10-12,n\n"
    )
    assert set(broad.load_stock_groups(tmp_path)) == {"Old :: Old"}
    merged = broad.load_stock_groups(tmp_path, dated=True)
    assert merged["New :: Theme"] == {"C", "D"} and merged["Old :: Old"] == {"A", "B"}
    assert broad.load_group_launches(tmp_path) == {"New :: Theme": pd.Timestamp("2026-10-12")}
    assert broad.load_stock_groups(tmp_path, dated=True) is merged  # cached, identity stable


def test_two_launch_dates_for_one_category_is_an_error(tmp_path):
    (tmp_path / "stock_groups_dated.csv").write_text(
        "parent_group,subgroup,symbol,company_name,launch_date,note\n"
        "New,Theme,C,C,2026-10-12,n\nNew,Theme,D,D,2026-10-19,n\n"
    )
    with pytest.raises(ValueError, match="more than one launch_date"):
        broad.load_group_launches(tmp_path)


def test_missing_dated_file_means_no_launches(tmp_path):
    assert broad.load_group_launches(tmp_path) == {}


def test_committed_dated_file_is_well_formed_and_never_renames_an_existing_category():
    launches = broad.load_group_launches(CURATED)
    assert launches["Power & Energy :: Battery Storage (BESS)"] == pd.Timestamp("2026-10-12")
    existing = broad.load_stock_groups(CURATED, extended=True)
    # A dated id that matched an existing category would mask that whole category before launch.
    assert not set(launches) & set(existing)
    dated = broad.load_stock_groups(CURATED, dated=True)
    assert set(launches) <= set(dated) and all(dated[cid] for cid in launches)
