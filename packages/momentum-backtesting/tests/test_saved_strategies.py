"""BL-052: saved runs as one strategy per set of settings, the result-change log, and the
one-time merge (runs_store.py, /api/saved-strategies, /api/result-changes). Runs against the
isolated TRADING_DATA_ROOT from conftest.py, never the real catalog."""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from trading_data.db import connect

from momentum_backtesting import api, notify, runs_store, saved_identity

UNIVERSE = ["NIFTY", "GOLD", "BANK"]


@pytest.fixture
def client():
    return TestClient(api.create_app())


@pytest.fixture
def sent(monkeypatch):
    messages = []
    monkeypatch.setattr(notify, "send", lambda n: messages.append(n) or "")
    return messages


def _versions(code="c1", data="d1"):
    return {"data": data, "tables": {"prices": data}, "lake": "l", "files": "f", "code": code}


def _payload(top_n=5, curve=(100.0, 101.5), dataset="etf", name="Run 1", **extra):
    config = {"universe": UNIVERSE, "top_n": top_n, **extra.pop("config", {})}
    return {
        "dataset": dataset,
        "name": name,
        "config": config,
        "kpis": {"cagr": curve[-1] / 100 - 1},
        "dates": ["2020-01-03", "2020-01-10"][: len(curve)],
        "strategy": list(curve),
        "overlay": False,
        "versions": extra.pop("versions", _versions()),
        **extra,
    }


def _strategies(client, **params):
    return client.get("/api/saved-strategies", params=params).json()


def test_running_the_same_settings_again_adds_no_strategy(client):
    first = client.post("/api/saved-runs", json=_payload(name="Run 1")).json()
    again = client.post("/api/saved-runs", json=_payload(name="Run 2")).json()
    assert (first["outcome"], again["outcome"]) == ("new", "repeat")
    assert again["strategy_ref"]["id"] == first["id"]
    listed = _strategies(client)["strategies"]
    assert len(listed) == 1
    assert (listed[0]["id"], listed[0]["runs"], listed[0]["repeats"]) == (first["id"], 2, 1)


def test_settings_the_dataset_ignores_and_missing_defaults_are_the_same_strategy(client):
    client.post("/api/saved-runs", json=_payload())
    same = _payload(config={"broad_liquidity_filter": True, "exit_rank": 10})
    assert client.post("/api/saved-runs", json=same).json()["outcome"] == "repeat"
    assert len(_strategies(client)["strategies"]) == 1


def test_a_moved_result_is_logged_with_why_and_alerts_only_for_a_favourite(client, sent):
    first = client.post("/api/saved-runs", json=_payload()).json()
    moved = client.post("/api/saved-runs", json=_payload(curve=(100.0, 103.0))).json()
    assert moved["outcome"] == "new_result"
    assert moved["change"]["label"] == "not_reproducible"
    assert sent == []  # not a favourite: shown on the page, not sent

    client.patch(f"/api/saved-runs/{first['id']}", json={"favorite": True})
    client.post("/api/saved-runs", json=_payload(curve=(100.0, 99.0))).json()
    assert len(sent) == 1 and "not reproducible" in sent[0].title.lower()
    assert sent[0].type is None  # untagged: cannot be switched off

    changes = client.get("/api/result-changes").json()["changes"]
    assert [c["label"] for c in changes] == ["not_reproducible", "not_reproducible"]
    assert changes[0]["first_difference"] == "2020-01-10"
    assert _strategies(client)["unreviewed"] == 2


def test_a_check_is_shown_but_never_sent(client, sent, monkeypatch):
    monkeypatch.setattr(saved_identity, "accepted_golden_change", lambda a, b, d: None)
    first = client.post("/api/saved-runs", json=_payload()).json()
    client.patch(f"/api/saved-runs/{first['id']}", json={"favorite": True})
    moved = client.post(
        "/api/saved-runs", json=_payload(curve=(100.0, 103.0), versions=_versions(code="c2"))
    ).json()
    assert moved["change"]["label"] == "check"
    assert sent == []  # owner, 2026-10-08: Check stays on the page
    assert _strategies(client)["unreviewed"] == 1


def test_the_same_result_on_a_new_data_version_is_a_repeat_not_a_change(client):
    # An ETF refresh changes the data version a Broad rerun sees without changing its result.
    client.post("/api/saved-runs", json=_payload())
    again = client.post("/api/saved-runs", json=_payload(versions=_versions(data="d2"))).json()
    assert again["outcome"] == "repeat"
    assert client.get("/api/result-changes").json()["changes"] == []


def test_marking_a_change_reviewed_clears_the_count_and_keeps_the_row(client):
    client.post("/api/saved-runs", json=_payload())
    client.post("/api/saved-runs", json=_payload(curve=(100.0, 103.0)))
    change = client.get("/api/result-changes", params={"unreviewed": True}).json()["changes"][0]
    reviewed = client.post(
        f"/api/result-changes/{change['change_id']}/reviewed", json={"reviewed_by": "rahul"}
    ).json()
    assert reviewed["reviewed_by"] == "rahul" and reviewed["needs_review"] is False
    assert client.get("/api/result-changes", params={"unreviewed": True}).json()["changes"] == []
    assert len(client.get("/api/result-changes").json()["changes"]) == 1
    assert client.post("/api/result-changes/nope/reviewed", json={}).status_code == 404


def test_a_strategy_keeps_its_last_three_repeats_and_every_result(client):
    for i in range(6):
        client.post("/api/saved-runs", json=_payload(name=f"Run {i}"))
    client.post("/api/saved-runs", json=_payload(curve=(100.0, 103.0), name="Run 7"))
    for i in range(8, 13):
        client.post("/api/saved-runs", json=_payload(curve=(100.0, 103.0), name=f"Run {i}"))
    strategy = _strategies(client)["strategies"][0]
    history = client.get(f"/api/saved-strategies/{strategy['id']}").json()["history"]
    outcomes = [run["outcome"] for run in history]
    assert outcomes.count("repeat") == 3
    assert outcomes.count("new") == 1 and outcomes.count("new_result") == 1


def test_each_dataset_keeps_its_ten_newest_strategies_and_every_kept_one(client):
    kept = client.post("/api/saved-runs", json=_payload(top_n=1)).json()["id"]
    client.patch(f"/api/saved-runs/{kept}", json={"favorite": True})
    for top_n in range(2, 15):
        client.post("/api/saved-runs", json=_payload(top_n=top_n))
    ids = {s["id"] for s in _strategies(client, dataset="etf")["strategies"]}
    assert len(ids) == 11 and kept in ids  # 10 ordinary + the favourite


def test_followed_strategies_come_first_and_groups_nest_their_members(client):
    def broad(n):  # Broad never reads top_n; broad_off_top_n is its own
        return _payload(dataset="broad", config={"broad_off_top_n": n})

    a = client.post("/api/saved-runs", json=broad(2)).json()["id"]
    b = client.post("/api/saved-runs", json=broad(3)).json()["id"]
    client.post("/api/saved-runs", json=broad(4))
    group = client.post("/api/saved-runs/groups", json={"name": "Pair", "members": [a, b]}).json()
    client.patch(f"/api/saved-runs/{group['id']}", json={"status": "paper"})
    listed = _strategies(client)["strategies"]
    assert listed[0]["id"] == group["id"] and listed[0]["status"] == "paper"
    assert {m["id"] for m in listed[0]["members"]} == {a, b}
    assert {s["id"] for s in listed} == {group["id"], listed[1]["id"]}  # members not repeated
    assert listed[1]["trust"] == "not_tradable"  # Broad with the liquidity filter off


def test_patch_names_notes_and_status_go_to_the_anchor(client):
    first = client.post("/api/saved-runs", json=_payload()).json()
    client.post("/api/saved-runs", json=_payload(name="Run 2"))
    patched = client.patch(
        f"/api/saved-strategies/{first['id']}",
        json={"name": "ETF top 5", "notes": "kept for the cash filter", "status": "watching"},
    ).json()
    assert patched["id"] == first["id"]
    assert (patched["name"], patched["name_typed"]) == ("ETF top 5", True)
    assert patched["notes"] == "kept for the cash filter"
    assert patched["status"] == "watching"
    assert [r["id"] for r in patched["history"]][-1] == first["id"]
    assert client.patch("/api/saved-strategies/nope", json={"notes": "x"}).status_code == 404


def test_deleting_a_strategy_deletes_every_run(client):
    first = client.post("/api/saved-runs", json=_payload()).json()
    client.post("/api/saved-runs", json=_payload(name="Run 2"))
    assert client.delete(f"/api/saved-strategies/{first['id']}").json() == {"ok": True}
    assert _strategies(client)["strategies"] == []
    assert client.get("/api/saved-runs", params={"dataset": "etf"}).json() == []


# --- the one-time merge -----------------------------------------------------------------------


def _legacy_run(con, dataset, name, config, curve, favourite=False):
    """A run as saved before BL-052: its version keyed on the raw text, no fingerprints."""
    raw = saved_identity.raw_hash(config)
    version_id = runs_store._ensure_version(con, dataset, raw, config)
    run_id = f"legacy-{name.replace(' ', '-')}"
    summary = {
        "name": name,
        "n": int(name.split()[-1]) if name.split()[-1].isdigit() else 1,
        "kpis": {"cagr": curve[-1] / 100 - 1},
        "dates": ["2020-01-03", "2020-01-10"],
        "strategy": list(curve),
        "overlay": False,
        "favorite": favourite,
        "active": False,
    }
    con.execute(
        "INSERT INTO backtest_runs (run_id, version_id, kind, params, summary) "
        "VALUES (?, ?, 'weekly', ?, ?)",
        [run_id, version_id, json.dumps(config), json.dumps(summary)],
    )
    return run_id


def test_the_merge_folds_old_runs_keeps_ids_and_deletes_nothing(client):
    base = {"universe": UNIVERSE, "top_n": 5}
    with connect() as con:
        a = _legacy_run(con, "etf", "Run 10", base, (100.0, 101.0))
        b = _legacy_run(
            con, "etf", "Run 11", {**base, "broad_respect_circuits": True}, (100.0, 101.0)
        )
        three, seven = {"broad_off_top_n": 3}, {"broad_off_top_n": 7}
        fav = _legacy_run(con, "broad", "Phase 6 companion", three, (100.0, 102.0), True)
        c = _legacy_run(con, "broad", "Run 161", {**three, "end": ""}, (100.0, 102.0))
        d = _legacy_run(con, "broad", "Run 149", seven, (100.0, 102.0))
        e = _legacy_run(con, "broad", "Run 162", {**seven, "top_n": 9}, (100.0, 101.9))

    plan = client.get("/api/saved-strategies/merge").json()
    assert (plan["runs"], plan["strategies"]) == (6, 3)
    applied = client.post("/api/saved-strategies/merge").json()
    assert applied["strategies"] == 3

    listed = {s["id"]: s for s in _strategies(client)["strategies"]}
    assert set(listed) == {a, fav, d}  # the favourite run is its strategy's anchor
    assert listed[a]["runs"] == 2 and listed[fav]["runs"] == 2
    assert listed[a]["name_typed"] is False and listed[fav]["name_typed"] is True
    with connect() as con:
        assert con.execute("SELECT count(*) FROM backtest_runs").fetchone()[0] == 6
    history = client.get(f"/api/saved-strategies/{e}").json()["history"]
    assert [r["outcome"] for r in history] == ["new_result", "new"]
    assert history[0]["change"]["label"] == "unknown"  # saved before fingerprints existed
    for folded, into in ((b, a), (c, fav)):
        assert client.get(f"/api/saved-strategies/{folded}").json()["id"] == into

    again = client.get("/api/saved-strategies/merge").json()
    assert again["merges"] == [] and again["conflicts"] == []


def test_the_merge_leaves_two_favourites_with_the_same_settings_alone(client):
    base = {"universe": UNIVERSE, "top_n": 5}
    with connect() as con:
        _legacy_run(con, "etf", "Fav 1", base, (100.0, 101.0), True)
        _legacy_run(con, "etf", "Fav 2", {**base, "exit_rank": 10}, (100.0, 101.0), True)
    plan = client.post("/api/saved-strategies/merge").json()
    assert plan["merges"] == [] and len(plan["conflicts"]) == 1
    assert len(_strategies(client)["strategies"]) == 2
