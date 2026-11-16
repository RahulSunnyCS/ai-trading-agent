"""BL-226: the F&O universe gate — a stock is in the universe in week W when it was on the F&O
list on the last listed session on or before W."""

from datetime import date

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

from momentum_backtesting.categories import fno


def _members(root, rows):
    path = fno.members_path(root)
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(pa.table({"date": [r[0] for r in rows], "symbol": [r[1] for r in rows]}), path)


def test_gate_follows_the_last_listed_session_and_years_are_supersets(tmp_path):
    _members(tmp_path, [
        (date(2020, 1, 1), "AAA"), (date(2020, 1, 3), "AAA"), (date(2020, 1, 3), "BBB"),
        (date(2020, 1, 10), "BBB"), (date(2021, 1, 4), "CCC"),
    ])  # fmt: skip
    weeks = pd.DatetimeIndex(["2019-12-27", "2020-01-03", "2020-01-10", "2021-01-08"])
    g = fno.gate(weeks, ["AAA", "BBB", "CCC", "ZZZ"], tmp_path)
    assert not g.loc["2019-12-27"].any()  # before the first listed session
    assert g.loc["2020-01-03"].to_dict() == {"AAA": True, "BBB": True, "CCC": False, "ZZZ": False}
    assert g.loc["2020-01-10"].to_dict() == {"AAA": False, "BBB": True, "CCC": False, "ZZZ": False}
    assert g.loc["2021-01-08"].to_dict() == {"AAA": False, "BBB": False, "CCC": True, "ZZZ": False}
    assert fno.members_by_year(tmp_path) == {2020: {"AAA", "BBB"}, 2021: {"CCC"}}


def test_the_research_only_fno_universe_is_refused_on_live_paths():
    from momentum_backtesting import api

    assert "fno" in api.LIVE_REFUSED_BROAD_UNIVERSES
    assert set(api.LIVE_REFUSED_BROAD_UNIVERSES) <= set(api._LIVE_REFUSED_WHY)
    req = api.BacktestRequest(dataset="broad", universe=["broad_momentum"], broad_universe="fno")
    assert req.broad_universe == "fno"  # a backtest may still ask for it


def _book_script():
    import importlib.util
    from pathlib import Path

    path = Path(__file__).resolve().parents[1] / "scripts" / "bl226_options_book.py"
    spec = importlib.util.spec_from_file_location("bl226_options_book", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_load_bans_reads_each_days_symbols(tmp_path):
    path = fno.bans_path(tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    pq.write_table(
        pa.table({"date": [date(2024, 1, 5), date(2024, 1, 5), date(2024, 1, 8)],
                  "symbol": ["BBB", "CCC", "BBB"]}),
        path,
    )  # fmt: skip
    assert fno.load_bans(tmp_path) == {
        pd.Timestamp("2024-01-05"): {"BBB", "CCC"}, pd.Timestamp("2024-01-08"): {"BBB"},
    }  # fmt: skip
    import pytest

    with pytest.raises(FileNotFoundError):
        fno.load_bans(tmp_path / "nowhere")


def test_a_rebuilt_list_moves_the_stamp_the_digest_and_the_data_version(tmp_path):
    from momentum_backtesting import db_read

    assert fno.members_stamp(tmp_path) is None and fno.members_digest(root=tmp_path) is None
    base = [(date(2020, 1, 1), "AAA"), (date(2020, 1, 8), "BBB")]
    _members(tmp_path, base)
    stamp, capped = fno.members_stamp(tmp_path), fno.members_digest("2020-01-10", tmp_path)
    assert stamp[0] == "fno_universe" and db_read._lake_files(tmp_path) == (stamp,)
    # a new week past an end-dated run's cut-off moves the stamp, not that run's digest
    _members(tmp_path, [*base, (date(2020, 1, 15), "CCC")])
    assert fno.members_stamp(tmp_path) != stamp
    assert fno.members_digest("2020-01-10", tmp_path) == capped
    # a change inside the cut-off moves it
    _members(tmp_path, [(date(2020, 1, 1), "AAA"), (date(2020, 1, 8), "ZZZ")])
    assert fno.members_digest("2020-01-10", tmp_path) != capped


def _chains(symbols, days, expiry):
    def one(day, sym):
        return pd.DataFrame({
            "date": [day], "symbol": [sym], "expiry": [expiry], "strike": [100.0],
            "option_type": ["CE"], "close": [10.0], "settle": [10.0], "contracts": [50],
            "oi": [10_000],
        })  # fmt: skip

    return {d: {s: one(d, s) for s in symbols} for d in days}


def test_run_book_buys_nothing_in_a_stock_banned_that_day():
    book = _book_script()
    d0, d1 = pd.Timestamp("2024-01-05"), pd.Timestamp("2024-01-12")
    expiry = pd.Timestamp("2024-02-29")
    sessions = list(pd.bdate_range("2024-01-01", "2024-03-15"))
    chains = _chains(["AAA", "BBB"], [d0, d1], expiry)
    lots = pd.Series(100, index=pd.MultiIndex.from_tuples(
        [(d0, "AAA", expiry), (d0, "BBB", expiry)]))  # fmt: skip
    spots = pd.DataFrame({"AAA": [100.0, 100.0], "BBB": [100.0, 100.0]}, index=[d0, d1])
    picks = {d0: ["AAA", "BBB"], d1: []}
    free, counts = book.run_book(picks, 100_000, "ATM", "CE", sessions, chains, spots, lots)
    assert sorted(free["symbol"]) == ["AAA", "BBB"] and counts["banned"] == 0
    held, counts = book.run_book(
        picks, 100_000, "ATM", "CE", sessions, chains, spots, lots, banned={d0: {"BBB"}}
    )
    assert list(held["symbol"]) == ["AAA"] and counts["banned"] == 1


def test_the_put_books_take_one_n_whatever_the_sleeve_count():
    # `n` is one N per sleeve; a one-sleeve put book must be given the bottom-N's own, not the list
    book = _book_script()
    d0, d1 = pd.Timestamp("2024-01-05"), pd.Timestamp("2024-01-12")
    expiry = pd.Timestamp("2024-02-29")
    sessions = list(pd.bdate_range("2024-01-01", "2024-03-15"))
    chains = _chains(["AAA"], [d0, d1], expiry)
    lots = pd.Series(100, index=pd.MultiIndex.from_tuples([(d0, "AAA", expiry)]))
    spots = pd.DataFrame({"AAA": [100.0, 100.0]}, index=[d0, d1])
    book._BANS = {}
    four_sleeves_n = [5, 5, 5, 5]
    trades, _ = book._book([{d0: ["AAA"], d1: []}], four_sleeves_n[0], "ATM", "CE", sessions,
                           chains, spots, lots)  # fmt: skip
    assert len(trades) == 1
