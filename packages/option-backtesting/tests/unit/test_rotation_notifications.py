"""Group copies contain picks only; operational alerts keep the private destination."""

import json
from datetime import date
from types import SimpleNamespace

import pytest
from typer.testing import CliRunner

from option_backtesting import notify
from option_backtesting.rotation import journal, pick
from option_backtesting.rotation import result as rotation_result
from option_backtesting.rotation.cli import rotation_app


@pytest.fixture
def telegram(monkeypatch, tmp_path):
    monkeypatch.setattr(notify, "load_dotenv", lambda: None)
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "fake-token-1234")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "123")
    monkeypatch.setenv("TELEGRAM_ROTATION_CHAT_ID", "-456")
    monkeypatch.setenv("NOTIFY_PREFS_FILE", str(tmp_path / "prefs.json"))
    requests = []

    def urlopen(request, timeout):
        requests.append(json.loads(request.data))
        return SimpleNamespace(read=lambda: b'{"ok": true}')

    monkeypatch.setattr(notify.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(
        pick,
        "record",
        lambda *a, **kw: SimpleNamespace(
            text="Example picks fake-token-1234", entry={"before_first_entry": True}
        ),
    )
    return requests


@pytest.mark.parametrize(
    ("group", "flags", "targets"),
    [
        ("-456", [], ["123", "-456"]),
        ("", [], ["123"]),
        (" 123 ", [], ["123"]),
        ("-456", ["--dry-run"], []),
        ("-456", ["--no-telegram"], []),
    ],
)
def test_pick_destinations(telegram, monkeypatch, group, flags, targets):
    monkeypatch.setenv("TELEGRAM_ROTATION_CHAT_ID", group)
    result = CliRunner().invoke(rotation_app, ["pick", "--day", "2026-10-13", *flags])
    assert result.exit_code == 0
    assert [r["chat_id"] for r in telegram] == targets
    for request in telegram:
        assert "fake-token-1234" not in request["text"]
        assert "***REDACTED***" in request["text"]
        assert "parse_mode" not in request
    if len(telegram) == 2:
        assert telegram[0]["text"] == telegram[1]["text"]


@pytest.mark.parametrize(
    "error", [pick.PickError("missing VIX"), KeyError("dte"), journal.AlreadyRecorded("already")]
)
def test_failures_stay_private_and_retries_send_nothing(telegram, monkeypatch, error):
    def fail(*a, **kw):
        raise error

    monkeypatch.setattr(pick, "record", fail)
    result = CliRunner().invoke(rotation_app, ["pick", "--day", "2026-10-13"])
    if isinstance(error, journal.AlreadyRecorded):
        assert result.exit_code == 0 and telegram == []
    else:
        assert result.exit_code == 2
        assert [r["chat_id"] for r in telegram] == ["123"]


def test_private_delivery_failure_does_not_prevent_group_copy(telegram, monkeypatch):
    def urlopen(request, timeout):
        payload = json.loads(request.data)
        telegram.append(payload)
        if payload["chat_id"] == "123":
            raise OSError("private delivery failed")
        return SimpleNamespace(read=lambda: b'{"ok": true}')

    monkeypatch.setattr(notify.urllib.request, "urlopen", urlopen)
    result = CliRunner().invoke(rotation_app, ["pick", "--day", "2026-10-13"])
    assert result.exit_code == 0
    assert [r["chat_id"] for r in telegram] == ["123", "-456"]


def test_explicit_group_does_not_need_private_chat(telegram, monkeypatch):
    monkeypatch.delenv("TELEGRAM_CHAT_ID")
    delivered, _ = notify.send(notify.Notification("test", "info", "Setup"), chat_id="-456")
    assert delivered is True
    assert [r["chat_id"] for r in telegram] == ["-456"]


@pytest.mark.parametrize("on_time", [True, False])
def test_message_uses_strategy_names_and_keeps_recording_witness(on_time):
    entry = {
        "day": "2026-10-13",
        "weekday": "Tue",
        "vix_open": 15.25,
        "vix_band": "15-18",
        "dte": {"NIFTY": 0, "SENSEX": 2},
        "lists": {
            key: {"core": ["N_ditm1_0932", "N_wide_1117"], "buy": ["N_buy_1147"]}
            for key in ["A", "B", "C", "REF"]
        },
        "hash": "f1a772478960abcd",
        "recorded_at": "2026-10-13T09:16:25+05:30",
        "before_first_entry": on_time,
    }
    text = pick.render(entry)
    for name in ["Steady", "Calendar", "Adaptive"]:
        assert f"{name}: N_ditm1_0932, N_wide_1117 + Buy N_buy_1147" in text
    assert "VIX" not in text and "DTE" not in text
    assert "Baseline" not in text and "REF:" not in text
    assert "REF" in entry["lists"]
    assert "chain f1a772478960" in text and "recorded 09:16:25 IST" in text
    assert ("LATE:" in text) is not on_time
    assert entry["vix_open"] == 15.25 and entry["dte"]["NIFTY"] == 0


def test_result_goes_to_private_chat_and_group(telegram, monkeypatch):
    calculated = rotation_result.DailyResult(
        day=date(2026, 10, 13),
        weekday="Tue",
        gains={"A": 1200, "B": -450, "C": 0},
        entry_hash="abc123def456",
        strategies={
            "A": [("a", 1400), ("b", -200)],
            "B": [("c", -450)],
            "C": [("d", 0)],
        },
    )
    monkeypatch.setattr(rotation_result, "calculate", lambda _day: calculated)
    monkeypatch.setattr(rotation_result, "was_sent", lambda _result: False)
    marked = []
    monkeypatch.setattr(rotation_result, "mark_sent", lambda completed: marked.append(completed))
    response = CliRunner().invoke(rotation_app, ["result", "--day", "2026-10-13"])
    assert response.exit_code == 0
    assert marked == [calculated]
    assert [request["chat_id"] for request in telegram] == ["123", "-456"]
    for request in telegram:
        assert "Steady: +₹1,200" in request["text"]
        assert "Calendar: -₹450" in request["text"]
        assert "Adaptive: ₹0" in request["text"]
        assert "• a: +₹1,400" in request["text"]
        assert "• c: -₹450" in request["text"]
        assert "Baseline" not in request["text"]


def test_result_is_not_sent_twice(telegram, monkeypatch):
    calculated = rotation_result.DailyResult(
        day=date(2026, 10, 13),
        weekday="Tue",
        gains={"A": 1, "B": 2, "C": 3},
        entry_hash="abc123",
    )
    monkeypatch.setattr(rotation_result, "calculate", lambda _day: calculated)
    monkeypatch.setattr(rotation_result, "was_sent", lambda _result: True)
    response = CliRunner().invoke(rotation_app, ["result", "--day", "2026-10-13"])
    assert response.exit_code == 0
    assert "already sent" in response.output
    assert telegram == []


def test_result_not_ready_sends_nothing(telegram, monkeypatch):
    def unavailable(_day):
        raise rotation_result.ResultUnavailable("results are incomplete")

    monkeypatch.setattr(rotation_result, "calculate", unavailable)
    response = CliRunner().invoke(rotation_app, ["result", "--day", "2026-10-13"])
    assert response.exit_code == 2
    assert "result not ready" in response.output
    assert telegram == []
