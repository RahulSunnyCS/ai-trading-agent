"""P4: momentum's "Saved runs" moved from localStorage into the shared trading-data
catalog (see runs_store.py). Exercised at both layers: runs_store.py directly against
a DuckDB connection, and the /api/saved-runs routes through a TestClient - the isolated
TRADING_DATA_ROOT from conftest.py means these never touch the real catalog."""

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from trading_data.db import connect

from momentum_backtesting import api, fyers, notify, runs_store, weekly
from momentum_backtesting.notify import Notification


@pytest.fixture
def client():
    return TestClient(api.create_app())


def _payload(name: str = "Run 1", dataset: str = "etf") -> dict:
    return {
        "dataset": dataset,
        "name": name,
        "config": {"top_n": 5, "lookbacks": [1, 4, 13, 26, 52]},
        "kpis": {"cagr": 0.18, "sharpe": 1.2},
        "dates": ["2020-01-03", "2020-01-10"],
        "strategy": [100.0, 101.5],
        "overlay": False,
    }


def test_save_list_and_the_record_shape_matches_the_frontend_type(client):
    saved = client.post("/api/saved-runs", json=_payload()).json()
    assert saved["name"] == "Run 1"
    assert saved["n"] == 1
    assert saved["config"] == {"top_n": 5, "lookbacks": [1, 4, 13, 26, 52]}
    assert saved["kpis"] == {"cagr": 0.18, "sharpe": 1.2}
    assert saved["dates"] == ["2020-01-03", "2020-01-10"]
    assert saved["strategy"] == [100.0, 101.5]
    assert saved["overlay"] is False
    assert saved["favorite"] is False
    assert saved["active"] is False
    assert "id" in saved

    listed = client.get("/api/saved-runs", params={"dataset": "etf"}).json()
    assert len(listed) == 1
    assert listed[0]["id"] == saved["id"]


def test_datasets_are_isolated_from_each_other(client):
    client.post("/api/saved-runs", json=_payload(dataset="etf"))
    client.post("/api/saved-runs", json=_payload(dataset="stock"))
    assert len(client.get("/api/saved-runs", params={"dataset": "etf"}).json()) == 1
    assert len(client.get("/api/saved-runs", params={"dataset": "stock"}).json()) == 1
    assert client.get("/api/saved-runs", params={"dataset": "broad"}).json() == []


def test_rename_and_toggle_overlay(client):
    saved = client.post("/api/saved-runs", json=_payload()).json()
    patched = client.patch(
        f"/api/saved-runs/{saved['id']}", json={"name": "Renamed", "overlay": True}
    ).json()
    assert patched["name"] == "Renamed"
    assert patched["overlay"] is True
    # kpis/dates/strategy survive a rename untouched.
    assert patched["kpis"] == saved["kpis"]
    assert patched["dates"] == saved["dates"]


def test_favorites_are_persistent_and_only_one_can_be_active(client):
    first = client.post("/api/saved-runs", json=_payload("First")).json()
    second = client.post("/api/saved-runs", json=_payload("Second")).json()

    activated_first = client.patch(
        f"/api/saved-runs/{first['id']}", json={"active": True}
    ).json()
    assert activated_first["favorite"] is True
    assert activated_first["active"] is True

    activated_second = client.patch(
        f"/api/saved-runs/{second['id']}", json={"active": True}
    ).json()
    assert activated_second["favorite"] is True
    assert activated_second["active"] is True
    listed = {item["id"]: item for item in client.get("/api/saved-runs").json()}
    assert listed[first["id"]]["favorite"] is True
    assert listed[first["id"]]["active"] is False

    favorites = client.get("/api/favorite-strategies").json()
    assert [item["id"] for item in favorites] == [second["id"], first["id"]]

    removed_favorite = client.patch(
        f"/api/saved-runs/{second['id']}", json={"favorite": False}
    ).json()
    assert removed_favorite["favorite"] is False
    assert removed_favorite["active"] is False


def test_delete_removes_it_from_the_list(client):
    saved = client.post("/api/saved-runs", json=_payload()).json()
    response = client.delete(f"/api/saved-runs/{saved['id']}")
    assert response.status_code == 200
    assert client.get("/api/saved-runs", params={"dataset": "etf"}).json() == []


def test_patching_or_deleting_an_unknown_run_is_a_clear_404(client):
    assert client.patch("/api/saved-runs/does-not-exist", json={"name": "x"}).status_code == 404
    assert client.delete("/api/saved-runs/does-not-exist").status_code == 404


def test_more_than_ten_runs_prunes_the_oldest_per_dataset(client):
    ids = [
        client.post("/api/saved-runs", json=_payload(name=f"Run {i}")).json()["id"]
        for i in range(12)
    ]
    listed = client.get("/api/saved-runs", params={"dataset": "etf"}).json()
    assert len(listed) == 10
    listed_ids = {run["id"] for run in listed}
    assert set(ids[:2]).isdisjoint(listed_ids)  # the two oldest were pruned
    assert set(ids[2:]) == listed_ids


def test_rerunning_the_same_config_reuses_the_strategy_version(tmp_path):
    with connect() as con:
        first = runs_store.save_run(
            con, "etf", name="A", config={"top_n": 5}, kpis={}, dates=[], strategy=[]
        )
        second = runs_store.save_run(
            con, "etf", name="B", config={"top_n": 5}, kpis={}, dates=[], strategy=[]
        )
        rows = con.execute(
            "SELECT version_id FROM backtest_runs WHERE run_id IN (?, ?)",
            [first["id"], second["id"]],
        ).fetchall()
    assert rows[0][0] == rows[1][0]
    assert first["id"] != second["id"]


def test_bhavcopy_backed_favorite_is_blocked_until_target_week(monkeypatch):
    class Stock:
        last_week = pd.Timestamp("2026-09-18")

    monkeypatch.setattr(api.DATA, "get_stock", lambda: Stock())
    favorite = {
        "name": "Stock rotation",
        "config": {"dataset": "stock", "universe": ["C0001"]},
    }
    result, blocked = api._research_weekly_result(favorite, pd.Timestamp("2026-09-25"))
    assert result is None
    assert "bhavcopy-backed data is complete through 18 Sep 2026" in blocked


def test_bhavcopy_backed_favorite_uses_saved_start_and_builds_signal(monkeypatch):
    class Stock:
        last_week = pd.Timestamp("2026-09-25")

    monkeypatch.setattr(api.DATA, "get_stock", lambda: Stock())
    seen = {}

    def backtest(req):
        seen["start"] = req.start
        return {
            "latest": {
                "week": "2026-09-25",
                "rows": [{"asset": "C0001", "action": "BUY", "rank": 1}],
            }
        }

    monkeypatch.setattr(api, "_stock_backtest", backtest)
    favorite = {
        "name": "Stock rotation",
        "config": {
            "dataset": "stock",
            "universe": ["C0001"],
            "start": "2020-01-03",
        },
    }
    result, blocked = api._research_weekly_result(favorite, pd.Timestamp("2026-09-25"))
    assert blocked is None
    assert seen["start"] == "2020-01-03"
    assert result.signal["rows"][0]["action"] == "BUY"
    assert "NSE bhavcopy" in result.notification.body


def test_weekly_endpoint_sends_only_the_active_favorite(client, monkeypatch):
    active = client.post("/api/saved-runs", json=_payload("Active")).json()
    inactive = client.post("/api/saved-runs", json=_payload("Dashboard only")).json()
    client.patch(f"/api/saved-runs/{active['id']}", json={"active": True})
    client.patch(f"/api/saved-runs/{inactive['id']}", json={"favorite": True})

    active_result = weekly.RunResult(Notification("test", "info", "Active", "A"), {"rows": []})
    inactive_result = weekly.RunResult(
        Notification("test", "info", "Dashboard only", "B"), {"rows": []}
    )
    monkeypatch.setattr(
        weekly,
        "run_favorite_strategies",
        lambda *args, **kwargs: [
            {
                "id": active["id"],
                "name": "Active",
                "dataset": "etf",
                "active": True,
                "result": active_result,
                "blocked": None,
            },
            {
                "id": inactive["id"],
                "name": "Dashboard only",
                "dataset": "etf",
                "active": False,
                "result": inactive_result,
                "blocked": None,
            },
        ],
    )
    monkeypatch.setattr(fyers, "resolve_credentials", lambda: None)
    sent = []
    monkeypatch.setattr(notify, "send", sent.append)
    monkeypatch.setattr(notify, "run_url", lambda: None)

    response = client.post("/api/weekly/run", json={"run": "final", "send": True})
    assert response.status_code == 200
    assert response.json()["sent_to_telegram"] is True
    assert [item["title"] for item in response.json()["strategies"]] == [
        "Active",
        "Dashboard only",
    ]
    assert sent == [active_result.notification]
