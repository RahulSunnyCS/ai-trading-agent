"""The Fyers and Kite login reminders' phone link (DASHBOARD_PUBLIC_URL) and `mbt token-remind`,
the trading-day Fyers reminder. Fyers is faked: no network."""

from datetime import UTC, datetime, timedelta

from typer.testing import CliRunner

from momentum_backtesting import cli, fyers, login_nudge, notify

LAPTOP = "On the laptop: dashboard > Broker logins > Fyers > Log in."


def test_no_hosted_dashboard_means_the_laptop_way_and_no_link(monkeypatch):
    monkeypatch.setenv("DASHBOARD_PUBLIC_URL", "")
    assert login_nudge.how_to_log_in(LAPTOP) == (LAPTOP, None)


def test_the_link_is_the_hosted_broker_logins_page(monkeypatch):
    monkeypatch.setenv("DASHBOARD_PUBLIC_URL", "https://dash.example/")
    monkeypatch.setattr(login_nudge, "phone_blockers", lambda: [])
    how, link = login_nudge.how_to_log_in(LAPTOP)
    assert link == "https://dash.example/brokerLogins"
    assert how.startswith("From your phone") and "on the laptop" in how


def test_a_stopped_api_or_tunnel_is_said(monkeypatch):
    monkeypatch.setenv("DASHBOARD_PUBLIC_URL", "https://dash.example")
    monkeypatch.setattr(login_nudge, "_api_listening", lambda port=8765: False)
    monkeypatch.setattr(login_nudge, "_tunnel_running", lambda: False)
    how, link = login_nudge.how_to_log_in(LAPTOP)
    assert how.startswith("A phone login won't work right now")
    assert "Momentum API" in how and "tunnel" in how and how.endswith(LAPTOP)
    assert link == "https://dash.example/brokerLogins"


def _remind(monkeypatch, probe, *args):
    sent = []
    monkeypatch.setattr(notify, "send", lambda note: sent.append(note))
    monkeypatch.setenv("DASHBOARD_PUBLIC_URL", "https://dash.example")
    monkeypatch.setattr(login_nudge, "phone_blockers", lambda: [])
    later = datetime.now(UTC) + timedelta(hours=5)
    creds = fyers.Credentials("A-100", "t", "broker_tokens", later)
    monkeypatch.setattr(fyers, "resolve_credentials", lambda: creds)
    monkeypatch.setattr(fyers, "probe_token", lambda creds: probe)
    out = CliRunner().invoke(cli.app, ["token-remind", "--send", *args])
    return out, sent


def test_an_accepted_token_is_silent(monkeypatch):
    out, sent = _remind(monkeypatch, "valid")
    assert out.exit_code == 0 and "nothing to remind" in out.output and sent == []


def test_a_rejected_token_sends_the_link(monkeypatch):
    out, sent = _remind(monkeypatch, "rejected", "--when", "evening")
    assert out.exit_code == 0 and len(sent) == 1
    note = sent[0]
    assert note.type == "broker.fyers" and note.severity == "action_required"
    assert note.run_url == "https://dash.example/brokerLogins"
    assert "rejects" in note.body and "15:45" in note.body


def test_no_token_at_all_is_reminded_too(monkeypatch):
    sent = []
    monkeypatch.setattr(notify, "send", lambda note: sent.append(note))
    monkeypatch.setenv("DASHBOARD_PUBLIC_URL", "")

    def missing():
        raise fyers.FyersCredentialsError("No Fyers token.")

    monkeypatch.setattr(fyers, "resolve_credentials", missing)
    out = CliRunner().invoke(cli.app, ["token-remind", "--send"])
    assert out.exit_code == 0 and len(sent) == 1
    assert sent[0].body.startswith("No Fyers token.\n") and sent[0].run_url is None
    assert "09:16" in sent[0].body
