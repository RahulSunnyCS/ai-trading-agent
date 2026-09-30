"""Live preview calculations never require credentials in these unit tests."""

from datetime import date, datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pandas as pd
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from momentum_backtesting import api, fyers, rebalance
from momentum_backtesting.api import RebalanceRequest, rebalance_preview
from momentum_backtesting.engine import IDLE, Config, Result
from momentum_backtesting.rebalance import broad_quote_symbols, build_plan, model_holdings
from momentum_backtesting.stocks.ui_data import StockDataset


def test_plan_sells_before_buys_and_counts_idle_cash():
    rows = build_plan(
        {"C0001": 60, IDLE: 40},
        {"C0001": 0.25, "C0002": 0.5, IDLE: 0.25},
        {"C0001": 100, "C0002": 250},
        {"C0001": "NSE:AAA-EQ", "C0002": "NSE:BBB-EQ"},
        100_000,
    )
    assert [(row["asset"], row["action"]) for row in rows] == [
        ("C0001", "SELL"),
        (IDLE, "SELL"),
        ("C0002", "BUY"),
    ]
    assert rows[-1]["indicative_quantity"] == 200
    assert rows[-1]["indicative_value"] == 50_000


def test_plan_rejects_missing_live_price():
    with pytest.raises(ValueError, match="No tradeable LTP"):
        build_plan({}, {"C0002": 1.0}, {}, {}, 100_000)


def test_plan_rejects_overallocated_holdings():
    with pytest.raises(ValueError, match="more than 100"):
        build_plan({"A": 80, "B": 30}, {}, {}, {}, 100_000)


def test_broad_quotes_only_active_split_segment():
    ranking = SimpleNamespace(
        prices=pd.DataFrame({"AAA": [100], "AAA#2": [50]}, index=[pd.Timestamp("2026-09-25")]),
        global_ranks=pd.DataFrame({"AAA": [2], "AAA#2": [1]}),
        column_to_base_symbol={"AAA": "AAA", "AAA#2": "AAA"},
        stale_columns={"AAA": pd.Timestamp("2020-01-01")},
    )
    result = broad_quote_symbols(ranking)
    assert result["AAA#2"] == "NSE:AAA-EQ"
    assert "AAA" not in result


def test_live_stock_ltp_is_scaled_to_total_return_units_without_mutating_history(monkeypatch):
    week = pd.Timestamp("2026-09-25")
    prices = pd.DataFrame({"C0001": [200.0]}, index=[week])
    stock = StockDataset(
        prices=prices,
        price_only=prices.copy(),
        membership=pd.DataFrame({"C0001": [True]}, index=[week]),
        companies={"C0001": "Example"},
        tax_classes={},
        last_week=week,
    )
    monkeypatch.setattr(rebalance, "active_aliases", lambda today: {"C0001": "EXAMPLE"})
    monkeypatch.setattr(rebalance, "last_raw_closes", lambda data_dir: {"C0001": 100.0})
    live, membership, ltp, symbols = rebalance.live_stock_prices(
        stock, ["C0001"], {}, {"NSE:EXAMPLE-EQ": 110.0}, date(2026, 9, 30)
    )
    assert live.at[pd.Timestamp("2026-10-02"), "C0001"] == pytest.approx(220.0)
    assert prices.at[week, "C0001"] == 200.0
    assert membership.at[pd.Timestamp("2026-10-02"), "C0001"]
    assert ltp == {"C0001": 110.0}
    assert symbols == {"C0001": "NSE:EXAMPLE-EQ"}


def test_model_holdings_reads_signal_week_not_last_row():
    week = pd.Timestamp("2026-10-02")
    result = Result(
        config=Config(),
        equity=pd.Series(dtype=float),
        benchmark=pd.Series(dtype=float),
        cash=pd.Series(dtype=float),
        weights=pd.DataFrame(
            {"A": [0.2, 0.7], IDLE: [0.8, 0.3]}, index=[week - pd.Timedelta(days=7), week]
        ),
        holdings=pd.DataFrame(),
        trades=pd.DataFrame(),
        ranks=pd.DataFrame(),
        scores=pd.DataFrame(),
    )
    assert model_holdings(result, week) == {"A": 0.7, IDLE: 0.3}


def test_preview_rejects_outside_market_hours_before_fyers():
    request = RebalanceRequest(
        dataset="stock",
        universe=["C0001"],
        portfolio_value=100_000,
    )
    with pytest.raises(HTTPException, match="market hours"):
        rebalance_preview(request, now=datetime(2026, 9, 30, 8, 0, tzinfo=ZoneInfo("Asia/Kolkata")))


def test_local_browser_oauth_caches_token_only_after_valid_state(monkeypatch):
    monkeypatch.setattr(api, "load_repo_env", lambda: None)
    monkeypatch.setattr(fyers, "_oauth_config", lambda: ("APP-100", "secret", "callback"))
    monkeypatch.setattr(fyers, "_cached_token", lambda: None)
    monkeypatch.setattr(
        fyers,
        "build_auth_url",
        lambda: ("https://api-t1.fyers.in/login?state=test-state", "test-state"),
    )
    saved = []
    monkeypatch.setattr(fyers, "exchange_auth_code", lambda code: ("token", code))
    monkeypatch.setattr(fyers, "save_token", lambda token: saved.append(token))
    client = TestClient(api.create_app())

    assert client.get("/api/auth/fyers/status").json()["connected"] is False
    started = client.get("/api/auth/fyers/start", follow_redirects=False)
    assert started.status_code == 302
    assert started.headers["cache-control"] == "no-store"
    assert client.get("/api/auth/fyers/callback?state=wrong&auth_code=A").status_code == 400
    assert saved == []
    accepted = client.get("/callback?state=test-state&auth_code=A")
    assert accepted.status_code == 200
    assert saved == [("token", "A")]
    assert client.get("/api/auth/fyers/callback?state=test-state&auth_code=A").status_code == 400
