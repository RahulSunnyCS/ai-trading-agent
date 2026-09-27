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


def _daily_files(tmp_path, etf_names=("Nifty 50", "Nifty IT")):
    """Daily files from the weekly table (one row per week is enough for fills), plus ETFs
    for a couple of instruments that 'listed' part-way through at a small premium."""
    weekly = pd.read_csv(tmp_path / "weekly_closes.csv", index_col=0, parse_dates=True)
    (tmp_path / "daily").mkdir()
    (tmp_path / "daily_etf").mkdir()
    for name in weekly:
        closes = weekly[name].dropna()
        monday = closes.copy()
        monday.index = monday.index + pd.Timedelta(days=3)
        daily = pd.concat([closes, monday * 1.001]).sort_index().to_frame("close")
        daily["open"] = daily["close"]
        daily.to_csv(tmp_path / "daily" / f"{name}.csv", index_label="date")
        if name in etf_names:
            listed = daily[daily.index >= "2019-01-01"] * 1.01
            listed.to_csv(tmp_path / "daily_etf" / f"{name}.csv", index_label="date")


@pytest.mark.parametrize("execution", ["fri_close", "mon_open", "mon_10am"])
def test_backtest_on_etf_prices_marks_proxy_trades(client, tmp_path, execution):
    _daily_files(tmp_path)
    res = client.post(
        "/api/backtest",
        json={
            "universe": core(client),
            "start": "2017-01-06",
            "track": "etf",
            "execution": execution,
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["fills"]["track"] == "etf" and body["fills"]["execution"] == execution
    assert all("proxy" in t for t in body["trades"])
    if execution == "mon_10am":  # no intraday files: every 10:00 fill fell back to the open
        assert body["fills"]["warnings"]


def test_etf_track_without_daily_files_says_to_refetch(client):
    res = client.post(
        "/api/backtest", json={"universe": core(client), "start": "2017-01-06", "track": "etf"}
    )
    assert res.status_code == 409 and "mbt fetch" in res.json()["detail"]


def test_tracking_command_writes_its_report(client, tmp_path, monkeypatch):
    from typer.testing import CliRunner

    from momentum_backtesting import cli, trade_prices

    _daily_files(tmp_path)
    monkeypatch.setattr(cli, "DATA_DIR", tmp_path)
    monkeypatch.setattr(trade_prices, "DATA_DIR", tmp_path)
    out = CliRunner().invoke(cli.app, ["tracking", "--start", "2017-01-06"])
    assert out.exit_code == 0, out.output
    assert "track x execution" in out.output and "No premium data" in out.output
    assert (tmp_path / "backtests" / "tracking.xlsx").exists()
