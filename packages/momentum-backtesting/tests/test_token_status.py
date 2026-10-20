"""BL-143: `mbt token-status --probe` (the 09:00 morning check) refuses a token Fyers rejects, and a
`.env` token with no known expiry that cannot be confirmed. The probe is faked: no network."""

from datetime import UTC, datetime, timedelta

from typer.testing import CliRunner

from momentum_backtesting import cli, fyers


def test_verdicts():
    assert cli.token_verdict("env", False, "valid") is None
    assert "rejects" in cli.token_verdict("broker_tokens", True, "rejected")
    assert "no known expiry" in cli.token_verdict("env", False, "unknown")
    assert cli.token_verdict("broker_tokens", True, "unknown") is None


def test_probe_flag_fails_an_unconfirmed_env_token(monkeypatch):
    monkeypatch.setattr(
        fyers, "resolve_credentials", lambda: fyers.Credentials("A-100", "t", "env")
    )
    monkeypatch.setattr(fyers, "probe_token", lambda creds: "unknown")
    out = CliRunner().invoke(cli.app, ["token-status", "--probe"])
    assert out.exit_code == 1
    assert out.output.startswith("not ready:")


def test_probe_flag_passes_an_accepted_token(monkeypatch):
    later = datetime.now(UTC) + timedelta(hours=5)
    creds = fyers.Credentials("A-100", "t", "broker_tokens", later)
    monkeypatch.setattr(fyers, "resolve_credentials", lambda: creds)
    monkeypatch.setattr(fyers, "probe_token", lambda creds: "valid")
    out = CliRunner().invoke(cli.app, ["token-status", "--probe"])
    assert out.exit_code == 0
    assert "Fyers accepts it" in out.output
