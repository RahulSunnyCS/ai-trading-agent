"""categories/compose.py: inner/outer composition. Pure in-memory/tmp_path
fixtures for the bookkeeping helpers (membership-year fallback, the
membership frame, splicing); the real, full `run_inner_category_backtest` end
to end against real daily.parquet + real category_membership.csv is this
task's own manual verification (see the final report), not repeated here as a
network/large-fixture-dependent test. A small, fully synthetic end-to-end case
is included below so the composed pipeline itself (Piece A -> inner
run_backtest -> splice -> outer run_backtest) is still covered by pytest."""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from momentum_backtesting.categories import sources
from momentum_backtesting.categories.compose import (
    ATOMIC_INSTRUMENTS,
    DEFAULT_ATOMIC_COPIES,
    MAX_ATOMIC_COPIES,
    all_category_names,
    atomic_copy_names,
    build_all_categories_price_table,
    build_membership_frame,
    resolve_members_by_year,
    run_inner_category_backtest,
    splice_category_into_outer_prices,
)
from momentum_backtesting.categories.resolve import CategoryDataNotFoundError
from momentum_backtesting.categories.snapshots import MEMBERSHIP_FILENAME
from momentum_backtesting.engine import BENCHMARK, CASH, GILT, Config, run_backtest


def _write_membership(data_dir: Path, rows: list[dict]) -> None:
    data_dir.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(
        rows, columns=["category", "year", "symbol", "source_tier", "wayback_timestamp"]
    ).to_csv(data_dir / MEMBERSHIP_FILENAME, index=False)


def _membership_row(category: str, year: int, symbol: str) -> dict:
    return {
        "category": category,
        "year": year,
        "symbol": symbol,
        "source_tier": "live_annual_snapshot",
        "wayback_timestamp": "20200101000000",
    }


# --------------------------------------------------------------------------
# resolve_members_by_year
# --------------------------------------------------------------------------


def test_resolve_members_by_year_uses_the_exact_year_when_present(tmp_path):
    data_dir, curated_dir = tmp_path / "data", tmp_path / "curated"
    _write_membership(
        data_dir,
        [
            _membership_row("Nifty Bank", 2020, "SBIN"),
            _membership_row("Nifty Bank", 2021, "AXISBANK"),
        ],
    )
    out = resolve_members_by_year(
        "Nifty Bank", [2020, 2021], "narrow", data_dir=data_dir, curated_dir=curated_dir
    )
    assert out == {2020: {"SBIN"}, 2021: {"AXISBANK"}}


def test_resolve_members_by_year_falls_back_to_nearest_available_year(tmp_path):
    data_dir, curated_dir = tmp_path / "data", tmp_path / "curated"
    _write_membership(
        data_dir,
        [
            _membership_row("Nifty Bank", 2020, "SBIN"),
            _membership_row("Nifty Bank", 2024, "AXISBANK"),
        ],
    )
    # 2017 is nearer to 2020 than to 2024; 2026 is nearer to 2024.
    out = resolve_members_by_year(
        "Nifty Bank", [2017, 2026], "narrow", data_dir=data_dir, curated_dir=curated_dir
    )
    assert out == {2017: {"SBIN"}, 2026: {"AXISBANK"}}


def test_resolve_members_by_year_raises_with_no_data_at_all(tmp_path):
    data_dir, curated_dir = tmp_path / "data", tmp_path / "curated"
    _write_membership(data_dir, [_membership_row("Nifty IT", 2020, "INFY")])
    with pytest.raises(CategoryDataNotFoundError):
        resolve_members_by_year(
            "Nifty Bank", [2020], "narrow", data_dir=data_dir, curated_dir=curated_dir
        )


def test_resolve_members_by_year_raises_for_extras_only_category_in_narrow_mode(tmp_path):
    """A category with zero official NSE index has nothing for "narrow" mode to resolve at
    all -- extras only ever apply in "broad" mode -- so this must still raise, not silently
    return an empty universe."""
    data_dir, curated_dir = tmp_path / "data", tmp_path / "curated"
    _write_membership(data_dir, [_membership_row("Nifty IT", 2020, "INFY")])
    curated_dir.mkdir(parents=True)
    (curated_dir / "category_extras.csv").write_text(
        "symbol,category,note\nACC,CDMO,test\n"
    )
    with pytest.raises(CategoryDataNotFoundError):
        resolve_members_by_year(
            "CDMO", [2020], "narrow", data_dir=data_dir, curated_dir=curated_dir
        )


def test_resolve_members_by_year_uses_extras_for_every_year_with_no_official_index(tmp_path):
    """Regression test: a purely hand-curated category (no niftyindices.com equivalent at
    all, e.g. "Hotels" or "CDMO") must work in broad mode, using the same extras set for
    every requested year -- there is no official data to vary by year in the first place.
    """
    data_dir, curated_dir = tmp_path / "data", tmp_path / "curated"
    _write_membership(data_dir, [_membership_row("Nifty IT", 2020, "INFY")])  # unrelated category
    curated_dir.mkdir(parents=True)
    (curated_dir / "category_extras.csv").write_text(
        "symbol,category,note\nACC,CDMO,test\nAMBUJACEM,CDMO,test\n"
    )

    out = resolve_members_by_year(
        "CDMO", [2015, 2020, 2026], "broad", data_dir=data_dir, curated_dir=curated_dir
    )

    assert out == {
        2015: {"ACC", "AMBUJACEM"},
        2020: {"ACC", "AMBUJACEM"},
        2026: {"ACC", "AMBUJACEM"},
    }


# --------------------------------------------------------------------------
# build_membership_frame
# --------------------------------------------------------------------------


def test_build_membership_frame_gates_on_the_base_symbols_year(tmp_path):
    weeks = pd.DatetimeIndex(["2020-01-03", "2021-01-01"])  # different calendar years
    members_by_year = {2020: {"SBIN"}, 2021: {"AXISBANK"}}
    column_to_base = {"SBIN": "SBIN", "SBIN#2": "SBIN", "AXISBANK": "AXISBANK"}

    # No `events` given -- the original, unconstrained-by-liveness behaviour (a caller with
    # no event data at all). See the dedicated liveness tests below for the `events` case.
    frame = build_membership_frame(weeks, members_by_year, column_to_base)

    assert bool(frame.loc["2020-01-03", "SBIN"]) is True
    assert bool(frame.loc["2020-01-03", "SBIN#2"]) is True  # synthetic column inherits base
    assert bool(frame.loc["2020-01-03", "AXISBANK"]) is False
    assert bool(frame.loc["2021-01-01", "SBIN"]) is False
    assert bool(frame.loc["2021-01-01", "AXISBANK"]) is True


def test_build_membership_frame_excludes_a_zombie_segment_from_fresh_buys(tmp_path):
    """Regression test for a real bug found in this task's verification: a forward-filled,
    post-split "zombie" column (see prices.py's "Why forward-fill a stopped segment") stays
    non-null forever, and without this extra constraint it stays buy-eligible forever too --
    observed live buying a flat, 2015-frozen BANKBARODA column 10 times over a real backtest.
    The old segment must stop being buy-eligible at its own split boundary, even though its
    base symbol (and therefore its category membership) is unchanged.
    """
    weeks = pd.date_range("2019-06-01", periods=10, freq="W-FRI")
    members_by_year = {2019: {"BANKBARODA"}}
    column_to_base = {"BANKBARODA": "BANKBARODA", "BANKBARODA#2": "BANKBARODA"}
    # Boundary falls on the Monday of the week containing 2019-07-05 -> 2019-07-01.
    events = pd.DataFrame(
        [
            {
                "symbol": "BANKBARODA",
                "event_date": pd.Timestamp("2019-07-05"),
                "drop_pct": -0.8,
                "turnover_ratio": 0.5,
                "new_column": "BANKBARODA#2",
            }
        ]
    )

    frame = build_membership_frame(weeks, members_by_year, column_to_base, events=events)

    before = weeks[weeks < "2019-07-01"]
    after = weeks[weeks >= "2019-07-01"]
    assert (frame.loc[before, "BANKBARODA"] == True).all()  # noqa: E712
    assert (frame.loc[after, "BANKBARODA"] == False).all()  # noqa: E712 -- the fix
    assert (frame.loc[before, "BANKBARODA#2"] == False).all()  # noqa: E712 -- not live yet
    assert (frame.loc[after, "BANKBARODA#2"] == True).all()  # noqa: E712


def test_segment_live_windows_handles_a_chain_of_events():
    from momentum_backtesting.categories.compose import _segment_live_windows

    column_to_base = {"X": "X", "X#2": "X", "X#3": "X"}
    events = pd.DataFrame(
        [
            {"symbol": "X", "event_date": pd.Timestamp("2020-02-04"), "new_column": "X#2"},
            {"symbol": "X", "event_date": pd.Timestamp("2021-06-16"), "new_column": "X#3"},
        ]
    )

    windows = _segment_live_windows(column_to_base, events)

    assert windows["X"] == (None, pd.Timestamp("2020-02-03"))
    assert windows["X#2"] == (pd.Timestamp("2020-02-03"), pd.Timestamp("2021-06-14"))
    assert windows["X#3"] == (pd.Timestamp("2021-06-14"), None)  # terminal: unbounded


def test_segment_live_windows_handles_a_stale_column_with_no_event():
    """Regression test: a column can go stale with NO detected event at all (a plain
    symbol rename -- see prices.py's "Any column can go stale, not just a detected
    event's"). `_segment_live_windows` must catch this via `stale_columns` even though
    `events` has nothing to say about it.
    """
    from momentum_backtesting.categories.compose import _segment_live_windows

    column_to_base = {"IDFCBANK": "IDFCBANK"}
    empty_events = pd.DataFrame(columns=["symbol", "event_date", "new_column"])
    stale_columns = {"IDFCBANK": pd.Timestamp("2019-01-11")}  # its own last real week

    windows = _segment_live_windows(column_to_base, empty_events, stale_columns)

    assert windows["IDFCBANK"] == (None, pd.Timestamp("2019-01-12"))  # +1 day, exclusive


def test_segment_live_windows_combines_an_event_boundary_with_a_later_staleness():
    """A column split by a detected event can *also* separately go stale later (e.g. the
    post-split segment itself eventually gets renamed) -- the tighter of the two ends
    should win.
    """
    from momentum_backtesting.categories.compose import _segment_live_windows

    column_to_base = {"X": "X", "X#2": "X"}
    events = pd.DataFrame(
        [{"symbol": "X", "event_date": pd.Timestamp("2020-02-04"), "new_column": "X#2"}]
    )
    # X#2 goes stale itself, well before the (unbounded) end an event-only view would give it.
    stale_columns = {"X#2": pd.Timestamp("2020-06-05")}

    windows = _segment_live_windows(column_to_base, events, stale_columns)

    assert windows["X#2"] == (pd.Timestamp("2020-02-03"), pd.Timestamp("2020-06-06"))


def test_build_membership_frame_excludes_a_column_stale_with_no_event(tmp_path):
    """Regression test for the real bug found in verification (IDFCBANK -> IDFCFIRSTB,
    2019-01-16): a column that goes stale with no detected event must still stop being
    buy-eligible after its own last real week, via `stale_columns` alone.
    """
    weeks = pd.date_range("2019-01-04", periods=5, freq="W-FRI")
    members_by_year = {2019: {"IDFCBANK"}}
    column_to_base = {"IDFCBANK": "IDFCBANK"}
    stale_columns = {"IDFCBANK": pd.Timestamp("2019-01-11")}

    frame = build_membership_frame(
        weeks, members_by_year, column_to_base, stale_columns=stale_columns
    )

    assert bool(frame.loc["2019-01-11", "IDFCBANK"]) is True  # its own last real week: fine
    assert bool(frame.loc["2019-01-18", "IDFCBANK"]) is False  # the week after: excluded
    assert bool(frame.loc["2019-01-25", "IDFCBANK"]) is False


# --------------------------------------------------------------------------
# splice_category_into_outer_prices
# --------------------------------------------------------------------------


def test_splice_replaces_the_category_column_and_reindexes():
    outer = pd.DataFrame(
        {"Nifty PSU Bank": [1.0, 2.0, 3.0], "Nifty 50": [10.0, 11.0, 12.0]},
        index=pd.to_datetime(["2021-01-01", "2021-01-08", "2021-01-15"]),
    )
    inner_equity = pd.Series(
        [1.0, 1.1], index=pd.to_datetime(["2021-01-08", "2021-01-15"]), name="strategy"
    )

    spliced = splice_category_into_outer_prices(outer, "Nifty PSU Bank", inner_equity)

    week1 = spliced.loc["2021-01-01", "Nifty PSU Bank"]
    assert week1 != week1  # NaN
    assert spliced.loc["2021-01-08", "Nifty PSU Bank"] == pytest.approx(1.0)
    assert spliced.loc["2021-01-15", "Nifty PSU Bank"] == pytest.approx(1.1)
    assert spliced["Nifty 50"].tolist() == [10.0, 11.0, 12.0]  # untouched


def test_splice_raises_if_category_is_not_an_outer_column():
    outer = pd.DataFrame({"Nifty 50": [10.0]}, index=pd.to_datetime(["2021-01-01"]))
    with pytest.raises(ValueError, match="not a column"):
        splice_category_into_outer_prices(outer, "Nifty PSU Bank", pd.Series(dtype=float))


# --------------------------------------------------------------------------
# run_inner_category_backtest + full composition, small synthetic universe
# --------------------------------------------------------------------------


def _synthetic_weekly_frame(weeks: int, seed: int) -> pd.Series:
    """A deterministic, gently-trending-then-mean-reverting series, distinct per `seed`,
    long enough (>=53 weeks) to clear the engine's 52-week lookback eligibility."""
    import math

    base = 100.0 * (1 + 0.01 * seed)
    return pd.Series([base * (1 + 0.002 * math.sin(seed + i / 5)) ** i for i in range(weeks)])


def test_run_inner_category_backtest_and_full_composition_end_to_end(tmp_path):
    data_dir, curated_dir = tmp_path / "data", tmp_path / "curated"
    stocks_data_dir = tmp_path / "stocks"

    weeks_index = pd.date_range("2018-01-05", periods=120, freq="W-FRI")
    symbols = ["S1", "S2", "S3"]
    _write_membership(
        data_dir,
        [_membership_row("Nifty Test", y, s) for y in range(2018, 2021) for s in symbols],
    )

    # Build a small daily.parquet: one Friday-only "daily" row per week per symbol is enough
    # for sources.weekly's W-FRI resample to pick it straight up.
    rows = []
    for i, symbol in enumerate(symbols):
        series = _synthetic_weekly_frame(len(weeks_index), seed=i + 1)
        for date, close in zip(weeks_index, series, strict=True):
            rows.append(
                {
                    "date": date.strftime("%Y-%m-%d"),
                    "symbol": symbol,
                    "close": float(close),
                    "turnover": 1_000_000.0,
                }
            )
    stocks_data_dir.mkdir(parents=True)
    pd.DataFrame(rows, columns=["date", "symbol", "close", "turnover"]).to_parquet(
        stocks_data_dir / "daily.parquet"
    )

    outer_prices = pd.DataFrame(
        {
            "Nifty Test": _synthetic_weekly_frame(len(weeks_index), seed=9).to_numpy(),
            CASH: 1.0,
            BENCHMARK: _synthetic_weekly_frame(len(weeks_index), seed=5).to_numpy(),
        },
        index=weeks_index,
    )

    inner = run_inner_category_backtest(
        "Nifty Test",
        start="2018-01-01",
        end="2020-02-01",
        outer_prices=outer_prices,
        data_dir=data_dir,
        curated_dir=curated_dir,
        stocks_data_dir=stocks_data_dir,
        top_n=2,
        exit_rank=3,
    )

    assert inner.universe_symbols == symbols
    assert not inner.result.equity.isna().any()
    assert inner.result.equity.iloc[0] == pytest.approx(1.0)

    spliced = splice_category_into_outer_prices(outer_prices, "Nifty Test", inner.result.equity)
    includes = {"Nifty Test": "core"}
    outer_result = run_backtest(
        spliced, includes, Config(start="2018-01-01", end="2020-02-01", top_n=1, exit_rank=1)
    )
    assert not outer_result.equity.isna().any()


# --------------------------------------------------------------------------
# all_category_names / build_all_categories_price_table ("Custom Index" tab)
# --------------------------------------------------------------------------


def test_all_category_names_lists_official_then_custom_deduped(tmp_path):
    curated_dir = tmp_path / "curated"
    curated_dir.mkdir()
    official = sources.available_categories()
    assert official, "sources.CATEGORY_SLUGS should have at least one working slug"
    (curated_dir / "category_extras.csv").write_text(
        "symbol,category,note\n"
        "ACC,CDMO,test\n"
        "AMBUJACEM,CDMO,test\n"
        f"SBIN,{official[0]},colliding with an official category -- must not duplicate\n"
        "TCS,Hotels,test\n"
        "TCS,Hotels,a repeated row for the same category should not duplicate it either\n"
    )

    names = all_category_names(curated_dir)

    assert [n for n, _label in names[: len(official)]] == official
    assert all(label == "official" for _n, label in names[: len(official)])
    custom = names[len(official) :]
    assert [n for n, _label in custom] == ["CDMO", "Hotels"]
    assert all(label == "custom" for _n, label in custom)
    # The extras row naming an official category by its official name is not re-listed as
    # "custom" -- the official entry already covers it.
    assert names.count((official[0], "official")) == 1
    assert (official[0], "custom") not in names


def test_all_category_names_with_no_extras_file_is_official_only(tmp_path):
    curated_dir = tmp_path / "curated"  # deliberately not created / no category_extras.csv
    names = all_category_names(curated_dir)
    official = sources.available_categories()
    assert names == [(name, "official") for name in official]


def test_build_all_categories_price_table_end_to_end(tmp_path):
    """A small, fully synthetic case (mirrors
    test_run_inner_category_backtest_and_full_composition_end_to_end above): two custom
    categories with real resolvable stocks, plus the real 16 official categories (which have no
    membership/extras data at all in this synthetic fixture, and so must be skipped, not fatal).
    The real, full 62-category run against this package's actual data/ is this task's own manual
    verification (see the final report for the real numbers it produced), not repeated here."""
    data_dir, curated_dir = tmp_path / "data", tmp_path / "curated"
    stocks_data_dir = tmp_path / "stocks"
    weeks_index = pd.date_range("2018-01-05", periods=120, freq="W-FRI")

    # The membership file must exist (even with zero rows) or resolve.py's
    # `_category_available_years` raises for every category, including extras-only ones.
    _write_membership(data_dir, [])

    curated_dir.mkdir(parents=True)
    (curated_dir / "category_extras.csv").write_text(
        "symbol,category,note\n"
        "S1,Synthetic Alpha,test\n"
        "S2,Synthetic Alpha,test\n"
        "S3,Synthetic Beta,test\n"
        "S4,Synthetic Beta,test\n"
    )

    rows = []
    for i, symbol in enumerate(["S1", "S2", "S3", "S4"]):
        series = _synthetic_weekly_frame(len(weeks_index), seed=i + 1)
        for date, close in zip(weeks_index, series, strict=True):
            rows.append(
                {
                    "date": date.strftime("%Y-%m-%d"),
                    "symbol": symbol,
                    "close": float(close),
                    "turnover": 1_000_000.0,
                }
            )
    stocks_data_dir.mkdir(parents=True)
    pd.DataFrame(rows, columns=["date", "symbol", "close", "turnover"]).to_parquet(
        stocks_data_dir / "daily.parquet"
    )

    outer_prices = pd.DataFrame(
        {CASH: 1.0, BENCHMARK: _synthetic_weekly_frame(len(weeks_index), seed=9).to_numpy()},
        index=weeks_index,
    )

    result = build_all_categories_price_table(
        top_n=1,
        exit_rank=2,
        start="2018-01-01",
        end="2020-02-01",
        outer_prices=outer_prices,
        data_dir=data_dir,
        curated_dir=curated_dir,
        stocks_data_dir=stocks_data_dir,
    )

    assert set(result.inner_results) == {"Synthetic Alpha", "Synthetic Beta"}
    assert result.labels["Synthetic Alpha"] == "custom"
    assert result.labels["Synthetic Beta"] == "custom"
    # Every official category has zero membership rows AND zero extras rows in this synthetic
    # fixture, so every one of them must be skipped (degrade gracefully), not fatal to the table.
    assert set(sources.available_categories()) <= set(result.skipped)
    assert CASH in result.prices.columns
    assert BENCHMARK in result.prices.columns
    assert not result.prices["Synthetic Alpha"].dropna().empty
    assert not result.prices["Synthetic Beta"].dropna().empty

    includes = dict.fromkeys(result.inner_results, "core")
    outer_result = run_backtest(
        result.prices,
        includes,
        Config(
            start="2018-01-01",
            end="2020-02-01",
            top_n=1,
            exit_rank=2,
            universe=tuple(result.inner_results),
        ),
    )
    assert not outer_result.equity.isna().any()


def test_build_all_categories_price_table_raises_if_every_category_fails(tmp_path):
    data_dir, curated_dir = tmp_path / "data", tmp_path / "curated"
    stocks_data_dir = tmp_path / "stocks"
    stocks_data_dir.mkdir(parents=True)
    outer_prices = pd.DataFrame(
        {CASH: [1.0], BENCHMARK: [1.0]},
        index=pd.date_range("2020-01-03", periods=1, freq="W-FRI"),
    )
    with pytest.raises(ValueError, match="no category could be resolved"):
        build_all_categories_price_table(
            start="2020-01-01",
            outer_prices=outer_prices,
            data_dir=data_dir,
            curated_dir=curated_dir,
            stocks_data_dir=stocks_data_dir,
        )


# --------------------------------------------------------------------------
# ATOMIC_INSTRUMENTS / atomic_copy_names (Gold/Silver/Cash/Gilt, added on request so they can
# occupy more than one ranked slot when their own momentum is strong)
# --------------------------------------------------------------------------


def test_atomic_copy_names_generates_the_expected_sequence():
    names = atomic_copy_names("Gold")
    assert names[0] == "Gold"
    assert names[1] == "Gold #2"
    assert names[-1] == f"Gold #{MAX_ATOMIC_COPIES}"
    assert len(names) == MAX_ATOMIC_COPIES
    assert len(set(names)) == MAX_ATOMIC_COPIES  # no accidental duplicates


def test_atomic_instruments_covers_gold_silver_cash_gilt_with_correct_tags():
    by_name = dict(ATOMIC_INSTRUMENTS)
    assert by_name["Gold"] == "commodity"
    assert by_name["Silver"] == "commodity"
    assert by_name[CASH] == "debt"
    assert by_name[GILT] == "debt"


def test_atomic_copy_names_with_count_1_is_ordinary_single_instrument_behaviour():
    """Regression test for the requested default change: "put gold silver number only one as
    a single stock" -- count=1 (build_all_categories_price_table's own default,
    DEFAULT_ATOMIC_COPIES) must produce exactly one column, not ten."""
    assert atomic_copy_names("Gold", 1) == ["Gold"]
    assert atomic_copy_names(CASH, 1) == [CASH]


def test_build_all_categories_price_table_defaults_to_one_copy_per_atomic_instrument(tmp_path):
    """The out-of-the-box behaviour (no commodity_copies/debt_copies passed) must be ordinary,
    single-instrument ranking -- no "#2"/"#3".. columns at all -- matching how Gold/Silver/
    Cash/Gilt worked before the multi-copy mechanism existed."""
    data_dir, curated_dir = tmp_path / "data", tmp_path / "curated"
    stocks_data_dir = tmp_path / "stocks"
    stocks_data_dir.mkdir(parents=True)
    _write_membership(data_dir, [])
    curated_dir.mkdir(parents=True)
    weeks_index = pd.date_range("2018-01-05", periods=120, freq="W-FRI")
    curated_dir.joinpath("category_extras.csv").write_text(
        "symbol,category,note\nS1,Only Category,test\n"
    )
    rows = [
        {"date": d.strftime("%Y-%m-%d"), "symbol": "S1", "close": c, "turnover": 1_000_000.0}
        for d, c in zip(weeks_index, _synthetic_weekly_frame(len(weeks_index), seed=1), strict=True)
    ]
    pd.DataFrame(rows, columns=["date", "symbol", "close", "turnover"]).to_parquet(
        stocks_data_dir / "daily.parquet"
    )
    outer_prices = pd.DataFrame(
        {
            CASH: 1.0,
            BENCHMARK: _synthetic_weekly_frame(len(weeks_index), seed=9).to_numpy(),
            "Gold": _synthetic_weekly_frame(len(weeks_index), seed=3).to_numpy(),
            "Silver": _synthetic_weekly_frame(len(weeks_index), seed=4).to_numpy(),
            GILT: _synthetic_weekly_frame(len(weeks_index), seed=5).to_numpy(),
            "Nasdaq 100": _synthetic_weekly_frame(len(weeks_index), seed=6).to_numpy(),
            "Hang Seng": _synthetic_weekly_frame(len(weeks_index), seed=7).to_numpy(),
        },
        index=weeks_index,
    )

    result = build_all_categories_price_table(
        top_n=1,
        exit_rank=2,
        start="2018-01-01",
        end="2020-02-01",
        outer_prices=outer_prices,
        data_dir=data_dir,
        curated_dir=curated_dir,
        stocks_data_dir=stocks_data_dir,
        # commodity_copies/debt_copies deliberately NOT passed -- testing the default.
    )

    for name, _label in ATOMIC_INSTRUMENTS:
        assert name in result.prices.columns
        assert f"{name} #2" not in result.prices.columns


def test_build_all_categories_price_table_includes_atomic_instrument_copies(tmp_path):
    """Gold/Silver/Gilt need a real price column in `outer_prices` (Cash doesn't -- its column
    already exists unconditionally). Each of the 4 gets MAX_ATOMIC_COPIES columns, all carrying
    the identical price series, all labelled consistently -- verified directly rather than
    just trusting the loop that builds them.
    """
    data_dir, curated_dir = tmp_path / "data", tmp_path / "curated"
    stocks_data_dir = tmp_path / "stocks"
    stocks_data_dir.mkdir(parents=True)
    _write_membership(data_dir, [])
    curated_dir.mkdir(parents=True)
    (curated_dir / "category_extras.csv").write_text("symbol,category,note\n")

    weeks_index = pd.date_range("2018-01-05", periods=120, freq="W-FRI")
    gold_series = _synthetic_weekly_frame(len(weeks_index), seed=3).to_numpy()
    silver_series = _synthetic_weekly_frame(len(weeks_index), seed=4).to_numpy()
    gilt_series = _synthetic_weekly_frame(len(weeks_index), seed=5).to_numpy()
    nasdaq_series = _synthetic_weekly_frame(len(weeks_index), seed=6).to_numpy()
    hangseng_series = _synthetic_weekly_frame(len(weeks_index), seed=7).to_numpy()
    outer_prices = pd.DataFrame(
        {
            CASH: 1.0,
            BENCHMARK: _synthetic_weekly_frame(len(weeks_index), seed=9).to_numpy(),
            "Gold": gold_series,
            "Silver": silver_series,
            GILT: gilt_series,
            "Nasdaq 100": nasdaq_series,
            "Hang Seng": hangseng_series,
        },
        index=weeks_index,
    )

    # No official/custom categories can resolve in this fixture (empty membership + empty
    # extras) -- build_all_categories_price_table would normally raise "no category could be
    # resolved at all", so give it one trivially-resolvable custom category to get past that,
    # keeping the test's focus on the atomic-instrument columns specifically.
    (curated_dir / "category_extras.csv").write_text(
        "symbol,category,note\nS1,Only Category,test\n"
    )
    rows = [
        {"date": d.strftime("%Y-%m-%d"), "symbol": "S1", "close": c, "turnover": 1_000_000.0}
        for d, c in zip(weeks_index, _synthetic_weekly_frame(len(weeks_index), seed=1), strict=True)
    ]
    pd.DataFrame(rows, columns=["date", "symbol", "close", "turnover"]).to_parquet(
        stocks_data_dir / "daily.parquet"
    )

    result = build_all_categories_price_table(
        top_n=1,
        exit_rank=2,
        start="2018-01-01",
        end="2020-02-01",
        outer_prices=outer_prices,
        data_dir=data_dir,
        curated_dir=curated_dir,
        stocks_data_dir=stocks_data_dir,
        commodity_copies=MAX_ATOMIC_COPIES,
        debt_copies=MAX_ATOMIC_COPIES,
    )

    # commodity_copies/debt_copies only apply to the "commodity"/"debt" labels -- Nasdaq 100/
    # Hang Seng ("international") have no multi-slot mechanism and stay at DEFAULT_ATOMIC_COPIES
    # regardless (see build_all_categories_price_table's `_copies_by_label`).
    for name, label in ATOMIC_INSTRUMENTS:
        expected_copies = (
            MAX_ATOMIC_COPIES if label in ("commodity", "debt") else DEFAULT_ATOMIC_COPIES
        )
        for copy_name in atomic_copy_names(name, expected_copies):
            assert copy_name in result.prices.columns, f"missing {copy_name}"
            assert result.labels[copy_name] == label
        # Every copy of one instrument carries the identical price series.
        copies = [result.prices[c] for c in atomic_copy_names(name, expected_copies)]
        for c in copies[1:]:
            pd.testing.assert_series_equal(c, copies[0], check_names=False)

    assert "Only Category" not in result.skipped


def test_build_all_categories_price_table_skips_a_missing_atomic_instrument_gracefully(tmp_path):
    """Gold/Silver/Gilt need a price column from outer_prices; if one is missing (e.g. an older
    weekly_closes.csv that doesn't have Gilt yet), that instrument is skipped, not fatal --
    same degrade-gracefully rule as a category that fails to resolve."""
    data_dir, curated_dir = tmp_path / "data", tmp_path / "curated"
    stocks_data_dir = tmp_path / "stocks"
    stocks_data_dir.mkdir(parents=True)
    _write_membership(data_dir, [])
    curated_dir.mkdir(parents=True)
    weeks_index = pd.date_range("2018-01-05", periods=120, freq="W-FRI")
    (curated_dir / "category_extras.csv").write_text(
        "symbol,category,note\nS1,Only Category,test\n"
    )
    rows = [
        {"date": d.strftime("%Y-%m-%d"), "symbol": "S1", "close": c, "turnover": 1_000_000.0}
        for d, c in zip(weeks_index, _synthetic_weekly_frame(len(weeks_index), seed=1), strict=True)
    ]
    pd.DataFrame(rows, columns=["date", "symbol", "close", "turnover"]).to_parquet(
        stocks_data_dir / "daily.parquet"
    )
    # No Gold/Silver/Gilt columns at all in outer_prices (only CASH/BENCHMARK, both required).
    outer_prices = pd.DataFrame(
        {CASH: 1.0, BENCHMARK: _synthetic_weekly_frame(len(weeks_index), seed=9).to_numpy()},
        index=weeks_index,
    )

    result = build_all_categories_price_table(
        top_n=1,
        exit_rank=2,
        start="2018-01-01",
        end="2020-02-01",
        outer_prices=outer_prices,
        data_dir=data_dir,
        curated_dir=curated_dir,
        stocks_data_dir=stocks_data_dir,
        debt_copies=MAX_ATOMIC_COPIES,
    )

    assert "Gold" in result.skipped
    assert "Silver" in result.skipped
    assert GILT in result.skipped
    assert "Gold" not in result.prices.columns
    # CASH needs no price column of its own (already present unconditionally) -- its copies
    # still succeed even when Gold/Silver/Gilt can't.
    assert CASH not in result.skipped
    for copy_name in atomic_copy_names(CASH, MAX_ATOMIC_COPIES):
        assert copy_name in result.prices.columns
        assert result.labels[copy_name] == "debt"
