import os
from datetime import UTC, datetime, timedelta, timezone

import psycopg
import pytest

from option_backtesting.fyers import auth

_real_load_dotenv = auth.load_dotenv  # the autouse fixture below stubs it out
IST = timezone(timedelta(hours=5, minutes=30))


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

        def execute(self, query, _params=None):
            assert "FROM broker_tokens" in query
            return self

        def fetchone(self):
            return ("dashboard-app", "dashboard-token", expires, datetime.now(UTC))

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


def _fake_db(monkeypatch, row):
    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            pass

        def execute(self, _query, _params=None):
            return self

        def fetchone(self):
            return row

    monkeypatch.setattr(psycopg, "connect", lambda *_args, **_kwargs: Connection())


@pytest.mark.parametrize(
    ("issued", "expires"),
    [
        (datetime(2026, 10, 6, 10, 0, tzinfo=IST), datetime(2026, 10, 7, 6, 0, tzinfo=IST)),
        (datetime(2026, 10, 6, 5, 59, tzinfo=IST), datetime(2026, 10, 6, 6, 0, tzinfo=IST)),
        (datetime(2026, 10, 6, 6, 0, tzinfo=IST), datetime(2026, 10, 7, 6, 0, tzinfo=IST)),
    ],
)
def test_token_dies_at_the_next_0600_ist(issued, expires):
    assert auth.token_expiry(issued.astimezone(UTC)) == expires


def test_dashboard_row_minted_before_the_last_0600_ist_is_expired(monkeypatch):
    # stored with the old now+24h expiry, so expires_at alone still looks valid
    _fake_db(
        monkeypatch,
        ("dashboard-app", "stale", datetime.now(UTC) + timedelta(hours=2),
         datetime.now(UTC) - timedelta(hours=25)),
    )  # fmt: skip
    monkeypatch.setenv("DATABASE_URL", "postgresql://local/test")
    monkeypatch.setenv("FYERS_APP_ID", "env-app")
    monkeypatch.setenv("FYERS_ACCESS_TOKEN", "env-token")

    assert auth.resolve_credentials().source == "env"


def test_dotenv_strips_export_and_inline_comments(monkeypatch, tmp_path):
    (tmp_path / ".env").write_text(
        "# comment\n"
        "export OBT_TEST_A=alpha\n"
        'OBT_TEST_B="beta value" # trailing note\n'
        "OBT_TEST_C=gamma#not-a-comment\n"
    )
    monkeypatch.setattr(auth, "REPO_ROOT", tmp_path)
    for key in ("OBT_TEST_A", "OBT_TEST_B", "OBT_TEST_C"):
        monkeypatch.setenv(key, "")  # registers the key so the loaded value is undone afterwards
        monkeypatch.delenv(key)

    _real_load_dotenv()

    assert os.environ["OBT_TEST_A"] == "alpha"
    assert os.environ["OBT_TEST_B"] == "beta value"
    assert os.environ["OBT_TEST_C"] == "gamma#not-a-comment"
