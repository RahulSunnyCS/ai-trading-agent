"""BL-087 Phase 3: following a strategy on every rebalance Friday (`all_fridays.py`)."""

import pytest
from fastapi.testclient import TestClient

from momentum_backtesting import all_fridays, api, groups, runs_store
from momentum_backtesting.db_read import open_catalog, read_catalog

SPLIT = {
    "top_n": 5,
    "lookbacks": [1, 4, 13, 26, 52],
    "cost_pct": 0.11,
    "rebalance": "weekly",
    "rebalance_every": 4,
    "rebalance_offset": 0,
    "split_fridays": True,
    "capital": 800_000,
}


@pytest.fixture
def client(monkeypatch):
    ran: list[dict] = []

    def fake_sleeve(dataset: str, config: dict) -> dict:
        ran.append(config)
        level = 100.0 + config["rebalance_offset"]
        return {
            "kpis": {"cagr": 0.2 + config["rebalance_offset"] / 100},
            "dates": ["2020-01-03", "2020-01-10"],
            "strategy": [level, level + 1],
            "versions": {"data": "d"},
        }

    monkeypatch.setattr(api, "sleeve_summary", fake_sleeve)
    test_client = TestClient(api.create_app())
    test_client.ran = ran  # type: ignore[attr-defined]
    return test_client


def _save(client, config=None, name="Run 1", **overrides) -> dict:
    body = {
        "dataset": "etf",
        "name": name,
        "config": {**(config or SPLIT), **overrides},
        "kpis": {"cagr": 0.2},
        "dates": ["2020-01-03", "2020-01-10"],
        "strategy": [100.0, 101.5],
    }
    return client.post("/api/saved-runs", json=body).json()


def test_a_config_has_one_sleeve_per_friday_with_its_share_of_the_money():
    configs = all_fridays.sleeve_configs(SPLIT)
    assert [c["rebalance_offset"] for c in configs] == [0, 1, 2, 3]
    assert {c["capital"] for c in configs} == {200_000.0}
    assert all(c["split_fridays"] is False and c["rebalance_every"] == 4 for c in configs)
    assert all_fridays.sleeve_configs({"rebalance_every": 2})[0]["capital"] == 500_000.0


def test_only_a_slower_weekly_cadence_has_fridays_to_split():
    assert all_fridays.is_split(SPLIT)
    assert not all_fridays.is_split({**SPLIT, "rebalance_every": 1})
    assert not all_fridays.is_split({**SPLIT, "rebalance": "monthly"})
    assert not all_fridays.is_split({**SPLIT, "split_fridays": False})
    assert all_fridays.is_single_friday({**SPLIT, "split_fridays": False})
    assert not all_fridays.is_single_friday(SPLIT)
    assert not all_fridays.is_single_friday({"rebalance_every": 1})


def test_favouriting_an_all_fridays_run_follows_every_friday_as_one_group(client):
    run = _save(client)
    result = client.patch(f"/api/saved-strategies/{run['id']}", json={"status": "paper"}).json()
    assert result["group"] and result["status"] == "paper"
    assert result["name"] == "Run 1 · all Fridays"
    assert [c["rebalance_offset"] for c in client.ran] == [0, 1, 2, 3]

    favourites = client.get("/api/favorite-strategies").json()
    group = next(f for f in favourites if f["group"])
    assert [m["name"] for m in group["members"]] == [
        f"Run 1 · all Fridays · Friday {n} of 4" for n in range(1, 5)
    ]
    assert [m["config"]["rebalance_offset"] for m in group["members"]] == [0, 1, 2, 3]
    assert all(m["member_of"] == group["id"] for m in group["members"])
    # The split run itself is a saved run, not a favourite.
    assert (
        next(r for r in client.get("/api/saved-runs?dataset=etf").json() if r["id"] == run["id"])[
            "favorite"
        ]
        is False
    )


def test_the_same_request_through_the_run_route_and_the_explicit_route(client):
    run = _save(client)
    result = client.post(
        f"/api/saved-strategies/{run['id']}/follow-all-fridays",
        json={"status": "watching", "name": "Mine"},
    ).json()
    assert result["name"] == "Mine" and result["status"] == "watching"
    again = client.post(
        f"/api/saved-strategies/{run['id']}/follow-all-fridays", json={"status": "paper"}
    ).json()
    # Asked again, it changes the group it already made rather than making a second one.
    assert again["id"] == result["id"] and again["status"] == "paper"
    assert len(client.ran) == 4
    groups_now = [f for f in client.get("/api/favorite-strategies").json() if f["group"]]
    assert len(groups_now) == 1


def test_the_star_on_a_followed_all_fridays_run_never_demotes_its_group(client):
    run = _save(client)
    group = client.patch(
        f"/api/saved-strategies/{run['id']}", json={"status": "invested", "active": True}
    ).json()
    assert group["status"] == "invested" and group["active"] is True
    # The dashboard's empty star on the still-unfavourited split run sends "watching".
    again = client.patch(f"/api/saved-strategies/{run['id']}", json={"status": "watching"})
    assert again.status_code == 200
    result = again.json()
    assert result["id"] == group["id"]
    assert result["status"] == "invested" and result["active"] is True
    assert result["followed_by"] == group["id"]
    # The same through the run route, with a plain `favorite`, a lower status and the headline.
    for url, body in (
        (f"/api/saved-runs/{run['id']}", {"favorite": True}),
        (f"/api/saved-strategies/{run['id']}", {"status": "paper"}),
        (f"/api/saved-strategies/{run['id']}", {"active": True}),
    ):
        got = client.patch(url, json=body).json()
        assert got["status"] == "invested" and got["active"] is True, body
    explicit = client.post(
        f"/api/saved-strategies/{run['id']}/follow-all-fridays", json={"status": "watching"}
    ).json()
    assert explicit["status"] == "invested" and explicit["active"] is True
    assert len(client.ran) == 4


def test_a_paper_group_is_kept_by_a_watching_request_and_still_upgraded_by_a_higher_one(client):
    run = _save(client)
    first = client.patch(f"/api/saved-strategies/{run['id']}", json={"status": "paper"}).json()
    kept = client.patch(f"/api/saved-strategies/{run['id']}", json={"status": "watching"}).json()
    assert kept["id"] == first["id"] and kept["status"] == "paper"
    higher = client.patch(f"/api/saved-strategies/{run['id']}", json={"status": "invested"}).json()
    assert higher["status"] == "invested"
    headline = client.patch(f"/api/saved-strategies/{run['id']}", json={"active": True}).json()
    # Asking for the headline never lowers an Invested group to Paper.
    assert headline["status"] == "invested" and headline["active"] is True


def test_the_split_run_says_which_group_follows_it(client):
    run = _save(client)

    def split_record() -> dict:
        strategies = client.get("/api/saved-strategies?dataset=etf").json()["strategies"]
        return next(s for s in strategies if s["id"] == run["id"])

    assert split_record()["followed_by"] is None
    group = client.patch(f"/api/saved-strategies/{run['id']}", json={"status": "watching"}).json()
    assert split_record()["followed_by"] == group["id"]
    assert client.get(f"/api/saved-strategies/{run['id']}").json()["followed_by"] == group["id"]
    # A deleted group no longer follows it.
    assert client.delete(f"/api/saved-strategies/{group['id']}").status_code == 200
    assert split_record()["followed_by"] is None


def test_a_run_on_one_friday_is_favourited_as_before(client):
    run = _save(client, split_fridays=False, cost_pct=0.12)
    result = client.patch(f"/api/saved-runs/{run['id']}", json={"favorite": True}).json()
    assert result["id"] == run["id"] and not result["group"] and result["favorite"] is True
    assert client.ran == []


def test_a_full_followed_list_refuses_before_saving_anything(client, monkeypatch):
    monkeypatch.setattr(runs_store, "MAX_FOLLOWED", 0)
    run = _save(client)
    before = len(client.get("/api/saved-runs?dataset=etf").json())
    result = client.patch(f"/api/saved-strategies/{run['id']}", json={"status": "invested"})
    assert result.status_code == 409 and "Paper or Invested" in result.json()["detail"]
    assert client.ran == []
    assert len(client.get("/api/saved-runs?dataset=etf").json()) == before


def test_following_as_the_headline_makes_the_group_the_headline(client):
    run = _save(client)
    result = client.patch(f"/api/saved-strategies/{run['id']}", json={"active": True}).json()
    assert result["group"] and result["active"] and result["status"] == "paper"


def test_a_group_of_fridays_names_the_sleeve_that_trades(client):
    run = _save(client)
    client.patch(f"/api/saved-strategies/{run['id']}", json={"status": "watching"})
    group = next(f for f in client.get("/api/favorite-strategies").json() if f["group"])
    members = [
        {
            "id": m["id"],
            "name": m["name"],
            "signal": {
                "weights": {"X": 1.0},
                "target_weights": {"X": 1.0},
                "rows": [{"asset": "X", "action": "HOLD", "rank": 1}],
                "sleeve_value": 1.0,
                "rebalance": {"on_cadence": n == 1, "every": 4, "next": "2026-12-11"},
            },
        }
        for n, m in enumerate(group["members"])
    ]
    note = groups.notification(groups.combine(group, members, "2026-12-04"))
    assert "Sleeves trading: Friday 2 of 4" in note.body


def test_the_migration_replaces_a_single_friday_favourite_with_the_group(client):
    run = _save(client, split_fridays=False, rebalance_offset=2, cost_pct=0.13, name="Five Sectors")
    client.patch(f"/api/saved-runs/{run['id']}", json={"status": "paper", "active": True})
    with read_catalog() as con:
        (plan,) = all_fridays.migration_plans(con)
    assert (plan.run_id, plan.name, plan.status) == (run["id"], "Five Sectors", "paper")
    assert plan.active
    sleeves = all_fridays.run_sleeves(plan, api.sleeve_summary)
    with open_catalog() as con:
        group = all_fridays.follow(
            con, plan, sleeves, status=plan.status, active=plan.active, release=plan.run_id
        )
    assert (
        group["status"] == "paper"
        and group["active"]
        and group["name"] == "Five Sectors · all Fridays"
    )
    old = next(r for r in client.get("/api/saved-runs?dataset=etf").json() if r["id"] == run["id"])
    assert old["favorite"] is False and old["active"] is False  # kept as a saved run
    with read_catalog() as con:
        assert all_fridays.migration_plans(con) == []  # nothing left to migrate


def test_a_failed_group_puts_the_old_favourite_back(client, monkeypatch):
    run = _save(client, split_fridays=False, cost_pct=0.14)
    client.patch(f"/api/saved-runs/{run['id']}", json={"status": "invested"})
    with read_catalog() as con:
        (plan,) = all_fridays.migration_plans(con)
    sleeves = all_fridays.run_sleeves(plan, api.sleeve_summary)

    def refuse(*_args, **_kwargs):
        raise runs_store.FavouriteError("no")

    monkeypatch.setattr(runs_store, "create_group", refuse)
    with open_catalog() as con, pytest.raises(runs_store.FavouriteError):
        all_fridays.follow(con, plan, sleeves, status="invested", release=plan.run_id)
    saved = client.get("/api/saved-runs?dataset=etf").json()
    assert next(r for r in saved if r["id"] == run["id"])["status"] == "invested"
    assert [r["id"] for r in saved if r["name"].endswith("of 4")] == []  # sleeves removed


# --- BL-087 Phase 4: the Rebalance preview of a group ----------------------------------------


def _fake_model(week, target, value):
    def model(req, now):
        return {
            "target": target,
            "ltp": {"X": 100.0, "Y": 50.0},
            "symbols": {"X": "NSE:X-EQ", "Y": "NSE:Y-EQ"},
            "week": week,
            "live": False,
            "schedule": None,
            "first_allocation": False,
            "model_req": req,
            "sleeve_value": value,
        }

    return model


def test_a_groups_preview_is_the_value_weighted_mix_of_its_sleeves(client, monkeypatch):
    import pandas as pd

    run = _save(client)
    group = client.patch(f"/api/saved-strategies/{run['id']}", json={"status": "watching"}).json()
    members = next(f for f in client.get("/api/favorite-strategies").json() if f["group"])[
        "members"
    ]
    week = pd.Timestamp("2026-10-02")
    # Friday 1 has grown to 1.5, the others stayed at 1.0: it counts for more in the account.
    targets = [{"X": 1.0}, {"Y": 1.0}, {"Y": 1.0}, {"Y": 1.0}]
    values = [1.5, 1.0, 1.0, 1.0]
    offsets = [m["config"]["rebalance_offset"] for m in members]
    by_offset = dict(zip(offsets, zip(targets, values, strict=True), strict=True))

    def model(req, now):
        target, value = by_offset[req.rebalance_offset]
        return _fake_model(week, target, value)(req, now)

    monkeypatch.setattr(api, "_rebalance_model", model)
    result = client.post(
        "/api/rebalance-preview",
        json={
            "dataset": "etf",
            "group": group["id"],
            "holdings_pct": {},
            "portfolio_value": 1_000_000,
        },
    )
    assert result.status_code == 200, result.text
    body = result.json()
    assert body["target_pct"] == {
        "X": pytest.approx(100 / 3, abs=1e-3),
        "Y": pytest.approx(200 / 3, abs=1e-3),
    }
    assert body["group"]["name"] == "Run 1 · all Fridays"
    assert [s["value"] for s in body["group"]["sleeves"]] == values
    assert sum(s["share"] for s in body["group"]["sleeves"]) == pytest.approx(1.0, abs=1e-3)
    assert body["rebalance_schedule"] is None
    rows = {r["asset"]: r for r in body["rows"]}
    assert rows["X"]["action"] == "BUY" and rows["X"]["target_pct"] == pytest.approx(
        100 / 3, abs=1e-3
    )


def test_a_group_preview_of_an_unknown_group_is_a_404(client):
    result = client.post(
        "/api/rebalance-preview",
        json={"dataset": "etf", "group": "nope", "holdings_pct": {}, "portfolio_value": 1000},
    )
    assert result.status_code == 404
