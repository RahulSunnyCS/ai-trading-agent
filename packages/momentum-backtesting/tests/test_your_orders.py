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


def _strategy(monkeypatch, prices):
    """The strategy's names, their Fyers symbols and stored prices, without a real ranking."""
    symbols = {
        "AAA": "NSE:AAA-EQ",
        "BBB": "NSE:BBB-EQ",
        "CCC#2": "NSE:CCC-EQ",
        "Nasdaq 100": "NSE:MON100-EQ",
    }
    monkeypatch.setattr(api, "_strategy_symbols", lambda rankings, today: (prices, symbols))
    monkeypatch.setattr(
        api,
        "_order_prices",
        lambda stored, symbols, names: ({n: stored[n] for n in names if n in stored}, "last close"),
    )


def test_orders_against_the_paper_portfolio_are_saved_and_summarised(client, monkeypatch):
    _headline(client)
    signal = {
        "week": "2026-10-09",
        "weights": {"AAA": 0.5, "BBB": 0.5},
        "target_weights": {"AAA": 0.5, "CCC#2": 0.5},
        "rows": [],
        "sleeves": [],
    }
    monkeypatch.setattr(api, "_orders_signal", lambda *a: (signal, "exact", None, ["ranking"]))
    _strategy(monkeypatch, {"AAA": 100.0, "BBB": 50.0, "CCC#2": 250.0})
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
    # Saved under the week the run is for, which follows today's date (a Saturday run is for
    # the next Friday), not the mocked signal's week.
    stored = client.get("/api/orders", params={"week": payload["week"]}).json()["orders"]
    assert len(stored) == 1 and stored[0]["trigger"] == "scheduled"
    note = api._orders_message(payload)
    assert "paper portfolio of ₹100,000" in note.body
    assert "• SELL BBB 1000 sh" in note.body and "• BUY CCC#2 200 sh" in note.body
    assert note.type == "momentum.orders"


def test_start_fresh_buys_every_target_name_from_cash(client, monkeypatch):
    _headline(client)
    signal = {
        "week": "2026-10-09",
        "weights": {"AAA": 0.5, "BBB": 0.5},  # last week's model: ignored when starting fresh
        "target_weights": {"AAA": 0.5, "CCC#2": 0.5},
        "rows": [],
        "sleeves": [],
    }
    monkeypatch.setattr(api, "_orders_signal", lambda *a: (signal, "exact", None, ["ranking"]))
    _strategy(monkeypatch, {"AAA": 100.0, "BBB": 50.0, "CCC#2": 250.0})
    payload = api._compute_orders("manual", start_fresh=True)
    rows = {r["symbol"]: (r["action"], r["quantity"]) for r in payload["plan"]["rows"]}
    assert payload["holdings"]["fresh"] is True
    assert rows["AAA"] == ("BUY", 500) and rows["CCC#2"] == ("BUY", 200)
    assert "BBB" not in rows and payload["plan"]["sells"] == 0


def test_orders_can_be_planned_for_a_named_favourite_without_making_it_the_headline(
    client, monkeypatch
):
    _headline(client)
    other = client.post(
        "/api/saved-runs",
        json={
            "dataset": "broad",
            "name": "Other favourite",
            "config": {"dataset": "broad", "signal_delay": 0},  # not a repeat of the headline
            "kpis": {},
            "dates": [],
            "strategy": [],
        },
    ).json()
    client.patch(f"/api/saved-runs/{other['id']}", json={"favorite": True})
    seen = []
    monkeypatch.setattr(
        api,
        "_orders_signal",
        lambda headline, *a: seen.append(headline["name"]) or (None, "x", "r", []),
    )
    assert api._compute_orders(favourite="other fav")["headline"]["name"] == "Other favourite"
    assert api._compute_orders()["headline"]["name"] == "Broad headline"
    assert seen == ["Other favourite", "Broad headline"]


def test_a_strategy_that_decides_on_fridays_close_says_why_there_are_no_orders_yet(
    client, monkeypatch
):
    _headline(client)
    monkeypatch.setattr(
        api,
        "_orders_signal",
        lambda *a: (None, "unavailable", "Broad headline decides on Friday's own close.", []),
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


def test_fyers_holdings_map_to_the_strategys_names_and_others_are_never_sold(client, monkeypatch):
    """A series-break stock maps to the column traded now, an ETF to its asset, the engine's idle
    cash is cash, and a holding outside the strategy is left alone rather than sold."""
    from momentum_backtesting.engine import IDLE

    _headline(client)
    client.put("/api/orders/settings", json={"holdings_source": "fyers", "extra_cash_rs": 1000})
    client.post(
        "/api/holdings/paste",
        json={"text": "CCC 10\nMON100 40\nRELIANCE 20\nAAA 30\nLIQUIDBEES 100"},
    )
    client.put("/api/holdings/rules", json={"symbol": "LIQUIDBEES", "treatment": "cash"})
    signal = {
        "week": "2026-10-09",
        "weights": {},
        "target_weights": {"CCC#2": 0.5, "Nasdaq 100": 0.3, IDLE: 0.2},
        "rows": [],
        "sleeves": [],
    }
    monkeypatch.setattr(api, "_orders_signal", lambda *a: (signal, "exact", None, ["ranking"]))
    _strategy(monkeypatch, {"AAA": 100.0, "CCC#2": 250.0, "Nasdaq 100": 200.0})
    payload = api._compute_orders()
    rows = {r["symbol"]: (r["action"], r["held"]) for r in payload["plan"]["rows"]}
    assert payload["holdings"]["outside"] == ["RELIANCE"]
    assert "RELIANCE" not in rows and "CCC" not in rows and "MON100" not in rows
    assert rows["CCC#2"][1] == 10 and rows["Nasdaq 100"][1] == 40
    assert rows["AAA"] == ("SELL", 30)  # a strategy name the model no longer holds
    assert IDLE not in rows
    # LIQUIDBEES counted as cash (a paste has no average price, so 0) + the extra cash.
    assert payload["plan"]["cash"] == 1000


def test_a_favourite_name_that_matches_two_groups_is_refused_not_guessed(client, monkeypatch):
    favourites = [
        {"id": "g1", "name": "Five Sectors, Rank Sum", "group": ["a"]},
        {"id": "g2", "name": "Five Sectors, Wide Pool", "group": ["b"]},
        {"id": "a", "name": "Five Sectors, Rank Sum · Friday 1 of 2", "group": None},
    ]
    assert api._find_favourite(favourites, "g2")[0]["id"] == "g2"
    assert api._find_favourite(favourites, "five sectors, rank sum")[0]["id"] == "g1"
    # A group beats its own sleeves, which share its name.
    assert api._find_favourite(favourites, "Rank Sum")[0]["id"] == "g1"
    found, why = api._find_favourite(favourites, "Five Sectors")
    assert found is None and "matches 2 favourites" in why and "Wide Pool" in why
    assert api._find_favourite(favourites, "nothing")[1] == "No favourite matches 'nothing'."


def test_fresh_needs_the_paper_source(client, monkeypatch):
    _headline(client)
    client.put("/api/orders/settings", json={"holdings_source": "fyers"})
    payload = api._compute_orders("manual", start_fresh=True)
    assert "paper portfolio" in payload["error"] and "'fyers'" in payload["error"]
    assert "plan" not in payload
