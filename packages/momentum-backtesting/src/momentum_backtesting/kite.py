"""Zerodha Kite Connect, read-only (BL-142): the owner's Momentum money is on Kite.

Only three things are read: the login (request_token -> access token), the holdings and the
free equity cash. Nothing here places, changes or cancels an order, and no order endpoint is
called anywhere in this module.

Login (https://kite.trade/docs/connect/v3/user/): the browser goes to Kite's login page with the
app's `api_key`; Kite sends it back to the redirect URL registered on the app with a
`request_token`, exchanged here for an access token with
`sha256(api_key + request_token + api_secret)`. The token dies at 06:00 IST the next day, the
same reset as Fyers (`fyers.token_expiry`). It is cached in a 0600 file under DATA_DIR and never
printed.

Configuration (repo `.env`): KITE_API_KEY and KITE_API_SECRET. The redirect URL registered on
the Kite app is `http://127.0.0.1:8765/api/kite/callback` (this package's `mbt serve`).
"""

from __future__ import annotations

import hashlib
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import UTC, datetime

from .config import DATA_DIR
from .fyers import token_expiry

LOGIN_URL = "https://kite.zerodha.com/connect/login"
API_ROOT = "https://api.kite.trade"
TOKEN_CACHE = DATA_DIR / ".kite_token.json"
# The NSE series Kite can append to a tradingsymbol; stripped so symbols match the strategy's.
_SERIES = {"EQ", "BE", "BZ", "BL", "IL", "SM", "ST"}


class KiteCredentialsError(RuntimeError):
    pass


@dataclass(frozen=True)
class Credentials:
    api_key: str
    access_token: str = field(repr=False)
    expires_at: datetime
    user_id: str | None = None


def _config() -> tuple[str, str]:
    api_key = os.environ.get("KITE_API_KEY", "").strip()
    secret = os.environ.get("KITE_API_SECRET", "").strip()
    if not (api_key and secret):
        raise KiteCredentialsError("KITE_API_KEY and KITE_API_SECRET must be set in .env")
    return api_key, secret


def configured() -> bool:
    try:
        _config()
    except KiteCredentialsError:
        return False
    return True


def login_url(state: str) -> str:
    """Kite's login page for this app. `state` comes back on the redirect (as `redirect_params`)
    so the callback can tell a login it started from a stray request."""
    api_key, _secret = _config()
    query = urllib.parse.urlencode(
        {
            "v": "3",
            "api_key": api_key,
            "redirect_params": urllib.parse.urlencode({"state": state}),
        }
    )
    return f"{LOGIN_URL}?{query}"


def _request(path: str, *, token: str | None = None, data: dict | None = None) -> dict:
    headers = {"X-Kite-Version": "3"}
    if token:
        headers["Authorization"] = f"token {token}"
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    request = urllib.request.Request(f"{API_ROOT}{path}", data=body, headers=headers)
    try:
        payload = json.load(urllib.request.urlopen(request, timeout=15))
    except urllib.error.HTTPError as error:
        try:
            payload = json.loads(error.read().decode() or "{}")
        except ValueError:
            payload = {}
        # Never echo a response body wholesale: a partial success could carry a token.
        message = payload.get("message") or f"HTTP {error.code}"
        if error.code == 403 or payload.get("error_type") == "TokenException":
            raise KiteCredentialsError(f"Kite refused the login: {message}") from None
        raise RuntimeError(f"Kite {path}: {message}") from None
    except urllib.error.URLError as error:
        raise RuntimeError(f"Kite {path}: {error.reason}") from None
    except (TimeoutError, OSError, ValueError) as error:
        # A read timeout (not wrapped in URLError) or a body that is not JSON.
        raise RuntimeError(f"Kite {path}: {type(error).__name__}") from None
    if payload.get("status") != "success":
        raise RuntimeError(f"Kite {path}: {payload.get('message') or 'no data'}")
    return payload.get("data") or {}


def exchange_request_token(request_token: str) -> Credentials:
    api_key, secret = _config()
    checksum = hashlib.sha256(f"{api_key}{request_token}{secret}".encode()).hexdigest()
    data = _request(
        "/session/token",
        data={"api_key": api_key, "request_token": request_token, "checksum": checksum},
    )
    token = data.get("access_token")
    if not token:
        raise KiteCredentialsError("Kite's token exchange returned no access token.")
    return Credentials(api_key, token, token_expiry(datetime.now(UTC)), data.get("user_id"))


def save_token(creds: Credentials) -> None:
    TOKEN_CACHE.parent.mkdir(parents=True, exist_ok=True)
    # Create with 0600 before writing, so the token is never readable by others even briefly.
    fd = os.open(TOKEN_CACHE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(
            {
                "api_key": creds.api_key,
                "access_token": creds.access_token,
                "expires_at": creds.expires_at.isoformat(),
                "user_id": creds.user_id,
            },
            handle,
        )
    TOKEN_CACHE.chmod(0o600)


def cached_credentials() -> Credentials | None:
    """Today's token, if one is cached, unexpired and minted for the configured app."""
    if not TOKEN_CACHE.exists():
        return None
    try:
        data = json.loads(TOKEN_CACHE.read_text())
        expires_at = datetime.fromisoformat(data["expires_at"])
    except (ValueError, KeyError):
        return None
    if expires_at <= datetime.now(UTC):
        return None
    api_key = os.environ.get("KITE_API_KEY", "").strip()
    if api_key and data.get("api_key") != api_key:
        return None  # minted for another app: useless with this key
    return Credentials(data["api_key"], data["access_token"], expires_at, data.get("user_id"))


def resolve_credentials() -> Credentials:
    creds = cached_credentials()
    if creds is None:
        raise KiteCredentialsError(
            "No valid Kite login today. Log in on the dashboard (Broker logins > Kite)."
        )
    return creds


def _auth(creds: Credentials) -> str:
    return f"{creds.api_key}:{creds.access_token}"


def symbol_of(tradingsymbol: str) -> str:
    """'SBIN' -> 'SBIN'; 'XYZ-BE' -> 'XYZ'. Anything else is returned as it is."""
    base, _, series = tradingsymbol.rpartition("-")
    return base if base and series in _SERIES else tradingsymbol


def holdings(creds: Credentials) -> list[dict]:
    """The account's delivery holdings, read-only: one dict per symbol with `symbol`,
    `quantity` (settled + T1, so a buy from the day before counts) and `avg_price`.

    A buy or sale placed today is not in it until the next day; the Friday 14:15 snapshot is
    taken on a day the owner does not trade (they buy on Mondays). Pledged shares stay in
    `quantity`, so collateral is still counted as held."""
    rows = _request("/portfolio/holdings", token=_auth(creds))
    merged: dict[str, dict] = {}
    for item in rows if isinstance(rows, list) else []:
        symbol = symbol_of(str(item.get("tradingsymbol", "")))
        quantity = float(item.get("quantity") or 0) + float(item.get("t1_quantity") or 0)
        if not symbol or quantity <= 0:
            continue
        price = float(item.get("average_price") or 0)
        row = merged.setdefault(symbol, {"symbol": symbol, "quantity": 0.0, "cost": 0.0})
        row["quantity"] += quantity
        row["cost"] += quantity * price
    return [
        {
            "symbol": r["symbol"],
            "quantity": r["quantity"],
            "avg_price": (r["cost"] / r["quantity"]) if r["cost"] else None,
        }
        for r in merged.values()
    ]


def free_cash(creds: Credentials) -> float:
    """Cash that can pay for delivery buys: the equity margins' `net` minus `available.collateral`.

    `net` includes the margin from pledged holdings (LIQUIDBEES and the gold bonds, kept as
    options margin), which cannot fund a delivery buy, and is already reduced by the margin open
    positions use. Taking the collateral out leaves the cash; never below 0, so open options can
    never make the plan trim Momentum holdings."""
    data = _request("/user/margins/equity", token=_auth(creds))
    net = float(data.get("net") or 0.0)
    collateral = float((data.get("available") or {}).get("collateral") or 0.0)
    return max(0.0, net - collateral)


def probe(creds: Credentials) -> bool:
    """Is the token still accepted? (A Kite web logout ends it before 06:00.)"""
    try:
        _request("/user/profile", token=_auth(creds))
    except KiteCredentialsError:
        return False
    return True
