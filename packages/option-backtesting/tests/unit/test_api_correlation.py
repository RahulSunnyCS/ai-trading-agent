"""`/legwise/correlation*` (BL-090): the Options Lab's Correlation tab reads these. Variant files
in a tmp TRADING_DATA_ROOT; the routes only wrap `analytics/correlation.py` and `rotation/series.py`,
so these tests check the contract: shapes, caps, errors, and that a new file is found."""

from __future__ import annotations

import json
from datetime import date, timedelta

import numpy as np
import pytest
from fastapi.testclient import TestClient

from option_backtesting.analytics import correlation as c
from option_backtesting.api import correlation_routes
from option_backtesting.api.app import create_app
from option_backtesting.rotation import store


def _weekdays(n: int) -> list[date]:
    out, d = [], date(2025, 1, 6)
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def _add(root, name: str, x) -> None:
    for d, v in zip(_weekdays(len(x)), x, strict=True):
        store.append_result(name, {"day": d.isoformat(), "net": float(v)}, root)


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    monkeypatch.setattr(correlation_routes, "CACHE_SECONDS", 0.0)  # every request reads fresh
    rng = np.random.default_rng(5)
    base = rng.normal(0, 1000, 80)
    _add(tmp_path, "N_wide_0917", base)
    _add(tmp_path, "N_p80_0917", base + rng.normal(0, 100, 80))
    _add(tmp_path, "N_buy_0917", -base + rng.normal(0, 500, 80))
    _add(tmp_path, "S_dir_0932", rng.normal(0, 1000, 80))
    return TestClient(create_app(tmp_path / "cache"))


def test_available_lists_strategies_and_the_groups_a_picker_offers(client):
    body = client.get("/legwise/correlation/available").json()
    assert [s["name"] for s in body["strategies"]] == [
        "N_buy_0917", "N_p80_0917", "N_wide_0917", "S_dir_0932",
    ]  # fmt: skip
    wide = next(s for s in body["strategies"] if s["name"] == "N_wide_0917")
    assert (wide["index"], wide["family"], wide["slot"], wide["n_days"]) == (
        "N",
        "wide",
        "0917",
        80,
    )
    assert body["groups"]["slot"] == {"0917": 3, "0932": 1}
    assert body["groups"]["index"] == {"N": 3, "S": 1}
    # `wide` counts every Widesl, closest premium included: that is what family:wide selects
    assert body["groups"]["family"] == {"buy": 1, "dir": 1, "p80": 1, "wide": 2}
    assert body["groups"]["kind"] == {"variant": 4}
    assert body["max_strategies"] == correlation_routes.MAX_STRATEGIES


def test_a_file_added_later_is_offered_and_selectable(client, tmp_path):
    _add(tmp_path, "N_idea_0917", np.random.default_rng(9).normal(0, 1000, 80))
    names = [s["name"] for s in client.get("/legwise/correlation/available").json()["strategies"]]
    assert "N_idea_0917" in names
    body = client.get(
        "/legwise/correlation", params={"selectors": "family:idea,N_wide_0917"}
    ).json()
    assert body["names"] == ["N_idea_0917", "N_wide_0917"]


def test_correlation_returns_the_report_with_a_cluster_order(client):
    r = client.get("/legwise/correlation", params={"selectors": "slot:0917"})
    assert r.status_code == 200
    body = r.json()
    assert body["names"] == ["N_buy_0917", "N_p80_0917", "N_wide_0917"]
    assert body["n_days"] == 80 and body["in_sample"] is True and body["stale"] == []
    assert body["pearson"][1][2] > 0.9 and body["pearson"][0][2] < -0.5
    assert sorted(body["order"]) == [0, 1, 2]
    # the two look-alikes sit next to each other in the order
    pos = {n: body["order"].index(i) for i, n in enumerate(body["names"])}
    assert abs(pos["N_p80_0917"] - pos["N_wide_0917"]) == 1
    json.dumps(body)  # NaN must have become null
    assert {"loss_overlap", "loss_corr", "parts", "basket", "rolling"} <= body.keys()


def test_selectors_can_be_anded_and_dates_cut_the_window(client):
    body = client.get(
        "/legwise/correlation",
        params={"selectors": "slot:0917+index:N", "from": "2025-02-03", "window": 20},
    ).json()
    assert body["names"] == ["N_buy_0917", "N_p80_0917", "N_wide_0917"]
    assert body["days"][0] >= "2025-02-03" and body["window"] == 20 and body["from"] == "2025-02-03"


@pytest.mark.parametrize(
    ("params", "status", "text"),
    [
        ({"selectors": "slot:1500"}, 404, "matches nothing"),
        ({"selectors": "N_wide_0917"}, 422, "at least two"),
        ({"selectors": "../../etc/passwd"}, 422, "unusable selectors"),
        ({"selectors": "slot:0917", "from": "yesterday"}, 422, "YYYY-MM-DD"),
        ({"selectors": "slot:0917", "window": 3}, 422, None),
        ({"selectors": "all", "from": "2025-04-20"}, 422, "days in common"),
    ],
)
def test_bad_requests_are_clear_errors(client, params, status, text):
    r = client.get("/legwise/correlation", params=params)
    assert r.status_code == status
    if text:
        assert text in r.json()["error"]


def test_too_many_strategies_is_refused_with_advice(client, tmp_path, monkeypatch):
    monkeypatch.setattr(correlation_routes, "MAX_STRATEGIES", 3)
    r = client.get("/legwise/correlation", params={"selectors": "all"})
    assert r.status_code == 422 and "Narrow it by start time" in r.json()["error"]


def test_pick_returns_a_basket_and_what_the_cap_cost(client):
    r = client.get(
        "/legwise/correlation/pick",
        params={"selectors": "slot:0917", "k": 2, "max_corr": 0.5, "require": "N_wide_0917"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["names"][0] == "N_wide_0917" and "N_p80_0917" not in body["names"]
    assert body["in_sample"] is True and body["candidates"] == 3 and body["n_days"] == 80
    assert {"stats", "uncapped", "skipped", "short", "wanted"} <= body.keys()
    assert len(body["uncapped"]["names"]) == 2 and body["uncapped"]["names"][0] == "N_wide_0917"


def test_pick_rejects_a_bad_measure_and_an_unknown_required_name(client):
    base = {"selectors": "slot:0917"}
    assert (
        client.get("/legwise/correlation/pick", params={**base, "measure": "x"}).status_code == 422
    )
    r = client.get("/legwise/correlation/pick", params={**base, "require": "N_zzz_0917"})
    assert r.status_code == 422 and "not in the report" in r.json()["error"]


def test_order_by_similarity_groups_alike_strategies():
    corr = np.array(
        [
            [1.0, 0.1, 0.9, 0.0],
            [0.1, 1.0, 0.0, 0.8],
            [0.9, 0.0, 1.0, 0.1],
            [0.0, 0.8, 0.1, 1.0],
        ]
    )
    order = c.order_by_similarity(corr)
    assert sorted(order) == [0, 1, 2, 3]
    assert abs(order.index(0) - order.index(2)) == 1 and abs(order.index(1) - order.index(3)) == 1
    assert c.order_by_similarity(np.ones((2, 2))) == [0, 1]
    assert c.order_by_similarity(np.full((3, 3), np.nan)) == [0, 1, 2]
