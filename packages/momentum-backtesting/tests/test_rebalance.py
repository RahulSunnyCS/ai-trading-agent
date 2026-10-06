"""Live preview calculations never require credentials in these unit tests."""

from datetime import date, datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from momentum_backtesting import api, fyers, rebalance
from momentum_backtesting.api import RebalanceRequest, rebalance_preview
from momentum_backtesting.engine import IDLE, Config, Result
from momentum_backtesting.rebalance import (
    broad_quote_symbols,
    build_plan,
    model_holdings,
    operational_rebalance_schedule,
)
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


def test_as_of_plan_keeps_weight_change_when_persisted_price_is_missing():
    rows = build_plan({}, {"C0002": 1.0}, {}, {}, 100_000, allow_missing_prices=True)
    assert rows == [
        {
            "asset": "C0002",
            "symbol": None,
            "action": "BUY",
            "current_pct": 0.0,
            "target_pct": 100.0,
            "delta_pct": 100.0,
            "ltp": None,
            "indicative_value": 100_000.0,
            "indicative_quantity": None,
        }
    ]


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


def test_live_broad_ranking_rebuilds_the_pool_with_the_rankings_own_series_rule(
    monkeypatch, tmp_path
):
    """The live preview rebuilds pool membership and the liquidity gate. They must come from the
    same price-series rule as the ranking, or their columns describe different segments."""
    weeks = pd.date_range("2026-01-02", "2026-09-25", freq="W-FRI")
    columns = ["AAA", *rebalance.broad.ATOMIC_NAMES]
    prices = pd.DataFrame(100.0, index=weeks, columns=columns)
    ranking = rebalance.broad.UniverseRanking(
        prices=prices,
        weeks=list(weeks),
        global_ranks=pd.DataFrame(1.0, index=weeks, columns=columns),
        pool_membership=pd.DataFrame(True, index=weeks, columns=["AAA"]),
        stock_pool_ranks=pd.DataFrame(1.0, index=weeks, columns=["AAA"]),
        combined_pool_ranks=pd.DataFrame(1.0, index=weeks, columns=columns),
        column_to_base_symbol={"AAA": "AAA"},
        events=pd.DataFrame(),
        stale_columns={},
        missing_symbols=[],
    )
    (tmp_path / "daily_etf").mkdir()
    for name in ("Nasdaq 100", "Hang Seng"):
        pd.DataFrame({"close": [50.0]}).to_csv(tmp_path / "daily_etf" / f"{name}.csv")
    quotes = dict.fromkeys(broad_quote_symbols(ranking).values(), 100.0)
    seen = {}

    class Stop(Exception):
        pass

    def universe_frame(**kwargs):
        seen.update(kwargs)
        raise Stop

    monkeypatch.setattr(rebalance.broad, "load_stock_universe_frame", universe_frame)
    for policy in ("verified", "legacy"):
        with pytest.raises(Stop):
            rebalance.live_broad_ranking(
                ranking,
                quotes,
                date(2026, 9, 30),
                Config(lookbacks=(1, 2)),
                pool_top_n=10,
                pool_exit_rank=20,
                data_dir=tmp_path,
                series_breaks=policy,
            )
        assert seen["series_breaks"] == policy


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


def test_operational_schedule_anchors_every_four_weeks_to_live_start():
    between = operational_rebalance_schedule(
        date(2026, 10, 2),
        strategy_start=date(2026, 9, 18),
        rebalance_kind="weekly",
        every=4,
    )
    assert between == {
        "strategy_start_date": "2026-09-18",
        "cadence": "every_n_weeks",
        "interval_weeks": 4,
        "effective_rebalance_offset": 3,
        "is_rebalance_week": False,
        "previous_rebalance_date": "2026-09-18",
        "current_rebalance_date": None,
        "next_rebalance_date": "2026-10-16",
    }

    scheduled = operational_rebalance_schedule(
        date(2026, 10, 16),
        strategy_start=date(2026, 9, 18),
        rebalance_kind="weekly",
        every=4,
    )
    assert scheduled["is_rebalance_week"] is True
    assert scheduled["previous_rebalance_date"] == "2026-09-18"
    assert scheduled["current_rebalance_date"] == "2026-10-16"
    assert scheduled["next_rebalance_date"] == "2026-11-13"


def test_operational_schedule_before_first_allocation_has_no_previous_date():
    schedule = operational_rebalance_schedule(
        date(2026, 10, 2),
        strategy_start=date(2026, 10, 4),
        rebalance_kind="weekly",
        every=2,
    )
    assert schedule["is_rebalance_week"] is False
    assert schedule["previous_rebalance_date"] is None
    assert schedule["next_rebalance_date"] == "2026-10-09"


def test_operational_monthly_schedule_uses_month_end_fridays():
    schedule = operational_rebalance_schedule(
        date(2026, 10, 2),
        strategy_start=date(2026, 9, 20),
        rebalance_kind="monthly",
        every=1,
    )
    assert schedule["cadence"] == "monthly"
    assert schedule["previous_rebalance_date"] == "2026-09-25"
    assert schedule["next_rebalance_date"] == "2026-10-30"
    assert schedule["is_rebalance_week"] is False


def test_preview_uses_persisted_close_outside_market_hours_without_fyers(monkeypatch):
    week = pd.Timestamp("2026-10-02")
    prices = pd.DataFrame({"C0001": [200.0]}, index=[week])
    stock = StockDataset(
        prices=prices,
        price_only=prices.copy(),
        membership=pd.DataFrame({"C0001": [True]}, index=[week]),
        companies={"C0001": "Example"},
        tax_classes={"C0001": "equity"},
        last_week=week,
    )
    outcome = Result(
        config=Config(),
        equity=pd.Series(dtype=float),
        benchmark=pd.Series(dtype=float),
        cash=pd.Series(dtype=float),
        weights=pd.DataFrame({"C0001": [1.0]}, index=[week]),
        holdings=pd.DataFrame(),
        trades=pd.DataFrame(),
        ranks=pd.DataFrame(),
        scores=pd.DataFrame(),
    )
    monkeypatch.setattr(api.DATA, "get_stock", lambda: stock)
    monkeypatch.setattr(
        rebalance,
        "persisted_stock_prices",
        lambda *_args, **_kwargs: ({"C0001": 100.0}, {"C0001": "NSE:EXAMPLE-EQ"}),
    )
    captured = {}

    def stock_target(*args):
        captured["config"] = args[-1]
        return outcome

    monkeypatch.setattr(rebalance, "stock_target", stock_target)
    monkeypatch.setattr(
        fyers,
        "resolve_credentials",
        lambda **_kwargs: pytest.fail("off-hours preview must not resolve Fyers credentials"),
    )
    request = RebalanceRequest(
        dataset="stock",
        universe=["C0001"],
        portfolio_value=100_000,
        strategy_start_date=date(2026, 9, 18),
        rebalance_every=4,
        rebalance_offset=0,
    )
    result = rebalance_preview(
        request, now=datetime(2026, 10, 4, 0, 28, tzinfo=ZoneInfo("Asia/Kolkata"))
    )

    assert result["price_mode"] == "last_close"
    assert result["price_source"] == "Latest database close"
    assert result["as_of"] == "2026-10-02"
    assert result["first_allocation"] is True
    assert result["rebalance_schedule"]["previous_rebalance_date"] == "2026-09-18"
    assert result["rebalance_schedule"]["next_rebalance_date"] == "2026-10-16"
    assert result["rebalance_schedule"]["is_rebalance_week"] is False
    # First allocation: replay only the signal week and trade at once, ignoring the cadence phase.
    assert captured["config"].start == "2026-10-02"
    assert captured["config"].rebalance_every == 1
    assert captured["config"].rebalance_offset == 0
    buy = next(row for row in result["rows"] if row["asset"] == "C0001")
    assert buy["indicative_quantity"] == 1_000


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
    stored_in_db = []
    monkeypatch.setattr(fyers, "save_token_to_db", lambda token: stored_in_db.append(token))
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
    assert stored_in_db == [("token", "A")]
    assert client.get("/api/auth/fyers/callback?state=test-state&auth_code=A").status_code == 400


def test_fyers_start_does_not_loop_when_redirect_uri_is_the_dashboard(monkeypatch):
    # FYERS_REDIRECT_URI pointing at the dashboard (no Fastify server) used to bounce
    # start -> dashboard start -> start forever, leaving the browser on a blank page.
    monkeypatch.setattr(api, "load_repo_env", lambda: None)
    monkeypatch.setenv("DATABASE_URL", "postgresql://example/db")
    monkeypatch.setattr(
        fyers, "_oauth_config", lambda: ("APP-100", "secret", "http://127.0.0.1:5190/cb")
    )
    monkeypatch.setattr(fyers, "build_auth_url", lambda: ("https://api-t1.fyers.in/login", "s"))
    client = TestClient(api.create_app())

    first = client.get("/api/auth/fyers/start", follow_redirects=False)
    assert first.headers["location"] == "http://127.0.0.1:5190/api/auth/fyers/start?handoff=1"
    returned = client.get("/api/auth/fyers/start?handoff=1", follow_redirects=False)
    assert returned.headers["location"] == "https://api-t1.fyers.in/login"


def test_fyers_status_reports_a_token_fyers_rejects_as_expired(monkeypatch):
    from datetime import UTC, datetime, timedelta

    monkeypatch.setattr(api, "load_repo_env", lambda: None)
    monkeypatch.setattr(fyers, "_oauth_config", lambda: ("APP-100", "secret", "callback"))
    creds = fyers.Credentials("APP-100", "tok", "test", datetime.now(UTC) + timedelta(hours=5))
    monkeypatch.setattr(fyers, "resolve_credentials", lambda **_: creds)
    client = TestClient(api.create_app())

    monkeypatch.setattr(fyers, "probe_token", lambda _c: "valid")
    ok = client.get("/api/auth/fyers/status").json()
    assert ok["connected"] is True and "revoked" not in ok

    monkeypatch.setattr(fyers, "probe_token", lambda _c: "rejected")
    dead = client.get("/api/auth/fyers/status").json()
    assert dead["connected"] is False and dead["needsReauth"] is True and dead["revoked"] is True

    monkeypatch.setattr(fyers, "probe_token", lambda _c: "unknown")  # Fyers unreachable
    assert client.get("/api/auth/fyers/status").json()["connected"] is True


def test_fyers_token_expiry_is_the_next_0600_ist():
    from datetime import UTC, datetime

    # 15:00 IST login dies at 06:00 IST the next morning (15h later), not 24h later.
    login = datetime(2026, 10, 6, 9, 30, tzinfo=UTC)
    assert fyers.token_expiry(login, 86_400) == datetime(2026, 10, 7, 0, 30, tzinfo=UTC)
    # Logged in 05:00 IST: the same morning's 06:00 reset.
    early = datetime(2026, 10, 5, 23, 30, tzinfo=UTC)
    assert fyers.token_expiry(early) == datetime(2026, 10, 6, 0, 30, tzinfo=UTC)
    # A shorter expires_in from Fyers still wins.
    assert fyers.token_expiry(login, 3_600) == datetime(2026, 10, 6, 10, 30, tzinfo=UTC)
