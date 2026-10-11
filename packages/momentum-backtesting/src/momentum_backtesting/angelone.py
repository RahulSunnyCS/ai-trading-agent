"""Angel One (SmartAPI) as Momentum's backup price source (BL-079 Phase 4).

Source order, decided by the owner: **Fyers when its token is valid -> Angel One -> the public
sources** (Yahoo, niftyindices, AMFI), which every caller already has. `resolve_prices()` makes
the first choice; an instrument Angel One cannot map is priced from the public source exactly as
it is with no broker token at all (`fyers.serves` is the test, at each call site).

Angel One stands in where Fyers credentials go: `AngelSource` is passed as the `creds` argument
and `fyers.daily_candles / daily_ohlcv / daily_closes / quotes / price_at` hand it the call (the
hook is `fyers.substitute`), so no caller changes shape. Prices are the same exchange prices, in
the same `open/close(/high/low/volume)` frames, keyed on the Fyers ticker the universe already
uses ("NSE:NIFTYBANK-INDEX", "NSE:GOLDBEES-EQ"); only the transport differs.

Never prints or logs a secret. Env (repo-root .env): ANGELONE_API_KEY, ANGELONE_CLIENT_CODE,
ANGELONE_MPIN (the 4-digit PIN, sent as `password`), ANGELONE_TOTP_SECRET (base32). The login is
one REST call; it is made at most once per process while the session lives, and a rejected login
is never retried (each wrong attempt counts toward an account lockout).

Not served, falling through to the public path: anything missing from Angel One's scrip master
(Nifty Capital Markets, Chemicals, India Defence and Healthcare indices today), and anything that
is not an NSE equity/ETF or an NSE/BSE index (Nasdaq 100, Hang Seng, silver and the AMFI NAV are
priced by their own public sources already and never reach this module).

Same package-local rule as the rest of Momentum: this does not import
`packages/option-backtesting`'s Angel One client; the two are separate copies by design.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import re
import struct
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

import pandas as pd

from . import fyers
from .config import DATA_DIR

log = logging.getLogger(__name__)

BASE_URL = "https://apiconnect.angelone.in"
LOGIN_PATH = "/rest/auth/angelbroking/user/v1/loginByPassword"
CANDLE_PATH = "/rest/secure/angelbroking/historical/v1/getCandleData"
QUOTE_PATH = "/rest/secure/angelbroking/market/v1/quote"
MASTER_URL = "https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json"
MASTER_CACHE = DATA_DIR / ".angel_scrip_master.json"
MASTER_MAX_AGE_S = 24 * 3600

REQUIRED = ("ANGELONE_API_KEY", "ANGELONE_CLIENT_CODE", "ANGELONE_MPIN", "ANGELONE_TOTP_SECRET")
IST = timezone(timedelta(hours=5, minutes=30))

#: SmartAPI allows about 3 requests a second; one call every 0.4 s stays under it.
PAUSE_S = 0.4
DAILY_CHUNK_DAYS = 1000  # documented limit for ONE_DAY is ~2000 days a call
INTRADAY_CHUNK_DAYS = 180  # FIFTEEN_MINUTE is documented to 200 days
QUOTE_BATCH = 50  # tokens per market-quote request
#: A session is reused for this long; the JWT itself lasts about a day.
SESSION_MAX_AGE_S = 10 * 3600
_AUTH_CODES = {"AG8001", "AG8002", "AG8003", "AB8051"}  # invalid / expired / missing token
_RATE_WORDS = ("exceeding access rate", "rate limit", "too many")

Post = Callable[[str, dict, dict[str, str]], tuple[int, dict]]


class AngelError(RuntimeError):
    """A data call failed. Deliberately not a FyersCredentialsError: callers treat that as
    "stop the run", and Angel One is only a backup - one bad call must not cost the run."""


class AngelUnmapped(AngelError):
    """The symbol has no Angel One instrument; the caller uses the public source instead."""


class AngelAuthError(AngelError):
    """Angel One rejected the session token mid-run."""


# --- login --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class AngelCredentials:
    client_code: str
    api_key: str = field(repr=False)
    pin: str = field(repr=False)
    totp_secret: str = field(repr=False)
    public_ip: str = "0.0.0.0"


@dataclass(frozen=True)
class Session:
    jwt: str = field(repr=False)
    api_key: str = field(repr=False)
    public_ip: str = "0.0.0.0"


def load_credentials(env: Mapping[str, str] | None = None) -> AngelCredentials | None:
    """The credentials from the environment, or None when Angel One is not configured. Like
    `fyers.resolve_credentials` it reads `os.environ` as it is: the entry points (the `mbt` CLI
    callback, the API routes, the scheduler) have loaded the repo .env already."""
    if env is None:
        env = os.environ
    if any(not env.get(key, "").strip() for key in REQUIRED):
        return None
    return AngelCredentials(
        client_code=env["ANGELONE_CLIENT_CODE"].strip(),
        api_key=env["ANGELONE_API_KEY"].strip(),
        pin=env["ANGELONE_MPIN"].strip(),
        totp_secret=env["ANGELONE_TOTP_SECRET"].strip(),
        public_ip=env.get("ANGELONE_PUBLIC_IP", "").strip() or "0.0.0.0",
    )


def totp_now(secret: str, at: float | None = None) -> str:
    """RFC 6238, SHA-1, 30 s, 6 digits (the code an authenticator app shows)."""
    cleaned = secret.replace(" ", "").replace("-", "").upper()
    key = base64.b32decode(cleaned + "=" * (-len(cleaned) % 8))
    counter = struct.pack(">Q", int((time.time() if at is None else at) // 30))
    digest = hmac.new(key, counter, hashlib.sha1).digest()
    offset = digest[-1] & 15
    return f"{(struct.unpack('>I', digest[offset : offset + 4])[0] & 0x7FFFFFFF) % 1_000_000:06d}"


def request_headers(api_key: str, public_ip: str, jwt: str | None = None) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-UserType": "USER",
        "X-SourceID": "WEB",
        "X-ClientLocalIP": "127.0.0.1",
        "X-ClientPublicIP": public_ip,
        "X-MACAddress": "00:00:00:00:00:00",
        "X-PrivateKey": api_key,
    }
    if jwt:
        headers["Authorization"] = f"Bearer {jwt}"
    return headers


def _wait(seconds: float) -> None:
    """Every real sleep in this module goes through here, so a test can make them instant."""
    time.sleep(seconds)


def _http_post(path: str, body: dict, headers: dict[str, str]) -> tuple[int, dict]:
    """The real transport. Looked up by name at call time so a test can replace it."""
    request = urllib.request.Request(
        BASE_URL + path, data=json.dumps(body).encode(), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw, status = response.read(), response.status
    except urllib.error.HTTPError as error:
        raw, status = error.read(), error.code
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return 0, {"status": False, "message": f"network: {type(error).__name__}"}
    try:
        parsed = json.loads(raw)
    except ValueError:
        return status, {"status": False, "message": f"HTTP {status}, not JSON"}
    return status, parsed if isinstance(parsed, dict) else {"status": False, "message": "bad body"}


def _scrub(text: str, creds: AngelCredentials) -> str:
    for secret in (creds.pin, creds.totp_secret, creds.api_key):
        if secret and len(secret) >= 4:
            text = text.replace(secret, "<redacted>")
    return text[:160]


def login(
    creds: AngelCredentials,
    post: Post | None = None,
    now: Callable[[], float] = time.time,
    sleep: Callable[[float], None] | None = None,
) -> Session:
    """One login attempt. Waits for a fresh TOTP window rather than send a code about to expire.
    Raises AngelError on a rejection (the message is scrubbed of every secret)."""
    left = 30 - int(now()) % 30
    if left < 4:
        (sleep or _wait)(left + 0.5)
    send = post or _http_post
    status, body = send(
        LOGIN_PATH,
        {
            "clientcode": creds.client_code,
            "password": creds.pin,
            "totp": totp_now(creds.totp_secret, now()),
        },
        request_headers(creds.api_key, creds.public_ip),
    )
    jwt = (body.get("data") or {}).get("jwtToken") if body.get("status") else None
    if not jwt:
        detail = _scrub(str(body.get("message") or f"HTTP {status}"), creds)
        code = body.get("errorcode") or ""
        error = AngelError(f"Angel One login failed: {code} {detail}".strip())
        error.network = status == 0  # type: ignore[attr-defined]
        raise error
    return Session(jwt=jwt, api_key=creds.api_key, public_ip=creds.public_ip)


# --- symbols ------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Instrument:
    exchange: str  # NSE | BSE
    token: str
    symbol: str  # the master's own symbol: "SBIN-EQ", "Nifty Bank"
    kind: str  # "equity" | "index"


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9]", "", text.lower())


def compact_master(rows: Iterable[dict]) -> list[dict]:
    """Keep only what Momentum can use (NSE/BSE indices, NSE equities): ~10k of ~150k rows."""
    keep = []
    for row in rows:
        seg, kind = row.get("exch_seg"), row.get("instrumenttype") or ""
        if seg in ("NSE", "BSE") and kind == "AMXIDX" or seg == "NSE" and kind == "":
            keep.append(
                {
                    k: row.get(k, "")
                    for k in ("token", "symbol", "name", "exch_seg", "instrumenttype")
                }
            )
    return keep


def download_master() -> list[dict]:
    request = urllib.request.Request(MASTER_URL, headers={"User-Agent": fyers.USER_AGENT})
    with urllib.request.urlopen(request, timeout=180) as response:
        return json.load(response)


def load_master(
    cache: os.PathLike | str | None = None,
    fetch: Callable[[], list[dict]] | None = None,
    max_age_s: float = MASTER_MAX_AGE_S,
) -> list[dict]:
    """The compacted scrip master, from a day-old on-disk copy or a fresh public download."""
    from pathlib import Path

    path = Path(cache) if cache is not None else MASTER_CACHE
    try:
        if path.exists() and time.time() - path.stat().st_mtime < max_age_s:
            rows = json.loads(path.read_text())
            if rows:
                return rows
    except (OSError, ValueError):
        pass
    rows = compact_master((fetch or download_master)())
    if not rows:
        raise AngelError("Angel One's scrip master came back empty")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(rows))
    except OSError:
        pass  # a cache that cannot be written only costs the next process a download
    return rows


class SymbolMap:
    """Fyers ticker -> Angel One instrument. Indices match on the name with punctuation and case
    removed ("NIFTYIT-INDEX" -> "Nifty IT", "NIFTYNXT50-INDEX" -> name "NIFTYNXT50"); a name two
    different rows share is dropped rather than guessed. Equities match the series symbol
    exactly ("NSE:SBIN-EQ" -> "SBIN-EQ")."""

    def __init__(self, rows: Iterable[dict]) -> None:
        self._equity: dict[str, Instrument] = {}
        self._index: dict[tuple[str, str], Instrument] = {}
        ambiguous: set[tuple[str, str]] = set()
        for row in rows:
            seg, kind = row.get("exch_seg"), row.get("instrumenttype") or ""
            token, symbol = str(row.get("token", "")), str(row.get("symbol", ""))
            if not token or not symbol:
                continue
            if kind == "AMXIDX" and seg in ("NSE", "BSE"):
                inst = Instrument(seg, token, symbol, "index")
                for text in (symbol, str(row.get("name", ""))):
                    key = (seg, _norm(text))
                    if not key[1]:
                        continue
                    if key in self._index and self._index[key].token != token:
                        ambiguous.add(key)
                    self._index.setdefault(key, inst)
            elif seg == "NSE" and kind == "":
                self._equity[symbol] = Instrument("NSE", token, symbol, "equity")
        for key in ambiguous:
            del self._index[key]

    def lookup(self, fyers_symbol: str) -> Instrument | None:
        exchange, _, rest = fyers_symbol.partition(":")
        exchange = exchange.upper()
        if not rest or exchange not in ("NSE", "BSE"):
            return None
        if rest.upper().endswith("-INDEX"):
            return self._index.get((exchange, _norm(rest[: -len("-INDEX")])))
        if exchange == "NSE":
            return self._equity.get(rest)
        return None


# --- the source ---------------------------------------------------------------------------------


def _ist_stamp(text: str) -> pd.Timestamp:
    stamp = datetime.fromisoformat(str(text))
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=IST)
    return pd.Timestamp(stamp.astimezone(IST))


class AngelSource:
    """Stands in for Fyers `Credentials` wherever prices are fetched (see `fyers.substitute`).

    `source` is what logs and the Telegram line call it; `why_not_fyers` is why Fyers was not
    used today. Safe to share between threads: calls are serialised and paced.
    """

    substitute_for_fyers = True
    source = "Angel One"

    def __init__(
        self,
        session: Session,
        *,
        post: Post | None = None,
        pause_s: float = PAUSE_S,
        master_loader: Callable[[], list[dict]] | None = None,
        why_not_fyers: str = "no valid token",
        sleep: Callable[[float], None] | None = None,
    ) -> None:
        self._session = session
        self._post = post
        self._pause_s = pause_s
        self._master_loader = master_loader
        self._sleep = sleep or (lambda seconds: _wait(seconds))
        self._last_call = 0.0
        self._lock = threading.Lock()
        self._symbols: SymbolMap | None = None
        self._master_failed = False
        self.dead = False  # the session was rejected mid-run: serve nothing further
        self.why_not_fyers = why_not_fyers
        self.calls = 0

    # -- mapping ----------------------------------------------------------------------------
    def _map(self) -> SymbolMap | None:
        if self._symbols is None and not self._master_failed:
            try:
                rows = (self._master_loader or load_master)()
                self._symbols = SymbolMap(rows)
            except Exception as error:  # noqa: BLE001 - a backup source must never raise here
                self._master_failed = True
                log.warning("Angel One scrip master unavailable: %s", str(error)[:160])
        return self._symbols

    def instrument(self, symbol: str) -> Instrument | None:
        mapping = self._map()
        return mapping.lookup(symbol) if mapping is not None else None

    def can_serve(self, symbol: str) -> bool:
        return not self.dead and self.instrument(symbol) is not None

    # -- HTTP -------------------------------------------------------------------------------
    def _call(self, path: str, body: dict) -> dict:
        headers = request_headers(self._session.api_key, self._session.public_ip, self._session.jwt)
        with self._lock:
            for attempt in range(5):
                wait = self._last_call + self._pause_s - time.monotonic()
                if wait > 0:
                    self._sleep(wait)
                self._last_call = time.monotonic()
                self.calls += 1
                status, payload = (self._post or _http_post)(path, body, headers)
                message = str(payload.get("message") or "").lower()
                limited = status == 429 or any(word in message for word in _RATE_WORDS)
                if (limited or status == 0) and attempt < 4:
                    self._sleep(2**attempt)
                    continue
                return payload
        return {"status": False, "message": "rate limited"}

    def _check(self, payload: dict, what: str) -> None:
        if payload.get("status"):
            return
        message = str(payload.get("message") or "rejected")
        code = str(payload.get("errorcode") or "")
        if code in _AUTH_CODES or "invalid token" in message.lower():
            self.dead = True
            _forget(self)
            raise AngelAuthError(f"Angel One rejected the session: {code} {message}"[:200])
        raise AngelError(f"Angel One {what}: {code} {message}"[:200])

    # -- data -------------------------------------------------------------------------------
    def _candles(
        self, symbol: str, interval: str, start: date, end: date, chunk_days: int, open_at: str
    ) -> list:
        """Raw [iso_time, open, high, low, close, volume] rows in <= chunk_days calls."""
        target = self.instrument(symbol)
        if target is None or self.dead:
            raise AngelUnmapped(f"{symbol}: no Angel One instrument")
        rows: list = []
        chunk_start = start
        while chunk_start <= end:
            chunk_end = min(chunk_start + timedelta(days=chunk_days - 1), end)
            payload = self._call(
                CANDLE_PATH,
                {
                    "exchange": target.exchange,
                    "symboltoken": target.token,
                    "interval": interval,
                    "fromdate": f"{chunk_start:%Y-%m-%d} {open_at}",
                    "todate": f"{chunk_end:%Y-%m-%d} 15:30",
                },
            )
            self._check(payload, f"{symbol} {chunk_start}..{chunk_end}")
            rows += [r for r in payload.get("data") or [] if isinstance(r, list) and len(r) >= 6]
            chunk_start = chunk_end + timedelta(days=1)
        return rows

    def daily_candles(self, symbol: str, start: date, end: date) -> pd.DataFrame:
        """Daily open and close indexed by IST trading date (the `fyers.daily_candles` shape)."""
        by_day = {}
        for row in self._candles(symbol, "ONE_DAY", start, end, DAILY_CHUNK_DAYS, "00:00"):
            by_day[_ist_stamp(row[0]).date()] = (float(row[1]), float(row[4]))
        frame = pd.DataFrame.from_dict(
            by_day, orient="index", columns=["open", "close"], dtype=float
        ).sort_index()
        frame.index = pd.to_datetime(frame.index)
        return frame

    def daily_ohlcv(self, symbol: str, start: date, end: date) -> pd.DataFrame:
        by_day = {}
        for row in self._candles(symbol, "ONE_DAY", start, end, DAILY_CHUNK_DAYS, "00:00"):
            by_day[_ist_stamp(row[0]).date()] = tuple(float(v) for v in row[1:6])
        frame = pd.DataFrame.from_dict(
            by_day, orient="index", columns=["open", "high", "low", "close", "volume"], dtype=float
        ).sort_index()
        frame.index = pd.to_datetime(frame.index)
        return frame

    def price_at(self, symbol: str, start: date, end: date, at: str = "10:00") -> pd.Series:
        """The `fyers.price_at` shape: the close of the 15-minute candle that ends at `at`."""
        hour, minute = map(int, at.split(":"))
        candle_start = (hour * 60 + minute - 15) % (24 * 60)
        prices = {}
        for row in self._candles(
            symbol, "FIFTEEN_MINUTE", start, end, INTRADAY_CHUNK_DAYS, "09:15"
        ):
            stamp = _ist_stamp(row[0])
            if stamp.hour * 60 + stamp.minute == candle_start:
                prices[stamp.date()] = float(row[4])
        series = pd.Series(prices, dtype=float).sort_index()
        series.index = pd.to_datetime(series.index)
        return series

    def quotes(self, symbols: list[str]) -> dict[str, float]:
        """Last traded price per symbol it can map (the `fyers.quotes` shape); symbols it cannot
        map are simply absent, like a Fyers symbol with no quote. Raises AngelError when Angel One
        refuses the request."""
        wanted: dict[tuple[str, str], str] = {}
        for symbol in symbols:
            target = self.instrument(symbol)
            if target is not None and not self.dead:
                wanted[(target.exchange, target.token)] = symbol
        by_exchange: dict[str, list[str]] = {}
        for exchange, token in wanted:
            by_exchange.setdefault(exchange, []).append(token)
        prices: dict[str, float] = {}
        for exchange, tokens in by_exchange.items():
            for i in range(0, len(tokens), QUOTE_BATCH):
                payload = self._call(
                    QUOTE_PATH,
                    {"mode": "LTP", "exchangeTokens": {exchange: tokens[i : i + QUOTE_BATCH]}},
                )
                self._check(payload, "quotes")
                for item in (payload.get("data") or {}).get("fetched") or []:
                    key = (str(item.get("exchange") or exchange), str(item.get("symbolToken")))
                    ltp = item.get("ltp")
                    if ltp and key in wanted:
                        prices[wanted[key]] = float(ltp)
        return prices


# --- one shared source per process --------------------------------------------------------------

_state_lock = threading.Lock()
_source: AngelSource | None = None
_session_at = 0.0
_next_login_at = 0.0  # monotonic: no login attempt before this


def _forget(source: AngelSource) -> None:
    """Drop a rejected session so the next request logs in afresh (never inside this one)."""
    global _source
    with _state_lock:
        if _source is source:
            _source = None


def reset() -> None:
    """Forget the cached session and any login back-off (tests)."""
    global _source, _session_at, _next_login_at
    with _state_lock:
        _source, _session_at, _next_login_at = None, 0.0, 0.0


def get_source(
    env: Mapping[str, str] | None = None,
    *,
    post: Post | None = None,
    master_loader: Callable[[], list[dict]] | None = None,
    pause_s: float = PAUSE_S,
) -> AngelSource | None:
    """The shared, logged-in Angel One source, or None when it is not configured or the login
    failed (logged, never raised, never retried inside the back-off). One login serves the whole
    process for SESSION_MAX_AGE_S; a rejected login is not attempted again for six hours (a
    network failure, for five minutes)."""
    global _source, _session_at, _next_login_at
    with _state_lock:
        now = time.monotonic()
        if _source is not None and not _source.dead and now - _session_at < SESSION_MAX_AGE_S:
            return _source
        creds = load_credentials(env)
        if creds is None:
            return None
        if now < _next_login_at:
            return None
        _next_login_at = now + 60  # whatever happens, never twice inside a minute
        try:
            session = login(creds, post)
        except AngelError as error:
            _next_login_at = now + (300 if getattr(error, "network", False) else 6 * 3600)
            log.warning("%s", error)
            return None
        except Exception as error:  # noqa: BLE001 - a malformed TOTP secret etc.
            _next_login_at = now + 6 * 3600
            log.warning("Angel One login not attempted: %s", type(error).__name__)
            return None
        _source = AngelSource(session, post=post, master_loader=master_loader, pause_s=pause_s)
        _session_at = now
        return _source


def _fyers_token_rejected(creds: fyers.Credentials) -> bool:
    """Fyers has explicitly refused the token (a network failure is not a refusal)."""
    return fyers.probe_token(creds) == "rejected"


def resolve_prices(**kwargs) -> fyers.Credentials | AngelSource:
    """Fyers -> Angel One. Returns Fyers credentials when a valid token exists (and Fyers does
    not refuse it), else the Angel One source; raises the Fyers credentials error when neither
    is usable, so a caller keeps its existing "no token" handling and message. `kwargs` go to
    `fyers.resolve_credentials` unchanged (`prefer_dashboard=`)."""
    try:
        creds = fyers.resolve_credentials(**kwargs)
    except fyers.FyersCredentialsError:
        source = get_source()
        if source is None:
            raise
        source.why_not_fyers = "no valid token"
        return source
    if isinstance(creds, fyers.Credentials) and _fyers_token_rejected(creds):
        source = get_source()
        if source is not None:
            source.why_not_fyers = "token rejected"
            return source
    return creds
