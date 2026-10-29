"""Group copies contain picks only; operational alerts keep the private destination."""

import json
from datetime import date
from types import SimpleNamespace

import pytest
from typer.testing import CliRunner

from option_backtesting import notify
from option_backtesting.rotation import journal, messages, pick
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
    # the owner asked for each index's DTE on the heading (2026-10-23); the VIX stays out
    assert "🎯 ADAPTIVE · Tue 13 Oct · NIFTY 0 DTE · SENSEX 2 DTE" in text
    assert "1️⃣ 09:32  N_dir_ITM1" in text and "2️⃣ 11:17  N_widesl_OTM1" in text
    assert "➕ Buy\n   11:47  N_buy_p50" in text
    assert "Steady" not in text and "Calendar" not in text
    assert "VIX" not in text and text.count("DTE") == 2
    assert "Baseline" not in text and "REF:" not in text
    assert "REF" in entry["lists"]
    assert text.endswith("🔒 f1a77247 · 09:16")
    assert (text.splitlines()[0] == "⚠️ LATE · not a forward entry") is not on_time
    assert entry["vix_open"] == 15.25 and entry["dte"]["NIFTY"] == 0


@pytest.fixture
def evening_store(tmp_path, monkeypatch):
    """A day with Adaptive picked and scored, in a tmp store the CLI reads through the env."""
    from option_backtesting.rotation import store, tomorrow

    monkeypatch.setenv("TRADING_DATA_ROOT", str(tmp_path))
    core = ["N_ditm1_0917", "N_wide_1117", "N_p100_1202"]
    journal.append(
        store.journal_path(tmp_path),
        {"day": "2026-10-13", "weekday": "Tue", "lists": {"C": {"core": core, "buy": []}}},
    )
    for name in core:
        store.append_result(name, {"day": "2026-10-13", "net": 100.0, "gross": 101.0}, tmp_path)
    monkeypatch.setattr(
        tomorrow,
        "next_session_picks",
        lambda today, root=None, track=None: tomorrow.NextPicks(
            date(2026, 10, 14), "Wed", core, [], None, None
        ),
    )
    return tmp_path


def test_result_goes_to_private_chat_and_group(telegram, evening_store):
    response = CliRunner().invoke(rotation_app, ["result", "--day", "2026-10-13"])
    assert response.exit_code == 0
    assert [request["chat_id"] for request in telegram] == ["123", "-456"]
    for request in telegram:
        text = request["text"]
        assert text.startswith("📊 Tue 13 Oct · result\n1 lot per strategy, after costs")
        assert "🎯 Adaptive   +₹300" in text
        assert "➡️ Wed 14 Oct" in text
        assert "Steady" not in text and "Calendar" not in text and "Baseline" not in text
        assert "parse_mode" not in request
    # both say T1 was not recorded; the group gets the owner's message without the real-money
    # block (and the live lines, none here)
    owner, group = telegram[0]["text"], telegram[1]["text"]
    assert "🧪 Tuned Adaptive (In Testing phase) · not recorded today" in owner
    assert "💼 Total capital" in owner and "💼" not in group
    assert group == "\n\n".join(p for p in owner.split("\n\n") if not p.startswith("💼"))


def test_result_is_not_sent_twice(telegram, evening_store):
    runner = CliRunner()
    assert runner.invoke(rotation_app, ["result", "--day", "2026-10-13"]).exit_code == 0
    sent = len(telegram)
    response = runner.invoke(rotation_app, ["result", "--day", "2026-10-13"])
    assert response.exit_code == 0
    assert "already sent" in response.output
    assert len(telegram) == sent


def test_result_not_ready_sends_nothing(telegram, evening_store):
    response = CliRunner().invoke(rotation_app, ["result", "--day", "2026-10-14"])
    assert response.exit_code == 2
    assert "result not ready" in response.output
    assert telegram == []


def test_the_optional_line_names_the_next_best_widesl_and_dir():
    entry = {
        "day": "2026-10-16",
        "weekday": "Fri",
        "lists": {"C": {"core": ["N_wide_1117", "N_ditm1_1002"], "buy": []}},
        "hash": "f1a772478960abcd",
        "recorded_at": "2026-10-16T09:16:25+05:30",
        "before_first_entry": True,
    }
    options = {"C": {"wide": "N_p100_1117", "dir": "N_ditm1_0932"}}
    lines = pick.render(entry, options).splitlines()
    assert "➕ Optional: Widesl 11:17 N_widesl_p100 · Dir 09:32 N_dir_ITM1" in lines
    assert "Optional" not in pick.render(entry)
    assert messages.optional_line({"wide": "N_p100_1117", "dir": None}) == (
        "➕ Optional: Widesl 11:17 N_widesl_p100"
    )
    assert messages.optional_line({"wide": None, "dir": None}) == ""


def test_plain_notifications_carry_exactly_the_text_they_are_given():
    assert notify.render(
        notify.Notification("s", "info", "", "line one\nline two", plain=True)
    ) == ("line one\nline two")
    framed = notify.render(notify.Notification("s", "info", "Title", "body"))
    assert framed.startswith("ℹ️ Title\ns, ")
