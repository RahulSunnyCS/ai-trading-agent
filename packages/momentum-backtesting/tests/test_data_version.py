"""db_read.data_version (BL-005): what every server cache of shared-database data is keyed on.

It replaced the catalog file's mtime, which moves on any write: the dashboard saves each
finished backtest into the catalog, and that emptied every cache before the next run."""

from __future__ import annotations

import os

import pandas as pd
from trading_data.db import connect
from trading_data.lake import bars_1d_stock_path

from momentum_backtesting import db_read, runs_store


def _save_run(root, n: int) -> None:
    with connect(root) as con:
        runs_store.save_run(
            con, "etf", name=f"Run {n}", config={"top_n": n}, kpis={}, dates=[], strategy=[]
        )


def _bump_mtime(path) -> None:
    """Move a file's mtime forward by a minute: two writes inside one test can land on the
    same timestamp, which would hide the change from an mtime check."""
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 60_000_000_000))


def test_no_catalog_has_no_version(tmp_path):
    assert db_read.data_version(tmp_path) is None


def test_a_saved_run_moves_the_catalog_mtime_but_not_the_data_version(tmp_path):
    with connect(tmp_path):
        pass
    before_mtime, before = db_read.catalog_mtime(tmp_path), db_read.data_version(tmp_path)
    _save_run(tmp_path, 1)
    _bump_mtime(tmp_path / "catalog.duckdb")
    assert db_read.catalog_mtime(tmp_path) != before_mtime  # the old key would have missed
    assert db_read.data_version(tmp_path) == before


def test_a_change_to_market_data_moves_the_data_version(tmp_path):
    with connect(tmp_path):
        pass
    before = db_read.data_version(tmp_path)
    with connect(tmp_path) as con:
        con.execute("INSERT INTO companies VALUES ('C1', 'Company one')")
    _bump_mtime(tmp_path / "catalog.duckdb")
    after = db_read.data_version(tmp_path)
    assert after != before

    # An edit that keeps the row count still counts.
    with connect(tmp_path) as con:
        con.execute("UPDATE companies SET name = 'Renamed' WHERE company_id = 'C1'")
    _bump_mtime(tmp_path / "catalog.duckdb")
    assert db_read.data_version(tmp_path) != after


def test_a_lake_write_alone_moves_the_data_version(tmp_path):
    """The Fyers Total Market top-up writes stock bars straight into the lake file."""
    with connect(tmp_path):
        pass
    path = bars_1d_stock_path(tmp_path, 2026)
    path.parent.mkdir(parents=True)
    pd.DataFrame({"x": [1]}).to_parquet(path)
    before = db_read.data_version(tmp_path)
    pd.DataFrame({"x": [1, 2]}).to_parquet(path)
    assert db_read.data_version(tmp_path) != before


def test_a_locked_catalog_falls_back_to_the_mtime_instead_of_failing(tmp_path, monkeypatch):
    with connect(tmp_path):
        pass

    def locked(root):
        raise OSError("Could not set lock on file")

    monkeypatch.setattr(db_read, "_table_hashes", locked)
    version = db_read.data_version(tmp_path)
    assert version == (("catalog_mtime", db_read.catalog_mtime(tmp_path)),)
    assert tmp_path not in db_read._version_memo  # the fallback is never remembered
