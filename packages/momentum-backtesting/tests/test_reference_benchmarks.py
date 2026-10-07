"""Nifty 50 TRI / Nifty200 Momentum 30 TRI comparison lines (TODO 3.9.23, Step 0a)."""

import json

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from momentum_backtesting import api, metrics, reference_benchmarks
from momentum_backtesting.fetch import load_universe
from momentum_backtesting.reference_benchmarks import (
    NIFTY50_TRI,
    NIFTY200_MOMENTUM30_TRI,
    NIFTY_NEXT50_TRI,
    PICKER,
    aligned,
    compare,
    load_references,
    picker,
)


def _write_csv(data_dir, weeks, tri, mom):
    stocks = data_dir / "stocks"
    stocks.mkdir(parents=True, exist_ok=True)
    frame = pd.DataFrame(
        {
            "nifty50_tri": tri,
            "nifty200_momentum30_tri": mom,
            "nifty50_ew_tri": tri,
            "nifty200_momentum30_back_calculated": True,
        },
        index=weeks,
    )
    frame.to_csv(stocks / "benchmarks_weekly.csv")


def test_load_references_reads_the_csv_and_renames(tmp_path):
    weeks = pd.date_range("2016-01-01", periods=4, freq="W-FRI")
    _write_csv(tmp_path, weeks, [1.0, 2.0, 3.0, 4.0], [5.0, 6.0, 7.0, 8.0])
    refs = load_references(tmp_path)
    assert list(refs.columns) == [NIFTY50_TRI, NIFTY200_MOMENTUM30_TRI]
    assert list(refs[NIFTY50_TRI]) == [1.0, 2.0, 3.0, 4.0]


def test_load_references_is_empty_not_an_error_without_data(tmp_path):
    assert load_references(tmp_path).empty


def test_aligned_rebases_and_rejects_a_line_that_starts_too_late():
    weeks = pd.date_range("2020-01-03", periods=5, freq="W-FRI")
    ref = pd.Series([50.0, 55.0, 60.0, 66.0, 70.0], index=weeks)
    line = aligned(ref, weeks[1:])
    assert line.iloc[0] == 1.0 and line.iloc[-1] == pytest.approx(70 / 55)
    assert aligned(ref.iloc[2:], weeks) is None


def test_aligned_carries_one_missing_week_forward():
    weeks = pd.date_range("2020-01-03", periods=4, freq="W-FRI")
    ref = pd.Series([10.0, None, 12.0, 13.0], index=weeks)
    assert list(aligned(ref, weeks)) == pytest.approx([1.0, 1.0, 1.2, 1.3])


def test_compare_reports_the_cagr_edge_and_the_back_calculated_note():
    weeks = pd.date_range("2019-01-04", periods=105, freq="W-FRI")
    equity = pd.Series(1.0, index=weeks) * (1.01 ** pd.Series(range(105), index=weeks))
    refs = pd.DataFrame(
        {NIFTY50_TRI: 100.0 * (1.002 ** pd.Series(range(105), index=weeks))},
        index=weeks,
    )
    refs[NIFTY200_MOMENTUM30_TRI] = refs[NIFTY50_TRI] * 2
    out = {c["name"]: c for c in compare(equity, refs)}
    assert set(out) == {NIFTY50_TRI, NIFTY200_MOMENTUM30_TRI}
    tri = out[NIFTY50_TRI]
    assert tri["excess_cagr"] > 0.3  # ~68% a year vs ~11%
    assert tri["note"] is None
    assert out[NIFTY200_MOMENTUM30_TRI]["note"].startswith("Back-calculated")


def test_every_etf_backtest_payload_carries_the_comparisons(tmp_path, monkeypatch):
    weeks = pd.date_range("2016-01-01", periods=180, freq="W-FRI")
    rng = np.random.default_rng(7)
    prices = pd.DataFrame(
        {
            inst.name: 100 * np.cumprod(1 + rng.normal(0.002, 0.03, len(weeks)))
            for inst in load_universe()
        },
        index=weeks,
    )
    prices["Cash (liquid fund)"] = 100 * np.cumprod(np.full(len(weeks), 1.0012))
    prices.index.name = "week_ending"
    prices.to_csv(tmp_path / "weekly_closes.csv")
    _write_csv(tmp_path, weeks, prices["Nifty 50"] * 1.01, prices["Nifty Bank"])
    monkeypatch.setattr(api, "DATA_DIR", tmp_path)
    monkeypatch.setattr(api, "DATA", api._Data())
    client = TestClient(api.create_app())

    universe = [i.name for i in load_universe() if i.include == "core"]
    body = client.post("/api/backtest", json={"universe": universe, "start": "2017-01-06"}).json()
    names = [c["name"] for c in body["comparisons"]]
    assert names == [NIFTY50_TRI, NIFTY200_MOMENTUM30_TRI]
    first = body["comparisons"][0]
    assert len(first["series"]) == len(body["series"]["dates"])
    assert first["series"][0] == pytest.approx(100_000)
    assert first["excess_cagr"] == pytest.approx(body["kpis"]["cagr"] - first["cagr"])
    # The headline picker's five indices: the two in this CSV carry their curve, the rest are
    # listed as unavailable rather than dropped.
    picked = {b["name"]: b for b in body["benchmarks"]}
    assert [b["name"] for b in body["benchmarks"]] == list(PICKER)
    mom = picked[NIFTY200_MOMENTUM30_TRI]
    assert mom["available"] and len(mom["series"]) == len(body["series"]["dates"])
    assert mom["series"][0] == pytest.approx(100_000)
    assert mom["final_value"] == pytest.approx(mom["series"][-1])
    assert mom["excess_cagr"] == pytest.approx(body["kpis"]["cagr"] - mom["cagr"])
    assert picked[NIFTY_NEXT50_TRI] == {"name": NIFTY_NEXT50_TRI, "available": False}
    json.dumps(body, allow_nan=False)


def test_picker_measures_each_index_on_the_strategys_own_definitions():
    weeks = pd.date_range("2019-01-04", periods=160, freq="W-FRI")
    rng = np.random.default_rng(3)
    equity = pd.Series(np.cumprod(1 + rng.normal(0.004, 0.02, len(weeks))), index=weeks)
    cash = pd.Series(1.001 ** np.arange(len(weeks)), index=weeks)
    level = pd.Series(100 * np.cumprod(1 + rng.normal(0.002, 0.03, len(weeks))), index=weeks)
    refs = pd.DataFrame({NIFTY50_TRI: level, NIFTY200_MOMENTUM30_TRI: level * 3})
    # The last week's close is missing (published late): carried forward, and `as_of` says so.
    refs.iloc[-1, refs.columns.get_loc(NIFTY50_TRI)] = None

    out = {entry["name"]: entry for entry in picker(equity, cash, refs)}

    assert list(out) == list(PICKER)
    nifty = out[NIFTY50_TRI]
    assert nifty["as_of"] == f"{weeks[-2]:%Y-%m-%d}"
    stats = metrics.curve_stats(nifty["curve"], cash)
    assert nifty["cagr"] == pytest.approx(stats["CAGR"])
    assert nifty["sharpe"] == pytest.approx(stats["Sharpe"])
    assert nifty["max_drawdown"] == pytest.approx(stats["max drawdown"])
    assert nifty["excess_cagr"] == pytest.approx(metrics.cagr(equity) - stats["CAGR"])
    assert 0 <= nifty["years_beating"] <= 4
    assert out[NIFTY200_MOMENTUM30_TRI]["as_of"] == f"{weeks[-1]:%Y-%m-%d}"
    assert out[NIFTY200_MOMENTUM30_TRI]["note"].startswith("Back-calculated")
    assert out[NIFTY_NEXT50_TRI] == {"name": NIFTY_NEXT50_TRI, "available": False}


def test_picker_drops_an_index_that_stopped_more_than_a_week_early():
    weeks = pd.date_range("2020-01-03", periods=10, freq="W-FRI")
    equity = pd.Series(np.linspace(1, 2, 10), index=weeks)
    refs = pd.DataFrame({NIFTY50_TRI: [100.0] * 8 + [None, None]}, index=weeks)
    out = {entry["name"]: entry for entry in picker(equity, equity, refs)}
    assert out[NIFTY50_TRI]["available"] is False


def test_payload_without_reference_data_has_an_empty_list(tmp_path):
    weeks = pd.date_range("2020-01-03", periods=3, freq="W-FRI")
    assert compare(pd.Series([1.0, 1.1, 1.2], index=weeks), pd.DataFrame()) == []
    assert reference_benchmarks.load_references(tmp_path).empty


def _seed_series(rows):
    from trading_data.db import connect

    with connect() as con:  # the conftest-isolated TRADING_DATA_ROOT
        con.executemany("INSERT INTO stock_weekly_series VALUES (?, ?, ?)", rows)


def test_load_references_reads_the_database_when_a_catalog_exists(tmp_path):
    """The reference TRIs live in `stock_weekly_series` since migration 004 (they used to share
    `momentum_prices`). `_from_db` kept calling a helper that 004's commit deleted, so with a
    catalog present EVERY backtest endpoint (all four call `DATA.references()`) crashed with an
    AttributeError - after doing all the work. No test had a catalog, so none ran this branch."""
    weeks = pd.date_range("2024-01-05", periods=3, freq="W-FRI")
    _seed_series(
        [(NIFTY50_TRI, w.date(), v) for w, v in zip(weeks, [10.0, 11.0, 12.0], strict=True)]
        + [
            (NIFTY200_MOMENTUM30_TRI, w.date(), v)
            for w, v in zip(weeks, [20.0, 22.0, 24.0], strict=True)
        ]
        # series that share the table but are NOT references must not leak in
        + [
            ("Cash (liquid fund)", weeks[0].date(), 1.0),
            ("Nifty50 Equal Weight TRI", weeks[0].date(), 5.0),
        ]
    )

    # tmp_path, not the default data/: the CSV fills series the database lacks, so a live
    # data/stocks/benchmarks_weekly.csv would add every other reference (BL-018).
    refs = load_references(tmp_path)

    assert list(refs.columns) == [NIFTY50_TRI, NIFTY200_MOMENTUM30_TRI]
    assert list(refs[NIFTY50_TRI]) == [10.0, 11.0, 12.0]
    assert list(refs[NIFTY200_MOMENTUM30_TRI]) == [20.0, 22.0, 24.0]
    assert isinstance(refs.index, pd.DatetimeIndex)  # same index type the CSV path produces


def test_load_references_falls_back_to_the_csv_when_the_catalog_has_no_series(tmp_path):
    """A catalog that exists but hasn't been migrated (the dashboard's saved-runs call creates
    one on first use) must not hide the CSV - and must not crash."""
    from trading_data.db import connect

    with connect():
        pass  # creates the empty catalog
    weeks = pd.date_range("2016-01-01", periods=4, freq="W-FRI")
    _write_csv(tmp_path, weeks, [1.0, 2.0, 3.0, 4.0], [5.0, 6.0, 7.0, 8.0])

    refs = load_references(tmp_path)

    assert list(refs[NIFTY50_TRI]) == [1.0, 2.0, 3.0, 4.0]
