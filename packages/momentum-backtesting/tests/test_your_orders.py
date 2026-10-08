"""BL-051 Phase 3: Your orders - settings, holdings snapshots, the paper portfolio, the message."""

import pytest
from fastapi.testclient import TestClient

from momentum_backtesting import api, holdings_store
from momentum_backtesting.db_read import open_catalog


@pytest.fixture
def client():
    return TestClient(api.create_app())


def test_settings_default_to_rs_10000_minimum_and_a_rs_1_lakh_paper_portfolio(client):
    got = client.get("/api/orders").json()
    assert got["settings"]["min_trade_rs"] == 10_000
    assert got["settings"]["paper_capital_rs"] == 100_000
    assert got["settings"]["holdings_source"] == "paper"
    assert got["holdings"] is None and got["orders"] == []
    saved = client.put("/api/orders/settings", json={"min_trade_rs": 5000}).json()
    assert saved["min_trade_rs"] == 5000 and saved["paper_capital_rs"] == 100_000
    assert client.put("/api/orders/settings", json={"holdings_source": "broker"}).status_code == 422


def test_pasted_holdings_are_a_snapshot_and_rules_exclude_or_count_as_cash(client):
    pasted = client.post(
        "/api/holdings/paste", json={"text": "SBIN 10\nNSE:M&M-EQ, 2\n\n# note\nSBIN 5"}
    ).json()
    assert pasted["source"] == "paste"
    assert {r["symbol"]: r["quantity"] for r in pasted["rows"]} == {"M&M": 2, "SBIN": 15}
    bad = client.post("/api/holdings/paste", json={"text": "SBIN ten"})
    assert bad.status_code == 422 and "Line 1" in bad.json()["detail"]
    assert client.put(
        "/api/holdings/rules", json={"symbol": "liquidbees", "treatment": "cash"}
    ).json() == {"LIQUIDBEES": "cash"}
    assert client.put("/api/holdings/rules", json={"symbol": "LIQUIDBEES"}).json() == {}


def _headline(client):
    run = client.post(
        "/api/saved-runs",
        json={
            "dataset": "broad",
            "name": "Broad headline",
            "config": {"dataset": "broad", "signal_delay": 1},
            "kpis": {},
            "dates": [],
            "strategy": [],
        },
    ).json()
    client.patch(f"/api/saved-runs/{run['id']}", json={"active": True})
    return run


class _Ranking:
    column_to_base_symbol = {"AAA": "AAA", "BBB": "BBB", "CCC#2": "CCC"}


def test_orders_against_the_paper_portfolio_are_saved_and_summarised(client, monkeypatch):
    _headline(client)
    signal = {
        "week": "2026-10-09",
        "weights": {"AAA": 0.5, "BBB": 0.5},
        "target_weights": {"AAA": 0.5, "CCC#2": 0.5},
        "rows": [],
        "sleeves": [],
    }
    monkeypatch.setattr(api, "_orders_signal", lambda *a: (signal, "exact", None, _Ranking()))
    monkeypatch.setattr(
        api,
        "_order_prices",
        lambda ranking, names, as_of: ({"AAA": 100.0, "BBB": 50.0, "CCC#2": 250.0}, "last close"),
    )
    payload = api._compute_orders("scheduled")
    plan = payload["plan"]
    assert payload["kind"] == "exact" and payload["holdings"] == {
        "source": "paper",
        "capital": 100_000,
    }
    rows = {r["symbol"]: (r["action"], r["quantity"]) for r in plan["rows"]}
    assert rows["BBB"] == ("SELL", 1000)  # 50,000 / 50
    assert rows["CCC#2"] == ("BUY", 200)  # 50,000 / 250
    assert rows["AAA"] == ("", 0)
    stored = client.get("/api/orders", params={"week": "2026-10-09"}).json()["orders"]
    assert len(stored) == 1 and stored[0]["trigger"] == "scheduled"
    note = api._orders_message(payload)
    assert "paper portfolio of ₹100,000" in note.body
    assert "• SELL BBB 1000 sh" in note.body and "• BUY CCC#2 200 sh" in note.body
    assert note.type == "momentum.orders"


def test_a_strategy_that_decides_on_fridays_close_says_why_there_are_no_orders_yet(
    client, monkeypatch
):
    _headline(client)
    monkeypatch.setattr(
        api,
        "_orders_signal",
        lambda *a: (None, "unavailable", "Broad headline decides on Friday's own close.", None),
    )
    payload = api._compute_orders()
    assert "plan" not in payload and "own close" in payload["reason"]
    assert api._orders_message(payload).severity == "warn"


def test_orders_need_a_headline(client):
    assert api._compute_orders()["error"] == "No headline favourite."


def test_owner_settings_are_per_owner(monkeypatch):
    with open_catalog() as con:
        holdings_store.save_settings(con, "rahul", min_trade_rs=7000)
        assert holdings_store.settings(con, "friend")["min_trade_rs"] == 10_000
        assert holdings_store.settings(con, "rahul")["min_trade_rs"] == 7000
