"""P4: momentum's "Saved runs" moved from localStorage into the shared trading-data
catalog (see runs_store.py). Exercised at both layers: runs_store.py directly against
a DuckDB connection, and the /api/saved-runs routes through a TestClient - the isolated
TRADING_DATA_ROOT from conftest.py means these never touch the real catalog."""

import itertools
import threading
import time
from datetime import date, datetime

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from trading_data.db import connect

from momentum_backtesting import api, fyers, local_store, notify, runs_store, weekly
from momentum_backtesting.notify import IST, Notification


@pytest.fixture
def client():
    return TestClient(api.create_app())


_DISTINCT = itertools.count()


def _payload(name: str = "Run 1", dataset: str = "etf") -> dict:
    # Each payload its own strategy (BL-052: the same settings again would be a repeat of one,
    # and these tests make separate favourites); cost_pct, read by every dataset, differs.
    return {
        "dataset": dataset,
        "name": name,
        "config": {
            "top_n": 5,
            "lookbacks": [1, 4, 13, 26, 52],
            "cost_pct": round(0.10 + next(_DISTINCT) % 50 / 100, 2),
        },
        "kpis": {"cagr": 0.18, "sharpe": 1.2},
        "dates": ["2020-01-03", "2020-01-10"],
        "strategy": [100.0, 101.5],
        "overlay": False,
    }


def test_save_list_and_the_record_shape_matches_the_frontend_type(client):
    saved = client.post("/api/saved-runs", json=_payload()).json()
    assert saved["name"] == "Run 1"
    assert saved["n"] == 1
    assert saved["config"]["top_n"] == 5
    assert saved["config"]["lookbacks"] == [1, 4, 13, 26, 52]
    assert saved["kpis"] == {"cagr": 0.18, "sharpe": 1.2}
    assert saved["dates"] == ["2020-01-03", "2020-01-10"]
    assert saved["strategy"] == [100.0, 101.5]
    assert saved["overlay"] is False
    assert saved["favorite"] is False
    assert saved["active"] is False
    assert "id" in saved
    assert "T" in saved["created_at"]

    listed = client.get("/api/saved-runs", params={"dataset": "etf"}).json()
    assert len(listed) == 1
    assert listed[0]["id"] == saved["id"]
    assert listed[0]["created_at"] == saved["created_at"]


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


def _distinct(i: int, name: str | None = None) -> dict:
    """A run of its own strategy (BL-052: the same settings again is a repeat of one)."""
    payload = _payload(name=name or f"Run {i}")
    payload["config"] = {**payload["config"], "top_n": i + 1}
    return payload


def test_more_than_ten_strategies_prunes_the_oldest_per_dataset(client):
    ids = [client.post("/api/saved-runs", json=_distinct(i)).json()["id"] for i in range(12)]
    listed = client.get("/api/saved-runs", params={"dataset": "etf"}).json()
    assert len(listed) == 10
    listed_ids = {run["id"] for run in listed}
    assert set(ids[:2]).isdisjoint(listed_ids)  # the two oldest were pruned
    assert set(ids[2:]) == listed_ids


def test_favorite_and_overlay_runs_are_never_pruned(client):
    favorite = client.post("/api/saved-runs", json=_distinct(100, "Fav")).json()["id"]
    overlay = client.post("/api/saved-runs", json=_distinct(101, "Overlay")).json()["id"]
    client.patch(f"/api/saved-runs/{favorite}", json={"favorite": True})
    client.patch(f"/api/saved-runs/{overlay}", json={"overlay": True})
    for i in range(15):
        client.post("/api/saved-runs", json=_distinct(i))
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
    assert sent[0].severity == "warn"
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
    etf_result = weekly.RunResult(
        Notification("test", "info", "ETF Core", "A"),
        {"week": "2026-10-09", "rows": [], "weights": {}},
    )
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
    # The ETF signal is not resent; only the forward journal's witness line goes out (BL-024).
    assert [note.title for note in sent] == ["Momentum final: forward journal"]


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
        "journal-check",
        "live-rules",
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


# --- BL-051: favourite status, the Paper + Invested limit, groups -------------------------


def _favourite(client, name: str, status: str, dataset: str = "etf") -> dict:
    run = client.post("/api/saved-runs", json=_payload(name, dataset)).json()
    response = client.patch(f"/api/saved-runs/{run['id']}", json={"status": status})
    assert response.status_code == 200, response.text
    return response.json()


def test_a_favourite_has_a_status_and_older_favourites_read_as_watching(client):
    plain = client.post("/api/saved-runs", json=_payload("Plain")).json()
    assert plain["status"] is None
    legacy = client.patch(f"/api/saved-runs/{plain['id']}", json={"favorite": True}).json()
    assert legacy["favorite"] is True and legacy["status"] == "watching"
    paper = client.patch(f"/api/saved-runs/{plain['id']}", json={"status": "paper"}).json()
    assert paper["status"] == "paper"
    dropped = client.patch(f"/api/saved-runs/{plain['id']}", json={"status": "none"}).json()
    assert dropped["favorite"] is False and dropped["status"] is None


def test_the_headline_is_always_followed(client):
    run = _favourite(client, "Watched", "watching")
    headline = client.patch(f"/api/saved-runs/{run['id']}", json={"active": True}).json()
    assert headline["active"] is True and headline["status"] == "paper"
    back = client.patch(f"/api/saved-runs/{run['id']}", json={"status": "watching"}).json()
    assert back["active"] is False


def test_paper_and_invested_are_capped_at_eight_and_watching_is_not(client):
    for i in range(runs_store.MAX_FOLLOWED):
        _favourite(client, f"Followed {i}", "paper" if i % 2 else "invested", "broad")
    ninth = client.post("/api/saved-runs", json=_payload("Ninth", "broad")).json()
    refused = client.patch(f"/api/saved-runs/{ninth['id']}", json={"status": "paper"})
    assert refused.status_code == 409
    assert "Set one to Watching first" in refused.json()["detail"]
    assert client.patch(f"/api/saved-runs/{ninth['id']}", json={"active": True}).status_code == 409
    watching = client.patch(f"/api/saved-runs/{ninth['id']}", json={"status": "watching"})
    assert watching.status_code == 200
    # A followed favourite can still move between Paper and Invested at the limit.
    first = client.get("/api/favorite-strategies").json()[0]
    flipped = client.patch(f"/api/saved-runs/{first['id']}", json={"status": "invested"})
    assert flipped.status_code == 200


def test_a_group_is_one_favourite_with_one_status_and_one_slot(client):
    members = [_favourite(client, f"Sleeve {i}", "paper", "broad") for i in range(4)]
    client.patch(f"/api/saved-runs/{members[1]['id']}", json={"active": True})
    response = client.post(
        "/api/saved-runs/groups",
        json={"name": "Phase 6 ensemble", "members": [m["id"] for m in members]},
    )
    assert response.status_code == 200, response.text
    group = response.json()
    assert group["status"] == "paper" and group["active"] is True
    assert group["group"] == [m["id"] for m in members]
    assert group["config"] == {"dataset": "broad", "group": [m["id"] for m in members]}

    with connect() as con:
        assert runs_store.followed_count(con) == 1  # four sleeves, one slot
        # Members are still favourites (run and journalled), just not groups.
        assert {f["id"] for f in runs_store.list_favorites(con)} == {m["id"] for m in members}
        (listed,) = runs_store.list_groups(con)
    assert [m["id"] for m in listed["members"]] == [m["id"] for m in members]
    assert all(m["member_of"] == group["id"] and m["status"] is None for m in listed["members"])

    favourites = client.get("/api/favorite-strategies").json()
    assert favourites[0]["id"] == group["id"] and len(favourites[0]["members"]) == 4

    # A member follows its group; the group cannot be unfollowed, only deleted.
    member = client.patch(f"/api/saved-runs/{members[0]['id']}", json={"status": "watching"})
    assert member.status_code == 409 and "Phase 6 ensemble" in member.json()["detail"]
    assert client.delete(f"/api/saved-runs/{members[0]['id']}").status_code == 409
    unfollow = client.patch(f"/api/saved-runs/{group['id']}", json={"status": "none"})
    assert unfollow.status_code == 409


def test_deleting_a_group_keeps_its_runs_as_watching_favourites(client):
    members = [_favourite(client, f"Sleeve {i}", "paper", "broad") for i in range(2)]
    group = client.post(
        "/api/saved-runs/groups", json={"name": "Pair", "members": [m["id"] for m in members]}
    ).json()
    assert client.delete(f"/api/saved-runs/{group['id']}").status_code == 200
    listed = {r["id"]: r for r in client.get("/api/saved-runs", params={"dataset": "broad"}).json()}
    assert set(listed) == {m["id"] for m in members}
    assert all(r["status"] == "watching" and r["member_of"] is None for r in listed.values())


def test_a_group_needs_two_runs_of_one_dataset(client):
    etf = _favourite(client, "ETF", "watching", "etf")
    broad = _favourite(client, "Broad", "watching", "broad")
    mixed = client.post(
        "/api/saved-runs/groups", json={"name": "Mixed", "members": [etf["id"], broad["id"]]}
    )
    assert mixed.status_code == 409 and "same dataset" in mixed.json()["detail"]
    single = client.post(
        "/api/saved-runs/groups", json={"name": "One", "members": [etf["id"], etf["id"]]}
    )
    assert single.status_code == 409


def test_a_group_headline_sends_one_combined_message_and_journals_each_sleeve(client, monkeypatch):
    members = [_favourite(client, f"Sleeve {i}", "paper", "broad") for i in range(2)]
    group = client.post(
        "/api/saved-runs/groups", json={"name": "Pair", "members": [m["id"] for m in members]}
    ).json()
    client.patch(f"/api/saved-runs/{group['id']}", json={"active": True})

    def signal(holds: str, buys: str | None, on_cadence: bool) -> dict:
        rows = [{"asset": holds, "action": "HOLD", "rank": 1}]
        target = {holds: 1.0}
        if buys:
            rows.append({"asset": buys, "action": "BUY", "rank": 3})
            target = {holds: 0.5, buys: 0.5}
        return {
            "week": "2026-12-04",
            "rows": rows,
            "weights": {holds: 1.0},
            "target_weights": target,
            "sleeve_value": 1.0,
            "rebalance": {"on_cadence": on_cadence, "every": 4, "next": "2026-12-11"},
        }

    results = {
        members[0]["id"]: signal("BSE", "ANGELONE", True),
        members[1]["id"]: signal("HAL", None, False),
    }
    monkeypatch.setattr(
        weekly,
        "run_favorite_strategies",
        lambda *args, **kwargs: [
            {
                "id": m["id"],
                "name": m["name"],
                "dataset": "broad",
                "active": False,
                "result": weekly.RunResult(
                    Notification("test", "info", m["name"], "x"), results[m["id"]]
                ),
                "blocked": None,
            }
            for m in members
        ],
    )
    monkeypatch.setattr(fyers, "resolve_credentials", lambda: None)
    journalled = []

    def journal_spy(run, outcomes, *args):
        journalled.extend(o["id"] for o in outcomes if not o.get("group"))
        return {"recorded": [], "head": None, "notes": [], "error": None}

    monkeypatch.setattr(api, "_journal_weekly", journal_spy)
    sent = []
    monkeypatch.setattr(notify, "send", sent.append)
    monkeypatch.setattr(notify, "run_url", lambda: None)

    result = api._execute_weekly_run(api.WeeklyRunBody(run="final", send=True))
    assert len(sent) == 1
    assert "Pair" in sent[0].title
    assert "Sleeves trading: Sleeve 0" in sent[0].body and "ANGELONE — BUY" in sent[0].body
    assert result["signal"]["target_weights"] == {"BSE": 0.25, "ANGELONE": 0.25, "HAL": 0.5}
    # The journal sees both sleeves and not the group.
    assert journalled == [m["id"] for m in members]
    assert [s["group"] for s in result["strategies"]] == [False, False, True]


def test_a_stock_based_headline_stays_quiet_before_the_1930_run(client, monkeypatch):
    """Outside market hours the preview cannot rank a Broad headline on live prices (that is
    tests/test_broad_live_preview.py), and the 19:30 rerun sends its signal. It must not send
    'blocked' every Friday."""
    monkeypatch.setattr(api, "_ist_now", lambda: datetime(2026, 10, 9, 16, 0, tzinfo=IST))
    headline = _favourite(client, "Broad headline", "paper", "broad")
    client.patch(f"/api/saved-runs/{headline['id']}", json={"active": True})
    monkeypatch.setattr(
        weekly,
        "run_favorite_strategies",
        lambda *args, **kwargs: [
            {
                "id": headline["id"],
                "name": "Broad headline",
                "dataset": "broad",
                "active": True,
                "result": None,
                "blocked": "Weekly ingest is not yet available for this dataset.",
            }
        ],
    )
    monkeypatch.setattr(fyers, "resolve_credentials", lambda: None)
    sent = []
    monkeypatch.setattr(notify, "send", sent.append)

    result = api._execute_weekly_run(api.WeeklyRunBody(run="preview", send=True))
    assert result["sent_to_telegram"] is False
    assert all(note.type != "momentum.problem" for note in sent)


def test_a_group_with_sleeves_from_different_weeks_is_blocked_not_mixed():
    group = {"id": "g", "name": "Pair", "config": {"dataset": "broad"}, "active": True}
    group["members"] = [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}]

    def outcome(id_, week):
        return {
            "id": id_,
            "name": id_.upper(),
            "result": weekly.RunResult(
                Notification("t", "info", id_, ""),
                {"week": week, "rows": [], "weights": {}, "target_weights": {}},
            ),
            "blocked": None,
        }

    (combined,) = api._group_outcomes(
        [group], [outcome("a", "2026-12-04"), outcome("b", "2026-11-27")], "final"
    )
    assert combined["result"] is None
    assert "different weeks" in combined["blocked"] and "B 2026-11-27" in combined["blocked"]


def test_a_stock_based_headline_blocked_for_a_real_reason_is_still_reported(client, monkeypatch):
    headline = _favourite(client, "Broad headline", "paper", "broad")
    client.patch(f"/api/saved-runs/{headline['id']}", json={"active": True})
    monkeypatch.setattr(
        weekly,
        "run_favorite_strategies",
        lambda *args, **kwargs: [
            {
                "id": headline["id"],
                "name": "Broad headline",
                "dataset": "broad",
                "active": True,
                "result": None,
                "blocked": "tax needs tax_classes",
            }
        ],
    )
    monkeypatch.setattr(fyers, "resolve_credentials", lambda: None)
    sent = []
    monkeypatch.setattr(notify, "send", sent.append)

    result = api._execute_weekly_run(api.WeeklyRunBody(run="preview", send=True))
    assert result["sent_to_telegram"] is True
    assert any("tax needs tax_classes" in note.body for note in sent)
