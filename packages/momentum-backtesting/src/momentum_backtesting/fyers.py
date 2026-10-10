"""Fyers v3 history client for daily candles.

Credential precedence:
  1. the valid broker_tokens row written by the dashboard's Fyers login, when
     DATABASE_URL is configured and reachable
  2. FYERS_APP_ID + FYERS_ACCESS_TOKEN from the environment / repo .env
  3. FYERS_TOKEN_FILE - the JSON file packages/broker-login's `fyers-token` writes in CI
  4. the token cached by `mbt login` (data/.fyers_token.json), if not expired
Direct-mode dashboard previews prefer the local login cache over env fallbacks.
Fyers tokens expire daily, so the cache and DB paths check expires_at first.
"""

import hashlib
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta, timezone
from datetime import time as dt_time

import pandas as pd

from .config import DATA_DIR

AUTH_URL = "https://api-t1.fyers.in/api/v3/generate-authcode"
TOKEN_URL = "https://api-t1.fyers.in/api/v3/validate-authcode"
HISTORY_URL = "https://api-t1.fyers.in/data/history"
TOKEN_CACHE = DATA_DIR / ".fyers_token.json"
# Fyers' gateway rejects Python's default "Python-urllib" User-Agent with an HTTP 403
# ("error code: 1010") before the request reaches the API.
USER_AGENT = "Mozilla/5.0 (momentum-backtesting)"


_IST = timezone(timedelta(hours=5, minutes=30))
# Fyers invalidates every access token at its daily reset, whatever expires_in says.
TOKEN_RESET_IST = dt_time(6, 0)


def token_expiry(issued_at: datetime, expires_in: float | None = None) -> datetime:
    """When a token minted at `issued_at` really stops working: the next 06:00 IST reset,
    or earlier if Fyers states a shorter expires_in."""
    local = issued_at.astimezone(_IST)
    reset = datetime.combine(local.date(), TOKEN_RESET_IST, tzinfo=_IST)
    if reset <= local:
        reset += timedelta(days=1)
    expiry = reset.astimezone(UTC)
    if expires_in:
        expiry = min(expiry, issued_at + timedelta(seconds=expires_in))
    return expiry


def _error_body(error: urllib.error.HTTPError) -> dict:
    """Fyers errors are usually JSON, but the gateway in front of it returns plain text."""
    raw = error.read() or b""
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"s": "error", "message": f"HTTP {error.code} from Fyers"}


DAILY_MAX_DAYS = 366  # Fyers caps a 1D request at 366 days
PAUSE_S = 0.4  # Fyers allows 10/s and 200/min per account; stay well under both


class FyersCredentialsError(RuntimeError):
    pass


@dataclass(frozen=True)
class Credentials:
    app_id: str
    access_token: str = field(repr=False)
    source: str
    expires_at: datetime | None = None


def _oauth_config() -> tuple[str, str, str]:
    app_id = os.environ.get("FYERS_APP_ID", "").strip()
    secret = os.environ.get("FYERS_APP_SECRET", "").strip()
    port = os.environ.get("PORT", "3000")
    redirect = os.environ.get("FYERS_REDIRECT_URI", "").strip() or (
        f"http://localhost:{port}/api/auth/fyers/callback"
    )
    if not (app_id and secret):
        raise FyersCredentialsError("FYERS_APP_ID and FYERS_APP_SECRET must be set in .env")
    return app_id, secret, redirect


def build_auth_url() -> tuple[str, str]:
    """Returns (login URL, state). Same parameters the dashboard's login button uses."""
    app_id, _secret, redirect = _oauth_config()
    state = secrets.token_urlsafe(16)
    query = urllib.parse.urlencode(
        {"client_id": app_id, "redirect_uri": redirect, "response_type": "code", "state": state}
    )
    return f"{AUTH_URL}?{query}", state


def parse_auth_code(pasted: str, expected_state: str) -> str:
    """Accepts the full redirected URL (preferred - lets us check state) or a bare code."""
    pasted = pasted.strip()
    if "://" not in pasted and "=" not in pasted:
        return pasted
    params = urllib.parse.parse_qs(urllib.parse.urlparse(pasted).query)
    state = params.get("state", [""])[0]
    if state and state != expected_state:
        raise FyersCredentialsError("Login state mismatch - start `mbt login` again.")
    code = (params.get("auth_code") or params.get("code") or [""])[0]
    if not code:
        raise FyersCredentialsError("No auth_code found in the pasted URL.")
    return code


def exchange_auth_code(auth_code: str) -> Credentials:
    app_id, secret, _redirect = _oauth_config()
    app_id_hash = hashlib.sha256(f"{app_id}:{secret}".encode()).hexdigest()
    payload = {"grant_type": "authorization_code", "appIdHash": app_id_hash, "code": auth_code}
    request = urllib.request.Request(
        TOKEN_URL,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
    )
    try:
        body = json.load(urllib.request.urlopen(request, timeout=30))
    except urllib.error.HTTPError as error:
        body = _error_body(error)
    if body.get("s") != "ok" or not body.get("access_token"):
        # Never echo the body - a partial success could contain a token.
        detail = body.get("message") or f"s={body.get('s')} code={body.get('code')}"
        raise FyersCredentialsError(f"Fyers token exchange failed: {detail}")
    expires_at = token_expiry(datetime.now(UTC), body.get("expires_in"))
    return Credentials(app_id, body["access_token"], "mbt login", expires_at)


def save_token(creds: Credentials) -> None:
    TOKEN_CACHE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_CACHE.write_text(
        json.dumps(
            {
                "app_id": creds.app_id,
                "access_token": creds.access_token,
                "expires_at": creds.expires_at.isoformat() if creds.expires_at else None,
            }
        )
    )
    TOKEN_CACHE.chmod(0o600)


PROFILE_URL = "https://api-t1.fyers.in/api/v3/profile"
_PROBE_TTL_S = 300.0
_probe_cache: dict[str, tuple[float, str]] = {}


def probe_token(creds: Credentials) -> str:
    """'valid', 'rejected' or 'unknown' - whether Fyers accepts the token right now.

    The expiry date cannot see a revoked token. Only an explicit rejection counts; a network
    failure is 'unknown' so an outage never reads as a logout. Cached for five minutes."""
    key = f"{creds.app_id}:{creds.access_token[-12:]}"
    hit = _probe_cache.get(key)
    if hit and time.monotonic() - hit[0] < _PROBE_TTL_S:
        return hit[1]
    request = urllib.request.Request(
        PROFILE_URL,
        headers={
            "Authorization": f"{creds.app_id}:{creds.access_token}",
            "User-Agent": USER_AGENT,
        },
    )
    result = "unknown"
    try:
        body = json.load(urllib.request.urlopen(request, timeout=5))
        if body.get("s") == "ok":
            result = "valid"
        elif body.get("s") == "error" and re.search(
            r"authenticat|token|expired", str(body.get("message", "")), re.I
        ):
            result = "rejected"
    except urllib.error.HTTPError as error:
        # Only 401. A 403 is Fyers' gateway turning the client away, not a verdict on the token.
        if error.code == 401:
            result = "rejected"
    except (OSError, ValueError):
        pass
    if result != "unknown":
        _probe_cache[key] = (time.monotonic(), result)
    return result


def save_token_to_db(creds: Credentials) -> bool:
    """Store the token where the dashboard and `resolve_credentials` read it (encrypted
    `broker_tokens` row, same SQL as apps/server's saveToken). False when there is no
    reachable database - the 0600 cache from `save_token` is then the only copy."""
    database_url = os.environ.get("DATABASE_URL", "").strip()
    passphrase = os.environ.get("FYERS_APP_SECRET", "")
    if not (database_url and passphrase and creds.expires_at):
        return False
    import psycopg

    try:
        with psycopg.connect(database_url, connect_timeout=10) as conn:
            conn.execute(
                "INSERT INTO broker_tokens "
                "(broker, app_id, access_token, refresh_token, expires_at, updated_at, "
                "token_encrypted) VALUES ('fyers', %s, "
                "armor(pgp_sym_encrypt(%s, %s, 'cipher-algo=aes256')), NULL, %s, NOW(), TRUE) "
                "ON CONFLICT (broker) DO UPDATE SET app_id = EXCLUDED.app_id, "
                "access_token = EXCLUDED.access_token, refresh_token = NULL, "
                "expires_at = EXCLUDED.expires_at, token_encrypted = TRUE, updated_at = NOW()",
                (creds.app_id, creds.access_token, passphrase, creds.expires_at),
            )
    except psycopg.Error:
        return False
    return True


def _cached_token() -> Credentials | None:
    if not TOKEN_CACHE.exists():
        return None
    data = json.loads(TOKEN_CACHE.read_text())
    expires_at = datetime.fromisoformat(data["expires_at"])
    # Caches written before the 06:00 IST rule carry now+24h; the file's mtime is the issue time.
    issued_at = datetime.fromtimestamp(TOKEN_CACHE.stat().st_mtime, UTC)
    expires_at = min(expires_at, token_expiry(issued_at))
    if expires_at <= datetime.now(UTC):
        return None
    return Credentials(data["app_id"], data["access_token"], "mbt login cache", expires_at)


def _dashboard_credentials() -> Credentials:
    """Read the dashboard's server-side token cache, enforcing broker expiry."""
    database_url = os.environ.get("DATABASE_URL", "").strip()
    if not database_url:
        raise FyersCredentialsError("The dashboard token database is not configured.")

    import psycopg

    passphrase = os.environ.get("FYERS_APP_SECRET", "")
    try:
        with psycopg.connect(database_url, connect_timeout=10) as conn:
            row = conn.execute(
                "SELECT app_id, "
                "CASE WHEN token_encrypted "
                "THEN pgp_sym_decrypt(dearmor(access_token), %s) "
                "ELSE access_token END AS access_token, expires_at, updated_at FROM broker_tokens "
                "WHERE broker = 'fyers' LIMIT 1",
                (passphrase,),
            ).fetchone()
    except psycopg.Error:
        raise FyersCredentialsError(
            "The dashboard's Fyers token database is unavailable."
        ) from None
    if row is None:
        raise FyersCredentialsError(
            "No Fyers token stored yet - log in with the dashboard's 'Login with Fyers' button."
        )
    stored_app_id, stored_token, expires_at, updated_at = row
    # Rows stored before the 06:00 IST rule carry now+24h; updated_at is when it was issued.
    expires_at = min(expires_at, token_expiry(updated_at))
    if expires_at <= datetime.now(UTC):
        raise FyersCredentialsError(
            f"The stored Fyers token expired at {expires_at:%Y-%m-%d %H:%M %Z} - "
            "log in with the dashboard's 'Login with Fyers' button again."
        )
    return Credentials(stored_app_id, stored_token, "broker_tokens", expires_at)


def resolve_credentials(*, prefer_dashboard: bool = False) -> Credentials:
    """Prefer the dashboard token; preserve standalone env/file/cache fallbacks."""
    database_error: FyersCredentialsError | None = None
    if os.environ.get("DATABASE_URL", "").strip():
        try:
            return _dashboard_credentials()
        except FyersCredentialsError as error:
            database_error = error

    if prefer_dashboard:
        # Direct mode writes OAuth tokens to a local 0600 cache when Postgres
        # is stopped; that fresh login should beat an old env token.
        cached = _cached_token()
        if cached:
            return cached
    app_id = os.environ.get("FYERS_APP_ID", "").strip()
    token = os.environ.get("FYERS_ACCESS_TOKEN", "").strip()
    if app_id and token:
        return Credentials(app_id, token, "env")

    token_file = os.environ.get("FYERS_TOKEN_FILE", "").strip()
    if token_file:
        from pathlib import Path

        path = Path(token_file)
        if path.exists():
            data = json.loads(path.read_text())
            expires_at = datetime.fromisoformat(data["expires_at"].replace("Z", "+00:00"))
            if expires_at > datetime.now(UTC):
                return Credentials(
                    data["app_id"], data["access_token"], "FYERS_TOKEN_FILE", expires_at
                )

    cached = _cached_token()
    if cached:
        return cached

    if database_error is not None:
        raise database_error
    raise FyersCredentialsError(
        "No Fyers token: log in from Broker logins, run `mbt login`, "
        "or set FYERS_ACCESS_TOKEN in .env."
    )


def _get(params: dict[str, str | int], creds: Credentials) -> dict:
    url = f"{HISTORY_URL}?{urllib.parse.urlencode(params)}"
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"{creds.app_id}:{creds.access_token}",
            "User-Agent": USER_AGENT,
        },
    )
    for attempt in range(4):
        try:
            return json.load(urllib.request.urlopen(request, timeout=30))
        except urllib.error.HTTPError as error:
            if error.code == 429 and attempt < 3:
                time.sleep(2**attempt * 5)
                continue
            return _error_body(error)
    return {"s": "error", "message": "rate limited"}


def _candles(symbol: str, resolution: str, start: date, end: date, max_days: int, creds) -> list:
    """Raw [epoch, open, high, low, close, volume] rows, fetched in <= max_days chunks."""
    rows: list = []
    chunk_start = start
    while chunk_start <= end:
        chunk_end = min(chunk_start + timedelta(days=max_days - 1), end)
        body = _get(
            {
                "symbol": symbol,
                "resolution": resolution,
                "date_format": 1,
                "range_from": chunk_start.isoformat(),
                "range_to": chunk_end.isoformat(),
                "cont_flag": 1,
            },
            creds,
        )
        status = body.get("s")
        if status not in ("ok", "no_data"):
            message = str(body.get("message") or body)
            if any(word in message.lower() for word in ("token", "auth", "unauthor")):
                raise FyersCredentialsError(f"Fyers rejected the token: {message}")
            raise RuntimeError(f"{symbol} {chunk_start}..{chunk_end}: {message}")
        rows += body.get("candles") or []
        chunk_start = chunk_end + timedelta(days=1)
        time.sleep(PAUSE_S)
    return rows


def _ist(epoch: int) -> pd.Timestamp:
    return pd.Timestamp(epoch, unit="s", tz="UTC").tz_convert("Asia/Kolkata")


def daily_candles(symbol: str, start: date, end: date, creds: Credentials) -> pd.DataFrame:
    """Daily open and close indexed by IST trading date."""
    by_day = {
        _ist(epoch).date(): (float(open_), float(close))
        for epoch, open_, _high, _low, close, _volume in _candles(
            symbol, "D", start, end, DAILY_MAX_DAYS, creds
        )
    }
    frame = pd.DataFrame.from_dict(by_day, orient="index", columns=["open", "close"]).sort_index()
    frame.index = pd.to_datetime(frame.index)
    return frame


def daily_closes(symbol: str, start: date, end: date, creds: Credentials) -> pd.Series:
    """Daily closes indexed by IST trading date, fetched in <=366-day chunks."""
    return daily_candles(symbol, start, end, creds)["close"]


def daily_ohlcv(symbol: str, start: date, end: date, creds: Credentials) -> pd.DataFrame:
    """Daily open/high/low/close/volume indexed by IST trading date. Unlike
    `daily_candles` (open+close only), this keeps the full bar — used by
    `stocks/fyers_topup.py`'s Total Market top-up, which writes real `bars_1d_stock`
    rows (not a flat synthetic bar) when NSE's own bhavcopy is unreachable."""
    by_day = {
        _ist(epoch).date(): (float(open_), float(high), float(low), float(close), float(volume))
        for epoch, open_, high, low, close, volume in _candles(
            symbol, "D", start, end, DAILY_MAX_DAYS, creds
        )
    }
    frame = pd.DataFrame.from_dict(
        by_day, orient="index", columns=["open", "high", "low", "close", "volume"]
    ).sort_index()
    frame.index = pd.to_datetime(frame.index)
    return frame


HOLDINGS_URL = "https://api-t1.fyers.in/api/v3/holdings"
#: NSE series suffixes on a Fyers equity symbol ("NSE:SBIN-EQ").
_SERIES = {"EQ", "BE", "BZ", "BL", "SM", "ST", "IL", "GB", "GS"}


def nse_symbol(fyers_symbol: str) -> str:
    """'NSE:SBIN-EQ' -> 'SBIN'; 'NSE:M&M-EQ' -> 'M&M'. Anything else is returned without the
    exchange prefix."""
    name = fyers_symbol.split(":", 1)[-1]
    base, _, series = name.rpartition("-")
    return base if base and series in _SERIES else name


def holdings(creds: Credentials) -> list[dict]:
    """The account's holdings, read-only (BL-051 Phase 3): one dict per symbol with `symbol`
    (NSE, no prefix or series), `quantity` (all lots, T1 included) and `avg_price`. Never places
    or changes anything. Raises RuntimeError when Fyers refuses (an expired token, say)."""
    request = urllib.request.Request(
        HOLDINGS_URL,
        headers={
            "Authorization": f"{creds.app_id}:{creds.access_token}",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        body = json.load(urllib.request.urlopen(request, timeout=15))
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Fyers holdings: HTTP {error.code} {_error_body(error)}") from error
    if body.get("s") != "ok":
        raise RuntimeError(f"Fyers holdings: {body.get('message') or body}")
    merged: dict[str, dict] = {}
    for item in body.get("holdings") or []:
        symbol = nse_symbol(str(item.get("symbol", "")))
        quantity = float(item.get("quantity") or 0)
        if not symbol or quantity <= 0:
            continue
        cost = item.get("costPrice")
        row = merged.setdefault(symbol, {"symbol": symbol, "quantity": 0.0, "cost": 0.0})
        row["quantity"] += quantity
        row["cost"] += quantity * float(cost) if cost else 0.0
    return [
        {
            "symbol": r["symbol"],
            "quantity": r["quantity"],
            "avg_price": (r["cost"] / r["quantity"]) if r["cost"] else None,
        }
        for r in merged.values()
    ]


QUOTES_URL = "https://api-t1.fyers.in/data/quotes"


def quotes(symbols: list[str], creds: Credentials) -> dict[str, float]:
    """Last traded price per symbol (live during market hours), 50 symbols per request."""
    prices: dict[str, float] = {}
    for i in range(0, len(symbols), 50):
        batch = symbols[i : i + 50]
        request = urllib.request.Request(
            f"{QUOTES_URL}?{urllib.parse.urlencode({'symbols': ','.join(batch)})}",
            headers={
                "Authorization": f"{creds.app_id}:{creds.access_token}",
                "User-Agent": USER_AGENT,
            },
        )
        try:
            body = json.load(urllib.request.urlopen(request, timeout=30))
        except urllib.error.HTTPError as error:
            body = _error_body(error)
        if body.get("s") != "ok":
            message = str(body.get("message") or body.get("s"))
            if any(word in message.lower() for word in ("token", "auth", "unauthor")):
                raise FyersCredentialsError(f"Fyers rejected the token: {message}")
            raise RuntimeError(f"Fyers quotes failed: {message}")
        for item in body.get("d") or []:
            ltp = (item.get("v") or {}).get("lp")
            if item.get("s") == "ok" and ltp:
                prices[item["n"]] = float(ltp)
        time.sleep(PAUSE_S)
    return prices


INTRADAY_MAX_DAYS = 100  # Fyers caps minute-resolution requests at 100 days


def price_at(
    symbol: str, start: date, end: date, creds: Credentials, at: str = "10:00"
) -> pd.Series:
    """The traded price at `at` IST on each day: the close of the 15-minute candle that ends
    then (the 09:45 candle for 10:00). Days without that candle are left out."""
    hour, minute = map(int, at.split(":"))
    candle_start = (hour * 60 + minute - 15) % (24 * 60)
    prices = {}
    for epoch, _open, _high, _low, close, _volume in _candles(
        symbol, "15", start, end, INTRADAY_MAX_DAYS, creds
    ):
        stamp = _ist(epoch)
        if stamp.hour * 60 + stamp.minute == candle_start:
            prices[stamp.date()] = float(close)
    series = pd.Series(prices, dtype=float).sort_index()
    series.index = pd.to_datetime(series.index)
    return series
