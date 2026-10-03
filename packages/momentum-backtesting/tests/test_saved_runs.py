"""P4: momentum's "Saved runs" moved from localStorage into the shared trading-data
catalog (see runs_store.py). Exercised at both layers: runs_store.py directly against
a DuckDB connection, and the /api/saved-runs routes through a TestClient - the isolated
TRADING_DATA_ROOT from conftest.py means these never touch the real catalog."""

import threading
import time
from datetime import date

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from trading_data.db import connect

from momentum_backtesting import api, fyers, local_store, notify, runs_store, weekly
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

    activated_first = client.patch(f"/api/saved-runs/{first['id']}", json={"active": True}).json()
    assert activated_first["favorite"] is True
    assert activated_first["active"] is True

    activated_second = client.patch(f"/api/saved-runs/{second['id']}", json={"active": True}).json()
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


def test_favorite_and_overlay_runs_are_never_pruned(client):
    favorite = client.post("/api/saved-runs", json=_payload(name="Fav")).json()["id"]
    overlay = client.post("/api/saved-runs", json=_payload(name="Overlay")).json()["id"]
    client.patch(f"/api/saved-runs/{favorite}", json={"favorite": True})
    client.patch(f"/api/saved-runs/{overlay}", json={"overlay": True})
    for i in range(15):
        client.post("/api/saved-runs", json=_payload(name=f"Run {i}"))
    listed_ids = {r["id"] for r in client.get("/api/saved-runs", params={"dataset": "etf"}).json()}
    assert {favorite, overlay} <= listed_ids
    assert len(listed_ids) == 12  # 10 ordinary + the two kept ones


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
    assert response.status_code == 202
    assert response.json()["started"] is True
    job = _wait_for_weekly_job(client)
    assert job["status"] == "done"
    assert job["result"]["sent_to_telegram"] is True
    assert [item["title"] for item in job["result"]["strategies"]] == [
        "Active",
        "Dashboard only",
    ]
    assert sent == [active_result.notification]


def _wait_for_weekly_job(client) -> dict:
    for _ in range(200):
        job = client.get("/api/weekly/jobs/latest").json()["job"]
        if job["status"] != "running":
            return job
        time.sleep(0.02)
    raise AssertionError("weekly job never finished")


def test_a_second_weekly_trigger_attaches_to_the_running_job(client, monkeypatch):
    release = threading.Event()

    def slow(*args, **kwargs):
        release.wait(5)
        return []

    monkeypatch.setattr(weekly, "run_favorite_strategies", slow)
    monkeypatch.setattr(fyers, "resolve_credentials", lambda: None)
    first = client.post("/api/weekly/run", json={"run": "preview", "send": False}).json()
    second = client.post("/api/weekly/run", json={"run": "final", "send": True}).json()
    release.set()
    assert first["started"] is True and second["started"] is False
    assert second["job"]["id"] == first["job"]["id"]
    job = _wait_for_weekly_job(client)
    assert job["status"] == "done" and job["result"]["sent_to_telegram"] is False


def test_a_failing_weekly_job_reports_the_error_instead_of_spinning(client, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("sources down")

    monkeypatch.setattr(weekly, "run_favorite_strategies", boom)
    monkeypatch.setattr(fyers, "resolve_credentials", lambda: None)
    client.post("/api/weekly/run", json={"run": "final", "send": False})
    job = _wait_for_weekly_job(client)
    assert job["status"] == "failed" and "sources down" in job["error"]


def test_a_blocked_active_favorite_sends_a_telegram_warning_instead_of_nothing(client, monkeypatch):
    """A4 regression: the active favourite failing used to print 'Telegram was not sent'
    and exit 0 — nobody found out. It must now send a warning explaining why."""
    active = client.post("/api/saved-runs", json=_payload("Active")).json()
    client.patch(f"/api/saved-runs/{active['id']}", json={"active": True})
    monkeypatch.setattr(
        weekly,
        "run_favorite_strategies",
        lambda *args, **kwargs: [
            {
                "id": active["id"],
                "name": "Active",
                "dataset": "etf",
                "active": True,
                "result": None,
                "blocked": "tax needs tax_classes (instrument -> equity/gold_silver/...)",
            }
        ],
    )
    monkeypatch.setattr(fyers, "resolve_credentials", lambda: None)
    sent = []
    monkeypatch.setattr(notify, "send", sent.append)
    monkeypatch.setattr(notify, "run_url", lambda: None)

    response = client.post("/api/weekly/run", json={"run": "final", "send": True})
    job = _wait_for_weekly_job(client)
    assert response.status_code == 202 and job["status"] == "done"
    assert job["result"]["sent_to_telegram"] is True
    assert len(sent) == 1
    assert sent[0].severity == "warning"
    assert "Active" in sent[0].body
    assert "tax needs tax_classes" in sent[0].body


def test_no_active_favorite_sends_a_telegram_warning_too(client, monkeypatch):
    client.post("/api/saved-runs", json=_payload("Dashboard only"))
    monkeypatch.setattr(weekly, "run_favorite_strategies", lambda *args, **kwargs: [])
    monkeypatch.setattr(fyers, "resolve_credentials", lambda: None)
    sent = []
    monkeypatch.setattr(notify, "send", sent.append)

    client.post("/api/weekly/run", json={"run": "final", "send": True})
    job = _wait_for_weekly_job(client)
    assert job["status"] == "done"
    assert len(sent) == 1
    assert "no active favourite" in sent[0].title.lower()


def test_an_only_dataset_restriction_skips_telegram_for_an_out_of_scope_active_favorite(
    client, monkeypatch
):
    """B4: the Friday stock-ingest job reruns the orchestration with --only-dataset so it
    doesn't resend an already-sent ETF favourite's signal."""
    active = client.post("/api/saved-runs", json=_payload("ETF Core")).json()
    client.patch(f"/api/saved-runs/{active['id']}", json={"active": True})
    etf_result = weekly.RunResult(Notification("test", "info", "ETF Core", "A"), {"rows": []})
    monkeypatch.setattr(
        weekly,
        "run_favorite_strategies",
        lambda *args, **kwargs: [
            {
                "id": active["id"],
                "name": "ETF Core",
                "dataset": "etf",
                "active": True,
                "result": etf_result,
                "blocked": None,
            }
        ],
    )
    monkeypatch.setattr(fyers, "resolve_credentials", lambda: None)
    sent = []
    monkeypatch.setattr(notify, "send", sent.append)

    body = api.WeeklyRunBody(run="final", send=True, only_if_active_dataset=["stock", "broad"])
    result = api._execute_weekly_run(body)
    assert result["sent_to_telegram"] is False
    assert sent == []


def test_stocks_sync_calls_stocks_fetch_and_migrate_with_real_arguments(monkeypatch):
    """Regression: `stocks_fetch`/`local_migrate` are Typer commands whose parameters default
    to `typer.Option(...)` sentinels, resolved only when Typer's own CLI runner invokes them.
    `cli.stocks_sync` (and `api._execute_stock_sync`, which calls it) call them directly as
    plain Python functions — calling `stocks_fetch(skip_download=False)` alone left `from_`
    as that unresolved sentinel and crashed with `TypeError: fromisoformat: argument must be
    str` the first time this ran for real, which every mocked test above missed."""
    from momentum_backtesting import cli

    seen = {}
    monkeypatch.setattr(cli, "stocks_fetch", lambda **kwargs: seen.setdefault("fetch", kwargs))
    monkeypatch.setattr(cli, "local_migrate", lambda: seen.setdefault("migrate", True))

    cli.stocks_sync()

    assert isinstance(seen["fetch"]["from_"], str)
    assert seen["fetch"]["skip_download"] is False
    assert seen["migrate"] is True


def test_stocks_sync_falls_back_to_both_fyers_topups_when_nse_fails(monkeypatch):
    """When `stocks_fetch` fails with an `NseError`, `stocks_sync` must run BOTH Fyers
    stopgaps (Nifty 50 + Total Market), not just one — Stock, Broad and Custom Index
    favourites all share the same underlying blocked-gate symptom."""
    from momentum_backtesting import cli, fyers
    from momentum_backtesting.stocks import fyers_topup
    from momentum_backtesting.stocks.nse import NseError

    def boom(**kwargs):  # noqa: ARG001
        raise NseError("browser warm-up failed")

    calls = {}

    def fake_nifty50_topup(creds):
        calls["nifty50"] = creds
        return None

    def fake_total_market_topup(creds, data_dir):
        calls["total_market"] = (creds, data_dir)
        return None

    monkeypatch.setattr(cli, "stocks_fetch", boom)
    monkeypatch.setattr(fyers, "resolve_credentials", lambda: fyers.Credentials("a", "b", "test"))
    monkeypatch.setattr(fyers_topup, "run_fyers_topup", fake_nifty50_topup)
    monkeypatch.setattr(fyers_topup, "run_fyers_topup_total_market", fake_total_market_topup)

    cli.stocks_sync()

    assert "nifty50" in calls
    assert "total_market" in calls


def test_stocks_sync_no_fallback_flag_reraises_the_nse_error(monkeypatch):
    from momentum_backtesting import cli
    from momentum_backtesting.stocks.nse import NseError

    def boom(**kwargs):  # noqa: ARG001
        raise NseError("browser warm-up failed")

    monkeypatch.setattr(cli, "stocks_fetch", boom)

    with pytest.raises(NseError):
        cli.stocks_sync(fallback_to_fyers=False)


def test_weekly_stock_sync_endpoint_runs_in_the_background(client, monkeypatch):
    monkeypatch.setattr(api, "_execute_stock_sync", lambda: {"ok": True})
    response = client.post("/api/weekly/stock-sync")
    assert response.status_code == 202
    assert response.json()["started"] is True
    for _ in range(200):
        job = client.get("/api/weekly/stock-sync/jobs/latest").json()["job"]
        if job["status"] != "running":
            break
        time.sleep(0.02)
    assert job["status"] == "done" and job["result"] == {"ok": True}


def test_weekly_status_says_how_far_each_dataset_is_ingested(client, tmp_path, monkeypatch):
    class Stock:
        last_week = pd.Timestamp("2026-09-25")

    prices = pd.DataFrame({"x": [1.0]}, index=pd.to_datetime(["2026-10-02"]))
    monkeypatch.setattr(api.DATA, "get", lambda: prices)
    monkeypatch.setattr(api.DATA, "get_stock", lambda: Stock())
    # Isolate from this checkout's real launchd-weekly-*.log files, whose mtimes reflect
    # actual past runs (which may themselves have run late) and would make the
    # ran_late_by_minutes assertion below depend on this machine's history.
    monkeypatch.setattr(api, "DATA_DIR", tmp_path)
    with connect() as con:
        local_store.save_signal(con, "2026-09-25", "final", "Core", {"rows": []})
    status = api._weekly_status(date(2026, 10, 2))
    assert [(item["week"], item["run"]) for item in status["signals"]] == [("2026-09-25", "final")]
    assert status["target_week"] == "2026-10-02"
    by_key = {item["key"]: item for item in status["datasets"]}
    assert by_key["etf"]["through"] == "2026-10-02" and by_key["etf"]["ready"] is True
    assert by_key["stock"]["through"] == "2026-09-25" and by_key["stock"]["ready"] is False
    assert [item["run"] for item in status["schedule"]] == [
        "preview",
        "final",
        "stock-ingest",
    ]
    assert all(item["ran_late_by_minutes"] is None for item in status["schedule"])


def test_weekly_status_flags_a_scheduled_run_that_fired_late(client, tmp_path, monkeypatch):
    """B5: launchd only fires while the Mac is awake, so a missed 14:40 slot runs late on
    wake with no marker of its own — the status panel must say so, not look normal."""
    import os

    monkeypatch.setattr(api, "DATA_DIR", tmp_path)
    log = tmp_path / "launchd-weekly-preview.log"
    log.write_text("No eligible active favourite; Telegram was not sent.\n")
    # The scheduled time is 14:40 IST; back-date the log's mtime to simulate a run that
    # actually fired at 15:22 IST that same day (42 minutes late).
    ran_at = api.datetime(2026, 10, 2, 15, 22, tzinfo=api.IST)
    os.utime(log, (ran_at.timestamp(), ran_at.timestamp()))
    status = api._weekly_status(date(2026, 10, 2))
    preview = next(item for item in status["schedule"] if item["run"] == "preview")
    assert preview["ran_late_by_minutes"] == 42
