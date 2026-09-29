"""
Fyers credential resolution. Never prints or logs a token.

Order (first hit wins):
  1. FYERS_APP_ID + FYERS_ACCESS_TOKEN in the environment
  2. FYERS_TOKEN_FILE — the 0600 JSON `packages/broker-login`'s `fyers-token` writes
  3. the token cached by `mbt login` (packages/momentum-backtesting/data/.fyers_token.json),
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


def resolve_credentials() -> Credentials:
    load_dotenv()
    app_id = os.environ.get("FYERS_APP_ID", "").strip()
    token = os.environ.get("FYERS_ACCESS_TOKEN", "").strip()
    if app_id and token:
        return Credentials(app_id, token, "env")

    token_file = os.environ.get("FYERS_TOKEN_FILE", "").strip()
    if token_file and (creds := _from_file(Path(token_file), "FYERS_TOKEN_FILE")):
        return creds

    if creds := _from_file(MBT_TOKEN_CACHE, "mbt login cache"):
        return creds

    raise FyersCredentialsError(
        "No valid Fyers token. Log in once for today with:\n"
        "  cd packages/momentum-backtesting && uv run mbt login"
    )
