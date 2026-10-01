from datetime import UTC, datetime, timedelta

import psycopg
import pytest

from option_backtesting.fyers import auth


@pytest.fixture(autouse=True)
def isolated_credentials(monkeypatch, tmp_path):
    monkeypatch.setattr(auth, "load_dotenv", lambda: None)
    monkeypatch.setattr(auth, "MBT_TOKEN_CACHE", tmp_path / "absent-token.json")
    for key in ("DATABASE_URL", "FYERS_APP_ID", "FYERS_ACCESS_TOKEN", "FYERS_TOKEN_FILE"):
        monkeypatch.delenv(key, raising=False)


def test_dashboard_token_takes_precedence_over_environment(monkeypatch):
    expires = datetime.now(UTC) + timedelta(hours=2)

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def execute(self, query):
            assert "FROM broker_tokens" in query
            return self

        def fetchone(self):
            return ("dashboard-app", "dashboard-token", expires)

    monkeypatch.setattr(psycopg, "connect", lambda *_args, **_kwargs: Connection())
    monkeypatch.setenv("DATABASE_URL", "postgresql://local/test")
    monkeypatch.setenv("FYERS_APP_ID", "env-app")
    monkeypatch.setenv("FYERS_ACCESS_TOKEN", "env-token")

    creds = auth.resolve_credentials()
    assert (creds.app_id, creds.access_token, creds.source) == (
        "dashboard-app",
        "dashboard-token",
        "broker_tokens",
    )
    assert "dashboard-token" not in repr(creds)


def test_expired_dashboard_token_falls_back_to_environment(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://local/test")
    monkeypatch.setenv("FYERS_APP_ID", "env-app")
    monkeypatch.setenv("FYERS_ACCESS_TOKEN", "env-token")
    monkeypatch.setattr(auth, "_from_dashboard", lambda _url: None)

    assert auth.resolve_credentials().source == "env"


def test_unavailable_database_keeps_standalone_fallback(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://local/test")
    monkeypatch.setenv("FYERS_APP_ID", "env-app")
    monkeypatch.setenv("FYERS_ACCESS_TOKEN", "env-token")

    def unavailable(_url):
        raise psycopg.OperationalError("connection failed")

    monkeypatch.setattr(auth, "_from_dashboard", unavailable)
    assert auth.resolve_credentials().source == "env"


def test_unavailable_database_without_fallback_has_clear_error(monkeypatch):
    monkeypatch.setenv("DATABASE_URL", "postgresql://local/test")

    def unavailable(_url):
        raise psycopg.OperationalError("connection failed")

    monkeypatch.setattr(auth, "_from_dashboard", unavailable)
    with pytest.raises(auth.FyersCredentialsError, match="database is unavailable"):
        auth.resolve_credentials()
