"""BL-142 Phase 1: Zerodha Kite, read-only — the client, the login routes, the Kite holdings
source in Your orders (free cash counted, options-margin holdings left out) and the Friday
reminder."""

import hashlib
import io
import json
import stat
import urllib.error
import urllib.parse
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from momentum_backtesting import api, cli, holdings_store, kite, notify
from momentum_backtesting.db_read import open_catalog


@pytest.fixture(autouse=True)
def kite_env(monkeypatch, tmp_path):
    monkeypatch.setenv("KITE_API_KEY", "key123")
    monkeypatch.setenv("KITE_API_SECRET", "secret456")
    monkeypatch.setattr(kite, "TOKEN_CACHE", tmp_path / ".kite_token.json")


@pytest.fixture
def client():
    return TestClient(api.create_app())


class FakeKite:
    """Kite's API, answering by path; records every request made."""

    def __init__(self, routes):
        self.routes = routes
        self.requests = []

    def __call__(self, request, timeout=None):
        path = urllib.parse.urlparse(request.full_url).path
        self.requests.append(
            (request.get_method(), path, dict(request.header_items()), request.data)
        )
        answer = self.routes[path]
        if isinstance(answer, urllib.error.HTTPError):
            raise answer
        return io.BytesIO(json.dumps({"status": "success", "data": answer}).encode())


def _creds():
    return kite.Credentials("key123", "tok", datetime.now(UTC) + timedelta(hours=2), "BZ0001")


HOLDINGS = [
    {"tradingsymbol": "SBIN", "quantity": 10, "t1_quantity": 5, "average_price": 800.0},
    {"tradingsymbol": "NAVINFLUOR-BE", "quantity": 2, "t1_quantity": 0, "average_price": 4000.0},
    {"tradingsymbol": "LIQUIDBEES", "quantity": 100, "t1_quantity": 0, "average_price": 1000.0},
    {"tradingsymbol": "SGBJUN31I-GB", "quantity": 4, "t1_quantity": 0, "average_price": 5000.0},
    {"tradingsymbol": "OLDNAME", "quantity": 0, "t1_quantity": 0, "average_price": 10.0},
]


def test_holdings_count_t1_drop_the_series_and_never_touch_an_order_endpoint(monkeypatch):
    fake = FakeKite(
        {
            "/portfolio/holdings": HOLDINGS,
            "/user/margins/equity": {"net": 12345.5, "available": {"collateral": 0}},
        }
    )
    monkeypatch.setattr(kite.urllib.request, "urlopen", fake)
    got = {h["symbol"]: h for h in kite.holdings(_creds())}
    assert set(got) == {"SBIN", "NAVINFLUOR", "LIQUIDBEES", "SGBJUN31I-GB"}
    assert got["SBIN"]["quantity"] == 15 and got["SBIN"]["avg_price"] == pytest.approx(800.0)
    assert kite.free_cash(_creds()) == 12345.5
    for method, path, headers, _data in fake.requests:
        assert method == "GET" and "order" not in path
        assert headers["Authorization"] == "token key123:tok"
        assert headers["X-kite-version"] == "3"


def test_the_login_exchange_checks_the_checksum_and_caches_the_token_privately(monkeypatch):
    fake = FakeKite({"/session/token": {"access_token": "fresh", "user_id": "BZ0001"}})
    monkeypatch.setattr(kite.urllib.request, "urlopen", fake)
    creds = kite.exchange_request_token("req789")
    method, path, _headers, data = fake.requests[0]
    body = urllib.parse.parse_qs(data.decode())
    assert (method, path) == ("POST", "/session/token")
    assert body["checksum"] == [hashlib.sha256(b"key123req789secret456").hexdigest()]
    # dies at the next 06:00 IST, like Fyers
    ist = creds.expires_at.astimezone(notify.IST)
    assert (ist.hour, ist.minute) == (6, 0) and creds.expires_at > datetime.now(UTC)
    kite.save_token(creds)
    assert stat.S_IMODE(kite.TOKEN_CACHE.stat().st_mode) == 0o600
    assert kite.cached_credentials().access_token == "fresh"
    # a token minted for another app is useless with this key
    monkeypatch.setenv("KITE_API_KEY", "otherkey")
    assert kite.cached_credentials() is None


def test_an_expired_token_is_not_used_and_a_refusal_is_a_login_error(monkeypatch):
    kite.save_token(
        kite.Credentials("key123", "old", datetime.now(UTC) - timedelta(minutes=1), None)
    )
    assert kite.cached_credentials() is None
    with pytest.raises(kite.KiteCredentialsError):
        kite.resolve_credentials()
    refused = urllib.error.HTTPError(
        "u", 403, "Forbidden", {}, io.BytesIO(b'{"error_type":"TokenException","message":"bad"}')
    )
    monkeypatch.setattr(kite.urllib.request, "urlopen", FakeKite({"/user/profile": refused}))
    assert kite.probe(_creds()) is False


def test_status_says_not_configured_without_the_keys(client, monkeypatch):
    monkeypatch.setenv("KITE_API_KEY", "")
    got = client.get("/api/kite/status").json()
    assert got["configured"] is False and got["connected"] is False
    assert client.post("/api/kite/login").status_code == 503


def test_a_login_comes_back_once_stores_the_token_and_reads_holdings_and_cash(client, monkeypatch):
    client.put("/api/orders/settings", json={"holdings_source": "kite"})
    url = client.post("/api/kite/login").json()["url"]
    query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    assert url.startswith("https://kite.zerodha.com/connect/login?")
    assert query["api_key"] == ["key123"] and query["v"] == ["3"]
    state = urllib.parse.parse_qs(query["redirect_params"][0])["state"][0]

    assert client.get("/api/kite/callback", params={"state": "forged"}).status_code == 400
    fake = FakeKite(
        {
            "/session/token": {"access_token": "fresh", "user_id": "BZ0001"},
            "/portfolio/holdings": HOLDINGS,
            "/user/margins/equity": {"net": 350_000.0, "available": {"collateral": 300_000.0}},
            "/user/profile": {"user_id": "BZ0001"},
        }
    )
    monkeypatch.setattr(kite.urllib.request, "urlopen", fake)
    params = {"state": state, "request_token": "req", "status": "success"}
    done = client.get("/api/kite/callback", params=params)
    assert done.status_code == 200 and "Holdings read: 4 names" in done.text
    assert client.get("/api/kite/callback", params=params).status_code == 400  # used once

    status = client.get("/api/kite/status").json()
    assert status["connected"] is True and status["userId"] == "BZ0001"
    assert status["lastSnapshot"]["cash"] == 50_000.0
    assert status["lastSnapshot"]["excluded"] == ["LIQUIDBEES", "SGBJUN31I-GB"]
    view = client.get("/api/orders").json()
    assert view["holdings"]["source"] == "kite" and view["holdings"]["cash"] == 50_000.0
    assert view["margin"] == {"symbols": ["LIQUIDBEES"], "prefixes": ["SGB"]}


def test_kite_orders_count_free_cash_and_leave_out_the_options_margin(client, monkeypatch):
    from test_your_orders import _headline, _strategy

    _headline(client)
    client.put("/api/orders/settings", json={"holdings_source": "kite"})
    with open_catalog() as con:
        holdings_store.save_holdings(
            con,
            holdings_store.owner(),
            "kite",
            [
                {"symbol": "AAA", "quantity": 30, "avg_price": 90.0},
                {"symbol": "LIQUIDBEES", "quantity": 100, "avg_price": 1000.0},
                {"symbol": "SGBMAR29-GB", "quantity": 2, "avg_price": 6000.0},
            ],
            cash=25_000.0,
        )
        # an older Fyers snapshot is not what a Kite owner holds
        holdings_store.save_holdings(
            con, holdings_store.owner(), "fyers", [{"symbol": "BBB", "quantity": 1}]
        )
    signal = {
        "week": "2026-10-23",
        "weights": {},
        "target_weights": {"AAA": 0.5, "CCC#2": 0.5},
        "rows": [],
        "sleeves": [],
    }
    monkeypatch.setattr(api, "_orders_signal", lambda *a: (signal, "exact", None, ["ranking"]))
    _strategy(monkeypatch, {"AAA": 100.0, "BBB": 50.0, "CCC#2": 250.0})
    payload = api._compute_orders()
    rows = {r["symbol"]: (r["action"], r["held"]) for r in payload["plan"]["rows"]}
    assert payload["holdings"]["source"] == "kite"
    assert payload["holdings"]["excluded"] == ["LIQUIDBEES", "SGBMAR29-GB"]
    assert payload["plan"]["cash"] == 25_000.0
    assert "BBB" not in rows and rows["AAA"][1] == 30
    note = api._orders_message(payload)
    assert "your Kite holdings" in note.body and "Free cash in Kite: ₹25,000 (counted" in note.body


def test_the_options_margin_is_always_left_out_whatever_the_rules_say():
    assert holdings_store.treatment("LIQUIDBEES", {}) == "exclude"
    assert holdings_store.treatment("SGBDEC30-GB", {}) == "exclude"
    # an old "count LIQUIDBEES as cash" rule must never spend the options margin
    assert holdings_store.treatment("LIQUIDBEES", {"LIQUIDBEES": "cash"}) == "exclude"
    assert holdings_store.treatment("SBIN", {"SBIN": "cash"}) == "cash"
    assert holdings_store.treatment("SBIN", {}) is None


def test_free_cash_leaves_out_pledged_collateral_and_never_goes_below_zero(monkeypatch):
    margins = {"net": 320_000.0, "available": {"cash": 20_000.0, "collateral": 300_000.0}}
    monkeypatch.setattr(kite.urllib.request, "urlopen", FakeKite({"/user/margins/equity": margins}))
    assert kite.free_cash(_creds()) == 20_000.0
    margins.update(net=250_000.0)  # open options use more than the cash
    assert kite.free_cash(_creds()) == 0.0


def test_a_slow_or_garbled_kite_answer_is_a_runtime_error(monkeypatch):
    def slow(request, timeout=None):
        raise TimeoutError("read timed out")

    monkeypatch.setattr(kite.urllib.request, "urlopen", slow)
    with pytest.raises(RuntimeError, match="TimeoutError"):
        kite.holdings(_creds())
    monkeypatch.setattr(
        kite.urllib.request, "urlopen", lambda request, timeout=None: io.BytesIO(b"<html>")
    )
    with pytest.raises(RuntimeError):
        kite.free_cash(_creds())


def test_the_friday_reminder_speaks_only_when_kite_is_used_and_not_logged_in(monkeypatch):
    sent = []
    monkeypatch.setattr(notify, "send", lambda note: sent.append(note))
    runner = CliRunner()

    out = runner.invoke(cli.app, ["kite", "remind", "--send"])
    assert out.exit_code == 0 and "not 'kite'" in out.output and sent == []

    with open_catalog() as con:
        holdings_store.save_settings(con, holdings_store.owner(), holdings_source="kite")
    out = runner.invoke(cli.app, ["kite", "remind", "--send"])
    assert out.exit_code == 0 and len(sent) == 1
    assert sent[0].type == "broker.kite" and "Broker logins" in sent[0].body

    kite.save_token(_creds())
    monkeypatch.setattr(kite, "probe", lambda creds: True)
    out = runner.invoke(cli.app, ["kite", "remind", "--send"])
    assert out.exit_code == 0 and "nothing to remind" in out.output and len(sent) == 1
