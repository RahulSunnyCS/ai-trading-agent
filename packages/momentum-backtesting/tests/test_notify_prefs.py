"""Notification preferences (BL-012): same file and rules as @trading/notify's prefs.ts."""

from momentum_backtesting import notify
from momentum_backtesting.notify import Notification


def test_missing_file_sends_everything(tmp_path):
    assert notify.is_enabled("momentum.final", tmp_path / "absent.json")


def test_switched_off_type_is_skipped(tmp_path):
    path = tmp_path / "notifications.json"
    path.write_text('{"disabled": ["momentum.preview"]}')
    assert not notify.is_enabled("momentum.preview", path)
    assert notify.is_enabled("momentum.final", path)
    assert notify.is_enabled(None, path)  # untagged is never optional


def test_broken_file_fails_open(tmp_path):
    path = tmp_path / "notifications.json"
    for text in ("{not json", '["momentum.final"]', '{"disabled": "momentum.final"}'):
        path.write_text(text)
        assert notify.disabled_types(path) == set()


def test_send_skips_a_switched_off_type(tmp_path, monkeypatch, capsys):
    path = tmp_path / "notifications.json"
    path.write_text('{"disabled": ["momentum.preview"]}')
    monkeypatch.setenv("NOTIFY_PREFS_FILE", str(path))
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "token-1234")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "1")
    called = []
    monkeypatch.setattr(notify.urllib.request, "urlopen", lambda *a, **k: called.append(a))
    notify.send(Notification("momentum-weekly", "info", "x", type="momentum.preview"))
    assert called == []
    assert "switched off" in capsys.readouterr().out


def test_warn_is_a_known_severity():
    # "warning" used to be sent from three places and raised KeyError in render().
    notify.render(Notification("momentum-journal", "warn", "x"))
