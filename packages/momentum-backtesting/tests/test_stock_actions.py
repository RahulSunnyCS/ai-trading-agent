"""Confirmed share-count changes affect returns; price-only clues remain review items."""

from __future__ import annotations

import json
from datetime import date

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from trading_data.db import connect

from momentum_backtesting.api import app
from momentum_backtesting.categories.broad import price_ceiling_mask
from momentum_backtesting.categories.prices import build_stock_weekly_prices
from momentum_backtesting.stock_actions import review_snapshot, save_review, scan_and_store


def test_confirmed_factors_chain_and_raw_entry_price_stays_raw(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    with connect(tmp_path) as con:
        ids = {}
        for symbol in ("DIXON", "CRASH"):
            ids[symbol] = con.execute(
                "INSERT INTO instruments (instrument_key, asset_class, exchange, symbol) "
                "VALUES (?, 'stock', 'NSE', ?) RETURNING instrument_id",
                [f"stock:NSE:{symbol}", symbol],
            ).fetchone()[0]

    bars = pd.DataFrame(
        [
            (ids["DIXON"], "DIXON", "2021-03-12", 100.0, 100, 10000.0),
            (ids["DIXON"], "DIXON", "2021-03-17", 100.0, 100, 10000.0),
            (ids["DIXON"], "DIXON", "2021-03-18", 21.0, 1500, 31500.0),
            (ids["DIXON"], "DIXON", "2021-03-19", 22.0, 1000, 22000.0),
            (ids["DIXON"], "DIXON", "2025-01-02", 50.0, 100, 5000.0),
            (ids["DIXON"], "DIXON", "2025-01-03", 26.0, 200, 5200.0),
            (ids["CRASH"], "CRASH", "2021-03-12", 100.0, 100, 10000.0),
            (ids["CRASH"], "CRASH", "2021-03-18", 21.0, 1000, 25000.0),
        ],
        columns=["instrument_id", "symbol", "date", "close", "volume", "turnover"],
    ).drop(columns="symbol")
    bars["date"] = pd.to_datetime(bars["date"])
    path = tmp_path / "lake" / "bars_1d" / "asset=stock" / "year=2021" / "data.parquet"
    path.parent.mkdir(parents=True)
    bars.to_parquet(path, index=False)

    raw_dir = tmp_path / "raw"
    ca_dir = raw_dir / "corporate_actions"
    ca_dir.mkdir(parents=True)
    (ca_dir / "ca_2021.json").write_text(
        json.dumps(
            [
                {
                    "symbol": "DIXON",
                    "series": "EQ",
                    "isin": "X",
                    "faceVal": "2",
                    "exDate": "18-Mar-2021",
                    "recDate": "19-Mar-2021",
                    "subject": "Face Value Split From Rs 10 To Rs 2",
                },
                {
                    "symbol": "DIXON",
                    "series": "EQ",
                    "isin": "X",
                    "faceVal": "2",
                    "exDate": "03-Jan-2025",
                    "recDate": "04-Jan-2025",
                    "subject": "Bonus 1:1",
                },
            ]
        )
    )
    with connect(tmp_path) as con:
        report = scan_and_store(con, raw_dir)
        events = con.execute(
            "SELECT symbol, ex_date, confirmed_factor, cumulative_factor, status "
            "FROM stock_action_candidates ORDER BY symbol, ex_date"
        ).fetchall()
        assert report == {"candidates": 3, "confirmed": 2, "crash": 0, "review": 1}
        assert events[0][0] == "CRASH" and events[0][-1] == "review"
        assert [(r[2], r[3], r[4]) for r in events[1:]] == [
            (5.0, 5.0, "confirmed"),
            (2.0, 10.0, "confirmed"),
        ]

    adjusted, detected, _, raw = build_stock_weekly_prices(
        ["DIXON", "CRASH"], stocks_data_dir=tmp_path, return_raw_weekly=True
    )
    assert adjusted.loc["2021-03-12", "DIXON"] == pytest.approx(10.0)
    assert raw.loc["2021-03-12", "DIXON"] == pytest.approx(100.0)
    assert adjusted.loc["2021-03-19", "DIXON"] == pytest.approx(11.0)
    assert adjusted.loc["2025-01-03", "DIXON"] == pytest.approx(26.0)
    assert adjusted.loc["2021-03-19", "CRASH#2"] == pytest.approx(21.0)
    assert detected.symbol.tolist() == ["CRASH"]  # old heuristic needs the review
    assert bool(price_ceiling_mask(raw, 20.0).loc["2021-03-12", "DIXON"])
    assert not bool(price_ceiling_mask(adjusted, 20.0).loc["2021-03-12", "DIXON"])

    with connect(tmp_path) as con:
        save_review(
            con,
            symbol="CRASH",
            ex_date=date(2021, 3, 18),
            decision="crash",
            factor=None,
            source_url="https://example.com/report",
            note="Confirmed market move",
        )
        assert scan_and_store(con, raw_dir)["crash"] == 1
        assert review_snapshot(con)["manual_review_after"] == "2025-01-03"
    adjusted_after_review, events_after_review, _, _ = build_stock_weekly_prices(
        ["DIXON", "CRASH"], stocks_data_dir=tmp_path, return_raw_weekly=True
    )
    assert events_after_review.empty
    assert adjusted_after_review.loc["2021-03-19", "CRASH"] == pytest.approx(21.0)


def test_dashboard_reviews_only_new_simple_events(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    with connect(tmp_path) as con:
        con.execute(
            "INSERT INTO stock_action_scan_state (id, manual_review_after) VALUES (1, '2025-01-01')"
        )
        con.execute(
            "INSERT INTO category_membership (category, year, symbol) "
            "VALUES ('Total Market', 2025, 'ABC')"
        )
        for event_date, kind in [
            ("2024-12-31", None),
            ("2025-01-02", None),
            ("2025-01-03", "demerger"),
        ]:
            con.execute(
                """INSERT INTO stock_action_candidates
                   (symbol, ex_date, previous_close, close, previous_volume, volume,
                    previous_turnover, turnover, implied_factor, suggested_factor,
                    cumulative_factor, status, event_kind)
                   VALUES ('ABC', ?, 100, 50, 100, 200, 10000, 10000, 2, 2, 1,
                           'review', ?)""",
                [event_date, kind],
            )
    client = TestClient(app)
    data = client.get("/api/stock-actions").json()
    assert data["pending_count"] == 2
    assert [item["ex_date"] for item in data["items"]] == ["2025-01-03", "2025-01-02"]
    payload = {
        "symbol": "ABC",
        "decision": "bonus",
        "factor": 2,
        "source_url": "https://example.com/filing",
        "note": None,
    }
    assert (
        client.post(
            "/api/stock-actions/review", json={**payload, "ex_date": "2024-12-31"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/stock-actions/review", json={**payload, "ex_date": "2025-01-03"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/stock-actions/review", json={**payload, "ex_date": "2025-01-02"}
        ).status_code
        == 200
    )
    with connect(tmp_path, read_only=True) as con:
        assert (
            con.execute(
                "SELECT cumulative_factor FROM stock_action_candidates "
                "WHERE symbol='ABC' AND ex_date='2025-01-02'"
            ).fetchone()[0]
            == 2.0
        )
