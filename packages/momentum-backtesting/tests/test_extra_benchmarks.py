"""The four comparison-only TRIs (BL-010 Phase 5): Nifty Midcap 150, Smallcap 250, Midcap150
Momentum 50 and Nifty500 Momentum 50.

No network and no real data: raw niftyindices snapshots are written to a tmp dir, the fetch is
monkeypatched, and the catalog is the conftest-isolated TRADING_DATA_ROOT.
"""

import ast
import json
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import pandas as pd
import pytest
from typer.testing import CliRunner

from momentum_backtesting import bias, cli, db_migrate, reference_benchmarks, sources
from momentum_backtesting.reference_benchmarks import (
    EXTRA_REFERENCES,
    NIFTY50_TRI,
    NIFTY200_MOMENTUM30_TRI,
    REFERENCES,
    compare,
    load_references,
)
from momentum_backtesting.stocks import adjust, benchmarks
from momentum_backtesting.stocks.ui_data import (
    _BENCHMARK_COLUMNS,
    NIFTY500_MOMENTUM50_TRI,
    NIFTY500_TRI,
    NIFTY_MIDCAP150_MOMENTUM50_TRI,
    NIFTY_MIDCAP150_TRI,
    NIFTY_SMALLCAP250_TRI,
    REFERENCE_ONLY_COLUMNS,
)

#: What criteria.basket_passes looks up by name (search_spaces/bl010_criteria.json).
EXPECTED_NAMES = {
    "nifty_midcap150_tri": "Nifty Midcap 150 TRI",
    "nifty_smallcap250_tri": "Nifty Smallcap 250 TRI",
    "nifty_midcap150_momentum50_tri": "Nifty Midcap150 Momentum 50 TRI",
    "nifty500_momentum50_tri": "Nifty500 Momentum 50 TRI",
    "nifty500_tri": "Nifty 500 TRI",  # the Phase 6 backcast benchmark
}


def _write_raw(raw_dir, filename, days_and_closes):
    """A raw getTotalReturnIndexString snapshot, as `_fetch_niftyindices_tri_raw` stores it."""
    folder = raw_dir / "benchmarks"
    folder.mkdir(parents=True, exist_ok=True)
    rows = [
        {"Date": f"{d:%d %b %Y}", "TotalReturnsIndex": str(close), "NTR_Value": "-"}
        for d, close in days_and_closes
    ]
    (folder / filename).write_text(json.dumps(rows))


def _daily(start, closes):
    days = pd.bdate_range(start, periods=len(closes))
    return list(zip((d.date() for d in days), closes, strict=True))


def _write_all_extra_raw(raw_dir, base=100.0):
    for i, (_, filename) in enumerate(benchmarks.EXTRA_TRI_INDICES.values()):
        _write_raw(raw_dir, filename, _daily("2024-01-01", [base * (i + 1) + n for n in range(15)]))


def test_display_names_are_the_strings_the_criteria_file_uses():
    assert REFERENCE_ONLY_COLUMNS == EXPECTED_NAMES
    assert set(EXPECTED_NAMES) == set(benchmarks.EXTRA_TRI_INDICES)
    criteria = json.loads(
        (Path(__file__).resolve().parents[1] / "search_spaces" / "bl010_criteria.json").read_text()
    )
    wanted = {b["or_relative"]["index"] for b in criteria["baskets"].values()}
    assert wanted <= set(EXPECTED_NAMES.values())


def test_the_extras_do_not_enter_the_stock_datasets_benchmark_columns():
    """ui_data feeds every ranking; the comparison-only series must not become its columns."""
    assert not set(_BENCHMARK_COLUMNS) & set(REFERENCE_ONLY_COLUMNS)
    assert not set(_BENCHMARK_COLUMNS.values()) & set(REFERENCE_ONLY_COLUMNS.values())


def test_displayed_references_are_still_the_original_two():
    assert REFERENCES == (NIFTY50_TRI, NIFTY200_MOMENTUM30_TRI)
    assert set(EXTRA_REFERENCES) == set(EXPECTED_NAMES.values())


@pytest.mark.parametrize("column", list(benchmarks.EXTRA_TRI_INDICES))
def test_each_extra_is_requested_from_niftyindices_under_its_index_name(monkeypatch, column):
    name, filename = benchmarks.EXTRA_TRI_INDICES[column]
    seen = []

    def urlopen(request, timeout):
        import io

        seen.append(request)
        row = {"Date": "04 Jan 2016", "TotalReturnsIndex": "1234.5", "NTR_Value": "-"}
        return io.BytesIO(json.dumps([row]).encode())

    monkeypatch.setattr(sources.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(sources.time, "sleep", lambda _s: None)

    series = benchmarks.fetch_tri(name, date(2016, 1, 1), date(2016, 1, 31))

    assert seen[0].full_url == sources.NIFTYINDICES_TRI_URL
    assert ast.literal_eval(json.loads(seen[0].data)["cinfo"])["name"] == name
    assert name == name.upper()  # the site matches the upper-case form the existing two use
    assert filename.endswith("_TRI.json")
    assert list(series) == [1234.5]


def test_cli_fetches_each_extra_to_a_distinct_raw_file():
    files = cli._extra_benchmark_tri_files()
    assert len(files) == len(set(files)) == len(benchmarks.EXTRA_TRI_INDICES)
    # Kept apart from the required three, so an optional series can never stop a refresh.
    assert not set(files) & set(cli._BENCHMARK_TRI_FILES)
    assert {"NIFTY_50_TRI.json", "NIFTY200_MOMENTUM_30_TRI.json"} <= set(cli._BENCHMARK_TRI_FILES)


def test_a_failed_optional_tri_does_not_stop_the_refresh(tmp_path, monkeypatch):
    from momentum_backtesting.stocks import benchmarks as bm

    optional = set(cli._extra_benchmark_tri_files().values())

    def fake_fetch(name, start, end):
        if name in optional:
            raise OSError("niftyindices down")
        return [{"Date": "01 Jan 2024", "TotalReturnsIndex": "1"}]

    monkeypatch.setattr(cli, "_fetch_niftyindices_tri_raw", fake_fetch)
    monkeypatch.setattr(bm, "fetch_equal_weight_price", lambda s, e: pd.Series([1.0], name="x"))
    cli._refresh_benchmark_raw_files(tmp_path, date(2024, 1, 1), date(2024, 1, 2))
    assert (tmp_path / "benchmarks" / "NIFTY_50_TRI.json").exists()


def test_build_extra_benchmarks_weekly_is_friday_labelled_and_drops_the_unfinished_week(
    tmp_path,
):
    # Mon 2024-01-01 .. Fri 01-12 (two full weeks) plus Mon-Wed of the third.
    _write_all_extra_raw(tmp_path)

    out = adjust.build_extra_benchmarks_weekly(tmp_path, as_of=date(2024, 1, 17))

    assert list(out.columns) == list(benchmarks.EXTRA_TRI_INDICES)
    assert list(out.index.strftime("%Y-%m-%d")) == ["2024-01-05", "2024-01-12"]
    # the last close of each week: Fri 01-05 is the 5th business day -> base + 4
    assert out["nifty_midcap150_tri"].iloc[0] == 104.0
    assert out["nifty_smallcap250_tri"].iloc[1] == 200.0 + 9


def test_build_extra_benchmarks_weekly_keeps_a_week_labelled_today(tmp_path):
    _write_all_extra_raw(tmp_path)
    out = adjust.build_extra_benchmarks_weekly(tmp_path, as_of=date(2024, 1, 19))
    assert out.index[-1] == pd.Timestamp("2024-01-19")


def test_build_extra_benchmarks_weekly_skips_a_missing_snapshot_without_error(tmp_path):
    _write_raw(tmp_path, "NIFTY_MIDCAP_150_TRI.json", _daily("2024-01-01", [1.0] * 10))
    out = adjust.build_extra_benchmarks_weekly(tmp_path, as_of=date(2024, 2, 1))
    assert list(out.columns) == ["nifty_midcap150_tri"]
    assert adjust.build_extra_benchmarks_weekly(tmp_path / "nowhere").empty


def _write_main_raw(raw_dir):
    for filename in ("NIFTY_50_TRI.json", "NIFTY200_MOMENTUM_30_TRI.json"):
        _write_raw(raw_dir, filename, _daily("2020-01-01", [10.0 + n for n in range(10)]))
    _write_raw(raw_dir, "NIFTY50_EQUAL_WEIGHT_TRI.json", _daily("2020-01-01", [5.0] * 10))


def test_build_benchmarks_weekly_adds_the_extras_only_when_their_snapshots_exist(tmp_path):
    _write_main_raw(tmp_path)
    before = adjust.build_benchmarks_weekly(tmp_path)
    assert list(before.columns) == [
        "nifty50_tri",
        "nifty200_momentum30_tri",
        "nifty50_ew_tri",
        "nifty200_momentum30_back_calculated",
    ]

    _write_raw(tmp_path, "NIFTY500_MOMENTUM_50_TRI.json", _daily("2020-01-01", [7.0] * 10))
    after = adjust.build_benchmarks_weekly(tmp_path)

    assert list(after.columns) == [*before.columns, "nifty500_momentum50_tri"]
    pd.testing.assert_frame_equal(after[before.columns], before)


def test_merge_extra_benchmarks_csv_touches_only_the_extra_columns(tmp_path):
    stocks = tmp_path
    raw = stocks / "raw"
    _write_all_extra_raw(raw)
    weeks = pd.date_range("2024-01-05", periods=2, freq="W-FRI")
    existing = pd.DataFrame(
        {
            "nifty50_tri": [1000.5, 1010.25],
            "nifty200_momentum30_tri": [500.0, 505.0],
            "nifty50_ew_tri": [700.0, 707.0],
            "nifty200_momentum30_back_calculated": [False, False],
            # a stale value of an extra column that the merge must replace
            "nifty500_momentum50_tri": [1.0, 2.0],
        },
        index=weeks,
    )
    existing.to_csv(stocks / "benchmarks_weekly.csv")

    adjust.merge_extra_benchmarks_csv(stocks, as_of=date(2024, 1, 17))
    merged = pd.read_csv(stocks / "benchmarks_weekly.csv", index_col=0, parse_dates=True)

    untouched = existing.drop(columns="nifty500_momentum50_tri")
    pd.testing.assert_frame_equal(
        merged[untouched.columns], untouched, check_dtype=False, check_freq=False
    )
    assert list(merged.columns[:4]) == list(untouched.columns)
    assert set(benchmarks.EXTRA_TRI_INDICES) <= set(merged.columns)
    assert merged["nifty500_momentum50_tri"].iloc[0] == 400.0 + 4  # replaced, not the stale 1.0


def test_merge_extra_benchmarks_csv_needs_the_existing_csv(tmp_path):
    _write_all_extra_raw(tmp_path / "raw")
    with pytest.raises(FileNotFoundError):
        adjust.merge_extra_benchmarks_csv(tmp_path)


def _csv_with_extras(data_dir, weeks):
    stocks = data_dir / "stocks"
    stocks.mkdir(parents=True, exist_ok=True)
    n = len(weeks)
    pd.DataFrame(
        {
            "nifty50_tri": [float(i + 1) for i in range(n)],
            "nifty200_momentum30_tri": [float(i + 11) for i in range(n)],
            "nifty50_ew_tri": [3.0] * n,
            "nifty200_momentum30_back_calculated": [True] * n,
            "nifty_midcap150_tri": [float(i + 21) for i in range(n)],
            "nifty_smallcap250_tri": [float(i + 31) for i in range(n)],
            "nifty_midcap150_momentum50_tri": [float(i + 41) for i in range(n)],
            "nifty500_momentum50_tri": [float(i + 51) for i in range(n)],
            "nifty500_tri": [float(i + 61) for i in range(n)],
        },
        index=weeks,
    ).to_csv(stocks / "benchmarks_weekly.csv")


def test_load_references_returns_the_extra_columns_after_the_original_two(tmp_path):
    weeks = pd.date_range("2016-01-01", periods=4, freq="W-FRI")
    _csv_with_extras(tmp_path, weeks)

    refs = load_references(tmp_path)

    assert list(refs.columns) == [
        NIFTY50_TRI,
        NIFTY200_MOMENTUM30_TRI,
        NIFTY_MIDCAP150_TRI,
        NIFTY_SMALLCAP250_TRI,
        NIFTY_MIDCAP150_MOMENTUM50_TRI,
        NIFTY500_MOMENTUM50_TRI,
        NIFTY500_TRI,
    ]
    assert list(refs[NIFTY_SMALLCAP250_TRI]) == [31.0, 32.0, 33.0, 34.0]


def test_load_references_without_the_extras_is_exactly_what_it_was(tmp_path):
    """A CSV from before this change (or a machine that never ran fetch-benchmarks)."""
    weeks = pd.date_range("2016-01-01", periods=4, freq="W-FRI")
    _csv_with_extras(tmp_path, weeks)
    path = tmp_path / "stocks" / "benchmarks_weekly.csv"
    old = pd.read_csv(path, index_col=0)[
        ["nifty50_tri", "nifty200_momentum30_tri", "nifty50_ew_tri"]
    ]
    old.to_csv(path)

    refs = load_references(tmp_path)

    assert list(refs.columns) == [NIFTY50_TRI, NIFTY200_MOMENTUM30_TRI]


def test_load_references_with_one_extra_missing_returns_the_rest(tmp_path):
    weeks = pd.date_range("2016-01-01", periods=4, freq="W-FRI")
    _csv_with_extras(tmp_path, weeks)
    path = tmp_path / "stocks" / "benchmarks_weekly.csv"
    pd.read_csv(path, index_col=0).drop(columns="nifty_midcap150_tri").to_csv(path)

    refs = load_references(tmp_path)

    assert NIFTY_MIDCAP150_TRI not in refs and NIFTY_SMALLCAP250_TRI in refs


def test_load_references_is_still_empty_without_any_source(tmp_path):
    refs = load_references(tmp_path)
    assert refs.empty
    assert list(refs.columns) == list(reference_benchmarks.LOADED)


def test_compare_still_shows_only_the_original_two_even_when_the_extras_are_loaded(tmp_path):
    weeks = pd.date_range("2016-01-01", periods=60, freq="W-FRI")
    _csv_with_extras(tmp_path, weeks)
    refs = load_references(tmp_path)
    # scale the levels so every column is a plausible rising series
    refs = refs.mul(range(1, 61), axis=0)
    equity = pd.Series(100.0 * 1.002 ** pd.Series(range(60), index=weeks))

    assert [c["name"] for c in compare(equity, refs)] == [NIFTY50_TRI, NIFTY200_MOMENTUM30_TRI]


def test_bias_hurdles_do_not_gain_the_extra_lines(tmp_path):
    weeks = pd.date_range("2016-01-01", periods=60, freq="W-FRI")
    _csv_with_extras(tmp_path, weeks)
    refs = load_references(tmp_path).mul(range(1, 61), axis=0)
    equity = pd.Series(100.0 * 1.002 ** pd.Series(range(60), index=weeks))

    out = bias.Runner.hurdles(SimpleNamespace(refs=refs), equity)

    assert set(out) == {NIFTY50_TRI, NIFTY200_MOMENTUM30_TRI}


def _series_rows(catalog_name, weeks, values):
    return [(catalog_name, w.date(), v) for w, v in zip(weeks, values, strict=True)]


def test_load_references_reads_the_extras_from_the_database(tmp_path):
    from trading_data.db import connect

    weeks = pd.date_range("2024-01-05", periods=3, freq="W-FRI")
    rows = (
        _series_rows(NIFTY50_TRI, weeks, [10.0, 11.0, 12.0])
        + _series_rows(NIFTY_MIDCAP150_TRI, weeks, [30.0, 31.0, 32.0])
        + _series_rows(NIFTY500_MOMENTUM50_TRI, weeks, [50.0, 51.0, 52.0])
        # shares the table but is not a reference
        + _series_rows("Nifty50 Equal Weight TRI", weeks[:1], [5.0])
    )
    with connect() as con:
        con.executemany("INSERT INTO stock_weekly_series VALUES (?, ?, ?)", rows)

    # tmp_path, not the default data/: the CSV fills series the database lacks, so a live
    # data/stocks/benchmarks_weekly.csv would add every other reference (BL-018).
    refs = load_references(tmp_path)

    assert list(refs.columns) == [NIFTY50_TRI, NIFTY_MIDCAP150_TRI, NIFTY500_MOMENTUM50_TRI]
    assert list(refs[NIFTY_MIDCAP150_TRI]) == [30.0, 31.0, 32.0]


def test_import_extra_benchmarks_replaces_only_those_series():
    from trading_data.db import connect

    weeks = pd.date_range("2024-01-05", periods=3, freq="W-FRI")
    with connect() as con:
        con.executemany(
            "INSERT INTO stock_weekly_series VALUES (?, ?, ?)",
            _series_rows(NIFTY50_TRI, weeks, [10.0, 11.0, 12.0])
            + _series_rows("Cash (liquid fund)", weeks, [1.0, 1.1, 1.2])
            + _series_rows(NIFTY_MIDCAP150_TRI, weeks, [999.0, 999.0, 999.0]),  # stale
        )
        extra = pd.DataFrame(
            {
                "nifty_midcap150_tri": [30.0, 31.0, 32.0],
                "nifty_smallcap250_tri": [40.0, 41.0, None],
            },
            index=weeks,
        )

        written = db_migrate.import_extra_benchmarks(con, extra)

        assert written == 5  # the NaN week is not a row
        got = dict(
            con.execute(
                "SELECT series, COUNT(*) FROM stock_weekly_series GROUP BY series"
            ).fetchall()
        )
        assert got == {
            NIFTY50_TRI: 3,
            "Cash (liquid fund)": 3,
            NIFTY_MIDCAP150_TRI: 3,
            NIFTY_SMALLCAP250_TRI: 2,
        }
        assert con.execute(
            "SELECT close FROM stock_weekly_series WHERE series = ? AND week = ?",
            [NIFTY_MIDCAP150_TRI, weeks[0].date()],
        ).fetchone() == (30.0,)
        assert db_migrate.import_extra_benchmarks(con, pd.DataFrame()) == 0


def test_full_migrate_carries_the_extra_series_across(tmp_path):
    """`mbt local migrate` replaces stock_weekly_series wholesale; it must not drop the extras."""
    from trading_data.db import connect

    stocks = tmp_path / "stocks"
    weeks = pd.date_range("2020-01-03", periods=3, freq="W-FRI")
    _csv_with_extras(tmp_path, weeks)
    pd.DataFrame({"date": weeks, "close": [10.0, 10.1, 10.2]}).to_csv(
        stocks / "cash_weekly.csv", index=False
    )

    with connect() as con:
        _, _, n_extra = db_migrate.import_stock_weekly(con, stocks)
        rows = con.execute("SELECT DISTINCT series FROM stock_weekly_series").fetchall()
        names = {r[0] for r in rows}

    # 3 stock benchmarks + the extras + cash, 3 weeks each
    assert n_extra == 3 * (3 + len(EXPECTED_NAMES) + 1)
    assert set(EXPECTED_NAMES.values()) <= names


def test_fetch_benchmarks_command_writes_only_the_extra_columns_and_series(tmp_path, monkeypatch):
    from trading_data.db import connect

    stocks = tmp_path / "stocks"
    weeks = pd.date_range("2024-01-05", periods=2, freq="W-FRI")
    stocks.mkdir()
    existing = pd.DataFrame(
        {
            "nifty50_tri": [1000.0, 1010.0],
            "nifty200_momentum30_tri": [500.0, 505.0],
            "nifty50_ew_tri": [700.0, 707.0],
            "nifty200_momentum30_back_calculated": [False, False],
        },
        index=weeks,
    )
    existing.to_csv(stocks / "benchmarks_weekly.csv")
    with connect() as con:
        con.execute(
            "INSERT INTO stock_weekly_series VALUES (?, ?, ?)",
            [NIFTY50_TRI, weeks[0].date(), 1000.0],
        )

    requested = []

    def fake_fetch(name, start, end):
        requested.append(name)
        n = len(requested)
        return [
            {"Date": f"{d:%d %b %Y}", "TotalReturnsIndex": str(100.0 * n + i), "NTR_Value": "-"}
            for i, d in enumerate(pd.bdate_range("2024-01-01", periods=10))
        ]

    monkeypatch.setattr(cli, "DATA_DIR", tmp_path)
    monkeypatch.setattr(cli, "_fetch_niftyindices_tri_raw", fake_fetch)

    result = CliRunner().invoke(cli.app, ["stocks", "fetch-benchmarks", "--from", "2024-01-01"])

    assert result.exit_code == 0, result.output
    assert requested == [name for name, _ in benchmarks.EXTRA_TRI_INDICES.values()]
    merged = pd.read_csv(stocks / "benchmarks_weekly.csv", index_col=0, parse_dates=True)
    pd.testing.assert_frame_equal(
        merged[existing.columns], existing, check_dtype=False, check_freq=False
    )
    assert set(benchmarks.EXTRA_TRI_INDICES) <= set(merged.columns)
    assert (tmp_path / "stocks" / "raw" / "benchmarks" / "NIFTY_MIDCAP_150_TRI.json").exists()
    with connect(read_only=True) as con:
        got = dict(
            con.execute(
                "SELECT series, COUNT(*) FROM stock_weekly_series GROUP BY series"
            ).fetchall()
        )
    assert got[NIFTY50_TRI] == 1  # untouched
    assert {got[n] for n in EXPECTED_NAMES.values()} == {2}


def test_load_references_fills_series_the_database_lacks_from_the_csv(tmp_path, monkeypatch):
    weeks = pd.date_range("2024-01-05", periods=3, freq="W-FRI")
    in_db = pd.DataFrame(
        {"Nifty 50 TRI": [1.0, 2.0, 3.0], "Nifty200 Momentum 30 TRI": [4.0, 5.0, 6.0]},
        index=weeks,
    )
    monkeypatch.setattr(reference_benchmarks, "_from_db", lambda: in_db)
    (tmp_path / "stocks").mkdir()
    pd.DataFrame(
        {"nifty50_tri": [9.0, 9.0, 9.0], "nifty_midcap150_tri": [7.0, 8.0, 9.0]}, index=weeks
    ).to_csv(tmp_path / "stocks" / "benchmarks_weekly.csv")
    out = reference_benchmarks.load_references(tmp_path)
    assert list(out["Nifty 50 TRI"]) == [1.0, 2.0, 3.0]  # the database wins where both have it
    assert list(out["Nifty Midcap 150 TRI"]) == [7.0, 8.0, 9.0]  # the CSV fills the gap
