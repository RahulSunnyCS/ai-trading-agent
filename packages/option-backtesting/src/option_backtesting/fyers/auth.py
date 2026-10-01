"""
Fyers credential resolution. Never prints or logs a token.

Order (first hit wins):
  1. the dashboard's broker_tokens row, when DATABASE_URL is configured
  2. FYERS_APP_ID + FYERS_ACCESS_TOKEN in the environment
  3. FYERS_TOKEN_FILE — the 0600 JSON `packages/broker-login`'s `fyers-token` writes
  4. the token cached by `mbt login` (packages/momentum-backtesting/data/.fyers_token.json),
     same JSON shape as (2). Read-only: one browser login each morning serves both
     tools, and this package imports no code from momentum-backtesting.

Fyers tokens expire daily, so file sources are checked against `expires_at`.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

import psycopg

REPO_ROOT = Path(__file__).resolve().parents[5]
MBT_TOKEN_CACHE = REPO_ROOT / "packages" / "momentum-backtesting" / "data" / ".fyers_token.json"


class FyersCredentialsError(RuntimeError):
    pass


@dataclass(frozen=True)
class Credentials:
    app_id: str
    access_token: str = ""
    source: str = ""
    expires_at: datetime | None = None

    def __repr__(self) -> str:  # keep the token out of tracebacks and logs
        return f"Credentials(app_id={self.app_id!r}, source={self.source!r})"


def load_dotenv() -> None:
    """Fill unset env vars from the repo-root .env (the one both apps read)."""
    path = REPO_ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _from_file(path: Path, source: str) -> Credentials | None:
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    expires_at = datetime.fromisoformat(str(data["expires_at"]).replace("Z", "+00:00"))
    if expires_at <= datetime.now(UTC):
        return None
    return Credentials(data["app_id"], data["access_token"], source, expires_at)


def _from_dashboard(database_url: str) -> Credentials | None:
    """Read the same expiring token used by the dashboard and Momentum API."""
    passphrase = os.environ.get("FYERS_APP_SECRET", "")
    with psycopg.connect(database_url, connect_timeout=10) as conn:
        row = conn.execute(
            "SELECT app_id, CASE WHEN token_encrypted "
            "THEN pgp_sym_decrypt(dearmor(access_token), %s) "
            "ELSE access_token END AS access_token, expires_at FROM broker_tokens "
            "WHERE broker = 'fyers' LIMIT 1",
            (passphrase,),
        ).fetchone()
    if row is None:
        return None
    app_id, access_token, expires_at = row
    if expires_at <= datetime.now(UTC):
        return None
    return Credentials(app_id, access_token, "broker_tokens", expires_at)


def resolve_credentials() -> Credentials:
    load_dotenv()
    database_url = os.environ.get("DATABASE_URL", "").strip()
    database_error = False
    if database_url:
        try:
            if creds := _from_dashboard(database_url):
                return creds
        except psycopg.Error:
            # The standalone collector can still run from a token file while
            # the dashboard's database is stopped.
            database_error = True

    app_id = os.environ.get("FYERS_APP_ID", "").strip()
    token = os.environ.get("FYERS_ACCESS_TOKEN", "").strip()
    if app_id and token:
        return Credentials(app_id, token, "env")

    token_file = os.environ.get("FYERS_TOKEN_FILE", "").strip()
    if token_file and (creds := _from_file(Path(token_file), "FYERS_TOKEN_FILE")):
        return creds

    if creds := _from_file(MBT_TOKEN_CACHE, "mbt login cache"):
        return creds

    if database_error:
        raise FyersCredentialsError(
            "Fyers token database is unavailable and no fallback token exists."
        )
    raise FyersCredentialsError(
        "No valid Fyers token. Log in from the dashboard's Broker logins tab "
        "or run `mbt login` for standalone use."
    )
