"""`mbt kite auto-login` (owner, 2026-10-28): the switch, the hold after a refused password, the
redirect it accepts, Kite's messages classified. The browser is faked: no network, no Kite."""

import json

import pytest
from typer.testing import CliRunner

from momentum_backtesting import cli, kite, kite_login

CREDS = {"KITE_USER_ID": "AB1234", "KITE_PASSWORD": "pw-secret", "KITE_TOTP_SECRET": "JBSWY3DP"}


@pytest.fixture(autouse=True)
def env(monkeypatch, tmp_path):
    monkeypatch.setenv("KITE_API_KEY", "key123")
    monkeypatch.setenv("KITE_API_SECRET", "secret456")
    monkeypatch.setenv("KITE_AUTO_LOGIN", "on")
    for key, value in CREDS.items():
        monkeypatch.setenv(key, value)
    monkeypatch.setattr(kite, "TOKEN_CACHE", tmp_path / ".kite_token.json")
    monkeypatch.setattr(kite_login, "HOLD_FILE", tmp_path / ".kite_login_hold.json")
    return tmp_path


def test_only_this_logins_redirect_gives_a_token():
    url = "https://dash.example/api/momentum/kite/callback?action=login&type=login"
    assert (
        kite_login.request_token_from(f"{url}&status=success&request_token=RT&state=S1", "S1")
        == "RT"
    )
    assert (
        kite_login.request_token_from(f"{url}&status=success&request_token=RT&state=S2", "S1")
        is None
    )
    assert (
        kite_login.request_token_from(f"{url}&status=cancelled&request_token=RT&state=S1", "S1")
        is None
    )
    assert kite_login.request_token_from(f"{url}&status=success&state=S1", "S1") is None


def test_kites_messages_are_classified():
    assert kite_login.classify("Invalid `user_id` or `password`.") == "refused"
    assert kite_login.classify("Your account has been blocked") == "refused"
    assert kite_login.classify("Invalid TOTP") == "totp"
    assert kite_login.classify("Please complete the captcha") == "human"
    assert kite_login.classify("Something went wrong") == "other"


def test_off_by_default(monkeypatch):
    monkeypatch.setenv("KITE_AUTO_LOGIN", "")
    called = []
    monkeypatch.setattr(kite_login, "browser_login", lambda *a, **k: called.append(1))
    assert kite_login.auto_login().status == "SKIPPED" and called == []


def test_missing_credentials_fail_without_a_browser(monkeypatch):
    monkeypatch.setenv("KITE_TOTP_SECRET", "")
    called = []
    monkeypatch.setattr(kite_login, "browser_login", lambda *a, **k: called.append(1))
    outcome = kite_login.auto_login()
    assert outcome.status == "FAIL" and "KITE_TOTP_SECRET" in outcome.detail and called == []


def test_a_login_stores_the_token(monkeypatch):
    monkeypatch.setattr(kite_login, "browser_login", lambda creds, headed=False: "RT")
    monkeypatch.setattr(kite_login, "finish_login", lambda token: f"Kite connected ({token}).")
    outcome = kite_login.auto_login()
    assert (outcome.status, outcome.detail) == ("OK", "Kite connected (RT).")


def test_already_logged_in_needs_no_browser(monkeypatch):
    monkeypatch.setattr(kite, "cached_credentials", lambda: object())
    monkeypatch.setattr(kite, "probe", lambda creds: True)
    monkeypatch.setattr(kite_login, "browser_login", lambda *a, **k: pytest.fail("logged in"))
    assert kite_login.auto_login().detail == "already logged in today"


def test_a_refused_password_holds_until_the_credentials_change(monkeypatch):
    tries = []

    def refused(creds, headed=False):
        tries.append(1)
        raise kite_login.KiteLoginError("Kite: Invalid user_id or password", "refused")

    monkeypatch.setattr(kite_login, "browser_login", refused)
    first = kite_login.auto_login()
    assert first.status == "FAIL" and "Invalid" in first.detail and len(tries) == 1
    second = kite_login.auto_login()
    assert second.status == "FAIL" and second.detail.startswith("held:") and len(tries) == 1
    monkeypatch.setenv("KITE_PASSWORD", "new-pw")
    kite_login.auto_login()
    assert len(tries) == 2


def test_a_failure_detail_never_carries_the_password(monkeypatch):
    def leaky(creds, headed=False):
        raise kite_login.KiteLoginError(f"odd page with {creds['KITE_PASSWORD']}")

    monkeypatch.setattr(kite_login, "browser_login", leaky)
    outcome = kite_login.auto_login()
    assert "pw-secret" not in outcome.detail and outcome.status == "FAIL"


def test_the_cli_writes_the_outcome_and_exits_1_on_a_failure(monkeypatch, env):
    monkeypatch.setattr(
        kite_login,
        "browser_login",
        lambda *a, **k: (_ for _ in ()).throw(kite_login.KiteLoginError("timed out")),
    )
    out_file = env / "kite.json"
    out = CliRunner().invoke(cli.app, ["kite", "auto-login", "--json-out", str(out_file)])
    assert out.exit_code == 1
    assert json.loads(out_file.read_text()) == {
        "status": "FAIL",
        "detail": "timed out",
        "name": "Kite",
    }
