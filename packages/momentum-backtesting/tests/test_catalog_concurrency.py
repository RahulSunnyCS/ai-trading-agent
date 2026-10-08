"""Concurrent API requests sharing the catalog (2026-10-07).

`GET /api/meta?dataset=etf` timed out (8 s and more, for minutes) on the running `mbt serve`:
its read-only catalog connection (`db_read.data_version` -> `weekly_closes_from_db`) kept
hitting `ConnectionException: ... different configuration than existing connections` while the
dashboard's saved-runs calls held read-write ones, and two read-write ones racing raised
`BinderException: Unique file handle conflict`, which nothing retried. `trading_data.db.connect`
now serialises connections within a process (shared read-only, exclusive read-write), and the
GETs that only read open the catalog read-only."""

from concurrent.futures import ThreadPoolExecutor

import duckdb
import numpy as np
import pandas as pd
import pytest
import trading_data.db as tdb
from fastapi.testclient import TestClient
from trading_data.db import connect

from momentum_backtesting import api, db_read
from momentum_backtesting.fetch import load_universe


@pytest.fixture
def client(tmp_path, monkeypatch):
    """ETF weekly closes in the catalog only (no CSV), so `/api/meta` reads the database."""
    weeks = pd.date_range("2016-01-01", periods=120, freq="W-FRI")
    rng = np.random.default_rng(3)
    names = sorted({inst.name for inst in load_universe()} | {"Cash (liquid fund)"})
    rows = pd.DataFrame(
        [
            (name, week.date(), float(value))
            for name in names
            for week, value in zip(
                weeks, 100 * np.cumprod(1 + rng.normal(0.002, 0.03, len(weeks))), strict=True
            )
        ],
        columns=["instrument", "date", "close"],
    )
    with connect() as con:
        con.register("seed", rows)
        con.execute(
            "INSERT INTO momentum_prices SELECT instrument, 'weekly', date, NULL, close FROM seed"
        )
    monkeypatch.setattr(api, "DATA_DIR", tmp_path)
    monkeypatch.setattr(api, "DATA", api._Data())
    return TestClient(api.create_app())


@pytest.fixture
def clashes(monkeypatch):
    """Opens that failed because another thread of this process had the catalog open: the old
    code retried (some of) them, so only counting them shows whether requests collided."""
    seen: list[str] = []
    real = duckdb.connect

    def counting(*args, **kwargs):
        try:
            return real(*args, **kwargs)
        except (duckdb.ConnectionException, duckdb.BinderException) as error:
            seen.append(str(error))
            raise

    monkeypatch.setattr(tdb.duckdb, "connect", counting)
    return seen


def _payload(n: int) -> dict:
    return {
        "dataset": "etf",
        "name": f"Run {n}",
        "config": {"top_n": n},
        "kpis": {},
        "dates": [],
        "strategy": [],
        "overlay": False,
    }


def test_meta_and_saved_runs_requests_in_parallel_never_clash(client, clashes):
    client.post("/api/saved-runs", json=_payload(0))
    requests = []
    for n in range(1, 13):
        requests += [
            ("GET", "/api/meta", {"dataset": "etf"}),
            ("GET", "/api/saved-runs", {"dataset": "etf"}),
            ("GET", "/api/favorite-strategies", {}),
            ("GET", "/api/weekly/status", {}),
            ("GET", "/api/alerts", {}),  # the bell polls it from every page
            # A write moves the catalog's mtime, so the next meta recomputes data_version
            # with a read-only connection: the exact read that clashed live.
            ("POST", "/api/saved-runs", _payload(n)),
        ]

    def send(request):
        method, path, body = request
        if method == "POST":
            return path, client.post(path, json=body).status_code
        return path, client.get(path, params=body).status_code

    with ThreadPoolExecutor(10) as pool:
        results = list(pool.map(send, requests))

    assert [r for r in results if r[1] != 200] == []
    assert clashes == []
    # 13 saved; ordinary history keeps the newest 10 per dataset.
    assert len(client.get("/api/saved-runs", params={"dataset": "etf"}).json()) == 10


def test_read_endpoints_open_the_catalog_read_only(client, monkeypatch):
    """A read-write connection holds off every other request's and other processes' readers,
    so the endpoints the dashboard polls must not open one (after the first read in a process,
    which migrates the catalog once: `db_read.read_catalog`)."""
    client.get("/api/saved-runs", params={"dataset": "etf"})  # the one migrating open
    modes: list[bool] = []
    real = tdb.connect

    def recording(*args, read_only=False, **kwargs):
        modes.append(read_only)
        return real(*args, read_only=read_only, **kwargs)

    monkeypatch.setattr(tdb, "connect", recording)
    for path, params in [
        ("/api/saved-runs", {"dataset": "etf"}),
        ("/api/favorite-strategies", {}),
        ("/api/meta", {"dataset": "etf"}),
        ("/api/weekly/status", {}),
        ("/api/alerts", {}),
    ]:
        assert client.get(path, params=params).status_code == 200, path
    assert modes and all(modes), modes


def test_saved_runs_reads_return_empty_without_a_catalog(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path / "none"))
    client = TestClient(api.create_app())
    assert client.get("/api/saved-runs", params={"dataset": "etf"}).json() == []
    assert client.get("/api/favorite-strategies").json() == []
    assert db_read.catalog_mtime() is None  # a read no longer creates the catalog
