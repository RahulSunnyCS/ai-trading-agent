import time

import pytest
import yaml
from fastapi.testclient import TestClient

from option_backtesting.api import legwise_routes
from option_backtesting.api.app import create_app

STRATEGY = {
    "id": "t1",
    "underlying": "NIFTY",
    "entry_time": "09:20",
    "exit_time": "15:00",
    "legs": [
        {
            "id": "ce",
            "lots": 1,
            "position": "sell",
            "option_type": "CE",
            "strike": {"closest_premium": 60},
            "stop_loss": {"percent": 50},
            "trail_sl": {"points": [10, 5]},
        }
    ],
    "overall": {"stop_loss_inr": 2000},
}


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(legwise_routes, "LEGWISE_DIR", tmp_path / "strategies")
    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path / "data"))
    return TestClient(create_app(tmp_path / "cache"))


def test_save_writes_validated_yaml_and_lists_it(client, tmp_path):
    assert client.put("/legwise/strategies/my_one", json={"strategy": STRATEGY}).status_code == 200
    saved = yaml.safe_load((tmp_path / "strategies" / "my_one.yaml").read_text())
    assert saved["strategy"]["legs"][0]["trail_sl"] == {"points": [10, 5]}
    [listed] = client.get("/legwise/strategies").json()
    assert listed["name"] == "my_one" and listed["strategy"]["id"] == "t1"


@pytest.mark.parametrize("name", ["Bad-Name", "a.b", "x" * 65])
def test_save_rejects_unsafe_names_before_touching_disk(client, tmp_path, name):
    response = client.put(f"/legwise/strategies/{name}", json={"strategy": STRATEGY})
    assert response.status_code == 422 and "error" in response.json()
    assert not (tmp_path / "strategies").exists()


def test_invalid_strategy_is_reported_not_saved(client, tmp_path):
    bad = {**STRATEGY, "exit_time": "09:00"}
    assert client.post("/legwise/validate", json={"strategy": bad}).json()["valid"] is False
    assert client.put("/legwise/strategies/x", json={"strategy": bad}).status_code == 422
    assert not (tmp_path / "strategies" / "x.yaml").exists()


def test_backtest_without_collected_days_is_a_clear_404(client):
    response = client.post("/legwise/backtest", json={"strategy": STRATEGY})
    assert response.status_code == 404
    assert "no collected NIFTY days" in response.json()["error"]


def test_daily_job_runs_in_background_and_reports_its_log(client, monkeypatch):
    sent = []
    monkeypatch.setattr("option_backtesting.notify.send", lambda n: (sent.append(n), (True, ""))[1])
    client.put("/legwise/strategies/my_one", json={"strategy": STRATEGY})
    started = client.post("/legwise/daily", json={"date": "2026-09-29", "fetch": False}).json()
    assert started == {"state": "running", "day": "2026-09-29"}
    for _ in range(50):
        job = client.get("/legwise/daily").json()
        if job["state"] != "running":
            break
        time.sleep(0.05)
    assert job["state"] == "done"
    assert any("skipped" in line for line in job["log"])  # no data collected in tmp
    [message] = sent
    assert message.severity == "warn" and "skipped" in message.body
