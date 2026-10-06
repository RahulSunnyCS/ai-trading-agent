"""Notification preferences (BL-012): same file and rules as @trading/notify's prefs.ts."""

from option_backtesting import notify
from option_backtesting.notify import Notification


def test_switched_off_type_is_skipped(tmp_path, monkeypatch):
    path = tmp_path / "notifications.json"
    path.write_text('{"disabled": ["options.daily"]}')
    monkeypatch.setenv("NOTIFY_PREFS_FILE", str(path))
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "token-1234")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "1")
    called = []
    monkeypatch.setattr(notify.urllib.request, "urlopen", lambda *a, **k: called.append(a))
    delivered, _ = notify.send(Notification("obt", "info", "x", type="options.daily"))
    assert (delivered, called) == (False, [])


def test_missing_or_broken_file_sends_everything(tmp_path):
    assert notify.is_enabled("options.problem", tmp_path / "absent.json")
    broken = tmp_path / "broken.json"
    broken.write_text("{not json")
    assert notify.is_enabled("options.problem", broken)
