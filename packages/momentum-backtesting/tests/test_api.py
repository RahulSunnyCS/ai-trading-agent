"""The local UI's API, on generated prices so it doesn't depend on downloaded data."""

import json

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from momentum_backtesting import api
from momentum_backtesting.fetch import load_universe


@pytest.fixture
def client(tmp_path, monkeypatch):
    weeks = pd.date_range("2016-01-01", periods=180, freq="W-FRI")
    rng = np.random.default_rng(7)
    prices = pd.DataFrame(
        {
            inst.name: 100 * np.cumprod(1 + rng.normal(0.002, 0.03, len(weeks)))
            for inst in load_universe()
        },
        index=weeks,
    )
    prices["Cash (liquid fund)"] = 100 * np.cumprod(np.full(len(weeks), 1.0012))
    prices.index.name = "week_ending"
    prices.to_csv(tmp_path / "weekly_closes.csv")
    monkeypatch.setattr(api, "DATA_DIR", tmp_path)
    monkeypatch.setattr(api, "DATA", api._Data())
    return TestClient(api.create_app())


def core(client):
    return [
        i["name"] for i in client.get("/api/meta").json()["instruments"] if i["include"] == "core"
    ]


def test_meta_lists_every_instrument_with_its_data_start(client):
    meta = client.get("/api/meta").json()
    assert len(meta["instruments"]) == len(load_universe())
    assert all(i["has_data"] and i["first_week"] for i in meta["instruments"])
    assert meta["defaults"]["portfolio"] == "buffer"


@pytest.mark.parametrize(
    "extra",
    [
        {},
        {"entry": "make_room"},
        {"portfolio": "slots"},
        {"defensive": "filter"},
        {"defensive": "ranked", "universe_add": ["Cash (liquid fund)", "Gilt 8-13 yr"]},
        {"tax": True, "slab_rate": 0.2},
        {"lookbacks": [1, 4, 13], "weights": [1.5, 1.25, 1.0], "top_n": 3, "exit_rank": 9},
    ],
)
def test_backtest_returns_a_complete_json_payload(client, extra):
    universe = core(client) + extra.pop("universe_add", [])
    res = client.post("/api/backtest", json={"universe": universe, "start": "2017-01-06", **extra})
    assert res.status_code == 200, res.text
    body = res.json()
    for key in (
        "kpis",
        "series",
        "rotations",
        "trades",
        "instruments",
        "timeline",
        "yearly",
        "latest",
    ):
        assert key in body
    series = body["series"]
    assert len(series["dates"]) == len(series["strategy"]) == len(series["benchmark"])
    assert body["latest"]["rows"]
    json.dumps(body, allow_nan=False)  # no NaN/Infinity reaches the browser


def test_filtering_the_universe_limits_what_is_ranked_and_held(client):
    chosen = core(client)[:8]
    body = client.post("/api/backtest", json={"universe": chosen, "top_n": 3}).json()
    assert set(body["universe"]) == set(chosen)
    held = {s["asset"] for s in body["timeline"]}
    assert held <= set(chosen)


def test_too_few_instruments_for_top_n_is_a_clear_error(client):
    res = client.post("/api/backtest", json={"universe": core(client)[:3], "top_n": 5})
    assert res.status_code == 422
    assert "need at least top N" in res.json()["detail"]


def test_bad_rule_combinations_are_rejected(client):
    universe = core(client)
    assert (
        client.post(
            "/api/backtest", json={"universe": universe, "top_n": 6, "exit_rank": 4}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/backtest", json={"universe": universe, "lookbacks": [1, 4], "weights": [1.0]}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/backtest", json={"universe": universe, "benchmark": "Not an index"}
        ).status_code
        == 422
    )


def test_the_page_is_served(client):
    res = client.get("/")
    assert res.status_code == 200
    assert "Momentum backtest" in res.text
    assert client.get("/static/app.js").status_code == 200
