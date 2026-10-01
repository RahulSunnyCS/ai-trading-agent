"""db_migrate against small synthetic fixtures — never the real multi-hundred-MB
data/ files. Verified separately against the real files by hand (see TODO 3.11.4):
every count and a RELIANCE 2020-01-01 spot check matched data/stocks/daily.parquet
exactly, and the renamed-company link (MUNDRAPORT/ADANIPORTS -> C0003) held."""

from datetime import date
from pathlib import Path

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from trading_data.db import connect

from momentum_backtesting import db_migrate


@pytest.fixture
def curated_dir(tmp_path) -> Path:
    folder = tmp_path / "curated"
    folder.mkdir()
    pd.DataFrame(
        {"company_id": ["C0001", "C0002"], "name": ["Adani Ports Ltd.", "Reliance Ltd."]}
    ).to_csv(folder / "companies.csv", index=False)
    pd.DataFrame(
        {
            "company_id": ["C0001", "C0001", "C0002"],
            "symbol": ["MUNDRAPORT", "ADANIPORTS", "RELIANCE"],
            "from": ["2011-01-03", "2012-01-17", "2011-01-03"],
            "to": ["2012-01-16", None, None],
            "source": ["auto", "auto", "auto"],
        }
    ).to_csv(folder / "aliases.csv", index=False)
    pd.DataFrame(
        {
            "company_id": ["C0001", "C0002"],
            "symbol": ["ADANIPORTS", "RELIANCE"],
            "from": ["2011-01-03", "2011-01-03"],
            "to": [None, None],
            "kind": ["investable", "investable"],
            "source": ["wayback", "wayback"],
            "source2": [None, "extra citation"],
        }
    ).to_csv(folder / "nifty50_membership.csv", index=False)
    return folder


@pytest.fixture
def data_dir(tmp_path, curated_dir) -> Path:
    d = tmp_path / "data"
    (d / "categories").mkdir(parents=True)
    pd.DataFrame(
        {
            "category": ["Ports", "Ports"],
            "year": [2020, 2021],
            "symbol": ["ADANIPORTS", "ADANIPORTS"],
            "source_tier": ["live_annual_snapshot", "live_annual_snapshot"],
            "wayback_timestamp": ["20200101000000", "20210101000000"],
        }
    ).to_csv(d / "categories" / "category_membership.csv", index=False)

    (d / "stocks").mkdir(parents=True)
    pq.write_table(
        pa.table(
            {
                "company_id": ["C0001"],
                "symbol_at_ex": ["ADANIPORTS"],
                "session": ["EQ"],
                "ex_date": [date(2021, 6, 1)],
                "kind": ["dividend"],
                "factor": [None],
                "dividend": [2.5],
                "source": ["feed"],
                "subject_sha1": [None],
            }
        ),
        d / "stocks" / "events.parquet",
    )
    pq.write_table(
        pa.table(
            {
                "date": [date(2011, 6, 1), date(2020, 1, 1), date(2020, 1, 2)],
                "symbol": ["MUNDRAPORT", "ADANIPORTS", "RELIANCE"],
                "series": ["EQ", "EQ", "EQ"],
                "isin": ["INE1", "INE1", "INE2"],
                "open": [100.0, 400.0, 1500.0],
                "high": [101.0, 410.0, 1510.0],
                "low": [99.0, 395.0, 1490.0],
                "close": [100.5, 405.0, 1505.0],
                "prevclose": [99.5, 400.0, 1495.0],
                "volume": [1000, 2000, 3000],
                "turnover": [1e5, 2e5, 3e5],
                "synthetic_close": [False, False, True],
            }
        ),
        d / "stocks" / "daily.parquet",
    )

    (d / "daily").mkdir()
    pd.DataFrame(
        {"date": ["2020-01-01", "2020-01-02"], "open": [100.0, 101.0], "close": [101.0, 102.0]}
    ).to_csv(d / "daily" / "Nifty 50.csv", index=False)
    return d


def test_migrate_end_to_end(tmp_path, data_dir, curated_dir):
    root = tmp_path / "root"
    with connect(root) as con:
        report = db_migrate.migrate(con, root, data_dir=data_dir, curated_dir=curated_dir)
        assert (
            report.companies,
            report.company_symbols,
            report.index_membership,
            report.category_membership,
            report.corporate_actions,
            report.stock_instruments,
            report.stock_bars,
            report.momentum_prices,
        ) == (2, 3, 2, 2, 1, 3, 3, 2)

    # A fresh connection, not the one migrate() wrote through: the lake views are
    # snapshotted at connect() time, so the writer's own connection never sees files
    # it just wrote (see trading_data.db.refresh_views) — this is the real read path
    # every other caller (the CLI, the dashboard) already uses.
    with connect(root, read_only=True) as con:
        # both raw symbols exist, linked to the same company_id (the rename case).
        rows = con.execute(
            "SELECT symbol, company_id FROM instruments WHERE symbol IN "
            "('MUNDRAPORT', 'ADANIPORTS', 'RELIANCE') ORDER BY symbol"
        ).fetchall()
        assert rows == [("ADANIPORTS", "C0001"), ("MUNDRAPORT", "C0001"), ("RELIANCE", "C0002")]

        # bars split by year and read back byte-for-byte via the instrument link.
        reliance_2020 = con.execute(
            "SELECT b.close FROM bars_1d_stock b JOIN instruments i USING (instrument_id) "
            "WHERE i.symbol = 'RELIANCE' AND b.date = DATE '2020-01-02'"
        ).fetchone()
        assert reliance_2020 == (1505.0,)
        mundra_2011 = con.execute(
            "SELECT b.close FROM bars_1d_stock b JOIN instruments i USING (instrument_id) "
            "WHERE i.symbol = 'MUNDRAPORT' AND b.date = DATE '2011-06-01'"
        ).fetchone()
        assert mundra_2011 == (100.5,)

        assert con.execute("SELECT count(*) FROM momentum_prices").fetchone()[0] == 2


def test_migrate_is_safe_to_rerun(tmp_path, data_dir, curated_dir):
    root = tmp_path / "root"
    with connect(root) as con:
        db_migrate.migrate(con, root, data_dir=data_dir, curated_dir=curated_dir)
        db_migrate.migrate(con, root, data_dir=data_dir, curated_dir=curated_dir)
        assert con.execute("SELECT count(*) FROM companies").fetchone()[0] == 2
        assert con.execute("SELECT count(*) FROM corporate_actions").fetchone()[0] == 1
        # instruments are registered idempotently, not duplicated across re-runs.
        assert con.execute("SELECT count(*) FROM instruments").fetchone()[0] == 3


def test_missing_optional_inputs_are_zero_not_fatal(tmp_path):
    root = tmp_path / "root"
    empty_data = tmp_path / "empty_data"
    empty_curated = tmp_path / "empty_curated"
    (empty_data / "categories").mkdir(parents=True)
    (empty_data / "stocks").mkdir(parents=True)
    empty_curated.mkdir()
    pd.DataFrame({"company_id": [], "name": []}).to_csv(
        empty_curated / "companies.csv", index=False
    )
    pd.DataFrame({"company_id": [], "symbol": [], "from": [], "to": [], "source": []}).to_csv(
        empty_curated / "aliases.csv", index=False
    )
    pd.DataFrame(
        {
            "company_id": [],
            "symbol": [],
            "from": [],
            "to": [],
            "kind": [],
            "source": [],
            "source2": [],
        }
    ).to_csv(empty_curated / "nifty50_membership.csv", index=False)
    with connect(root) as con:
        report = db_migrate.migrate(con, root, data_dir=empty_data, curated_dir=empty_curated)
    assert report.category_membership == 0
    assert report.corporate_actions == 0
    assert report.stock_bars == 0
    assert report.stock_weekly_prices == 0
    assert report.stock_membership_weekly == 0


def _write_stock_files(data_dir: Path) -> None:
    """data/stocks/'s five weekly inputs, plus a one-instrument weekly_closes.csv whose
    cash column shares the stock cash series' name but not its history — the real ETF
    file's cash starts in 2016, the stock one in 2011."""
    stocks = data_dir / "stocks"
    stocks.mkdir(parents=True)
    (data_dir / "categories").mkdir()
    weeks = ["2020-01-03", "2020-01-10", "2020-01-17"]
    pd.DataFrame({"": weeks, "C0001": [100.0, 101.0, None], "C0002": [50.0, 51.0, 52.0]}).set_index(
        ""
    ).to_csv(stocks / "nifty50_weekly_tr.csv", index_label="date")
    pd.DataFrame({"": weeks, "C0001": [90.0, 91.0, 92.0], "C0002": [45.0, 46.0, 47.0]}).set_index(
        ""
    ).to_csv(stocks / "nifty50_weekly_price.csv", index_label="date")
    pd.DataFrame({"": weeks, "C0001": [True, True, False], "C0002": [False, True, True]}).set_index(
        ""
    ).to_csv(stocks / "nifty50_membership_weekly.csv", index_label="date")
    pd.DataFrame(
        {
            "date": weeks,
            "nifty50_tri": [1000.0, 1010.0, 1020.0],
            "nifty200_momentum30_tri": [500.0, 505.0, 510.0],
            "nifty50_ew_tri": [700.0, 707.0, 714.0],
            "nifty200_momentum30_back_calculated": [True, True, True],
        }
    ).to_csv(stocks / "benchmarks_weekly.csv", index=False)
    pd.DataFrame({"date": weeks, "close": [10.0, 10.1, 10.2]}).to_csv(
        stocks / "cash_weekly.csv", index=False
    )
    pd.DataFrame(
        {"week_ending": weeks[1:], "Nifty 50": [1.0, 2.0], "Cash (liquid fund)": [99.0, 99.5]}
    ).to_csv(data_dir / "weekly_closes.csv", index=False)


def test_stock_weekly_series_round_trip(tmp_path, curated_dir):
    data_dir = tmp_path / "data2"
    _write_stock_files(data_dir)

    root = tmp_path / "root"
    with connect(root) as con:
        report = db_migrate.migrate(con, root, data_dir=data_dir, curated_dir=curated_dir)
        assert (report.stock_weekly_prices, report.stock_membership_weekly) == (11, 6)
        assert report.stock_weekly_series == 12
        assert con.execute(
            "SELECT close FROM stock_weekly_prices WHERE company_id='C0001' AND kind='tr' "
            "AND week=DATE '2020-01-10'"
        ).fetchone() == (101.0,)
        assert con.execute(
            "SELECT is_member FROM stock_membership_weekly WHERE company_id='C0002' "
            "AND week=DATE '2020-01-03'"
        ).fetchone() == (False,)
        assert con.execute(
            "SELECT close FROM stock_weekly_series WHERE series='Nifty 50 TRI' "
            "AND week=DATE '2020-01-17'"
        ).fetchone() == (1020.0,)
        # the stock series stay out of momentum_prices, which is the ETF dataset's alone.
        assert con.execute(
            "SELECT instrument, date, close FROM momentum_prices WHERE kind='weekly' "
            "AND instrument != 'Nifty 50' ORDER BY date"
        ).fetchall() == [
            ("Cash (liquid fund)", date(2020, 1, 10), 99.0),
            ("Cash (liquid fund)", date(2020, 1, 17), 99.5),
        ]

    from momentum_backtesting import db_read

    tr, price, membership, benchmarks, cash = db_read.stock_dataset_from_db_or_none(root)
    assert tr.loc["2020-01-10", "C0001"] == 101.0
    assert bool(membership.loc["2020-01-03", "C0002"]) is False
    assert benchmarks.loc["2020-01-17", "nifty50_tri"] == 1020.0
    assert cash.loc["2020-01-03"] == 10.0


def test_total_market_membership_shares_the_category_table_without_colliding(tmp_path, curated_dir):
    data_dir = tmp_path / "data3"
    (data_dir / "categories").mkdir(parents=True)
    (data_dir / "stocks").mkdir(parents=True)
    pd.DataFrame(
        {
            "category": ["Nifty Bank", "Nifty Bank"],
            "year": [2020, 2021],
            "symbol": ["AXISBANK", "AXISBANK"],
            "source_tier": ["live_annual_snapshot", "live_annual_snapshot"],
            "wayback_timestamp": ["x", "y"],
        }
    ).to_csv(data_dir / "categories" / "category_membership.csv", index=False)
    pd.DataFrame(
        {
            "category": ["Total Market", "Total Market", "Total Market"],
            "year": [2020, 2020, 2021],
            "symbol": ["RELIANCE", "TCS", "RELIANCE"],
            "source_tier": ["constant_current"] * 3,
            "wayback_timestamp": [""] * 3,
        }
    ).to_csv(data_dir / "categories" / "total_market_membership.csv", index=False)

    root = tmp_path / "root"
    with connect(root) as con:
        report = db_migrate.migrate(con, root, data_dir=data_dir, curated_dir=curated_dir)
        assert report.total_market_membership == 3
        # both categories' rows survive together, neither delete clobbers the other.
        rows = con.execute(
            "SELECT category, count(*) FROM category_membership GROUP BY 1 ORDER BY 1"
        ).fetchall()
        assert rows == [("Nifty Bank", 2), ("Total Market", 3)]

    from momentum_backtesting import db_read

    by_year = db_read.total_market_members_by_year_from_db_or_none(root)
    assert by_year == {2020: {"RELIANCE", "TCS"}, 2021: {"RELIANCE"}}

    # re-running the migration replaces Total Market rows, not duplicates them.
    with connect(root) as con:
        db_migrate.migrate(con, root, data_dir=data_dir, curated_dir=curated_dir)
        assert con.execute(
            "SELECT count(*) FROM category_membership WHERE category = 'Total Market'"
        ).fetchone() == (3,)


def test_weekly_price_push_does_not_wipe_the_stock_dataset(tmp_path, curated_dir, monkeypatch):
    """Regression (2026-10-01): `mbt weekly`'s local_store.push_dir wholesale-replaces
    momentum_prices, which used to hold the stock dataset's benchmark TRIs and cash too —
    after one weekly run, load_stock_dataset raised KeyError on the missing TRI columns."""
    from momentum_backtesting import local_store
    from momentum_backtesting.engine import CASH
    from momentum_backtesting.stocks import ui_data

    data_dir = tmp_path / "data"
    _write_stock_files(data_dir)
    root = tmp_path / "root"
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    with connect(root) as con:
        db_migrate.migrate(con, root, data_dir=data_dir, curated_dir=curated_dir)
    with connect(root) as con:
        local_store.push_dir(con, data_dir)

    # read from the database only: an empty stocks dir proves no file fallback happened.
    empty = tmp_path / "empty" / "stocks"
    empty.mkdir(parents=True)
    ds = ui_data.load_stock_dataset(empty)
    assert ds.prices.loc["2020-01-17", ui_data.NIFTY50_TRI] == 1020.0
    # the stock cash series (from cash_weekly.csv), not the ETF file's same-named column.
    assert ds.prices[CASH].tolist() == [10.0, 10.1, 10.2]


def test_stock_dataset_falls_back_to_files_when_db_series_are_missing(
    tmp_path, curated_dir, monkeypatch
):
    """The state the real catalog was found in: stock_weekly_prices populated, no
    benchmark TRIs. All-or-nothing fallback to data/stocks/, never a KeyError."""
    from momentum_backtesting import db_read
    from momentum_backtesting.stocks import ui_data

    data_dir = tmp_path / "data"
    _write_stock_files(data_dir)
    root = tmp_path / "root"
    monkeypatch.setenv("TRADING_DATA_ROOT", str(root))
    with connect(root) as con:
        db_migrate.migrate(con, root, data_dir=data_dir, curated_dir=curated_dir)
        con.execute("DELETE FROM stock_weekly_series WHERE series LIKE '%TRI'")
        con.execute("UPDATE stock_weekly_prices SET close = close + 1000")  # mark DB rows

    assert db_read.stock_dataset_from_db_or_none(root) is None
    ds = ui_data.load_stock_dataset(data_dir / "stocks")
    assert ds.prices.loc["2020-01-17", ui_data.NIFTY50_EQUAL_WEIGHT_TRI] == 714.0
    assert ds.prices.loc["2020-01-10", "C0001"] == 101.0  # the file's value, not the DB's
