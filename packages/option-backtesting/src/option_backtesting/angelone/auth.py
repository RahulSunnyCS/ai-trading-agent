"""
Angel One SmartAPI credentials and login. Never prints or logs a secret.

Env (repo-root .env, the one every tool reads): ANGELONE_API_KEY (the SmartAPI app key),
ANGELONE_CLIENT_CODE, ANGELONE_MPIN (the 4-digit PIN, sent as the login password) and
ANGELONE_TOTP_SECRET (the base32 seed). The login is one REST call, no browser; a rejected
login is never retried, since each wrong attempt counts toward a lockout.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import struct
import time
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

from ..fyers.auth import FyersCredentialsError, load_dotenv

BASE_URL = "https://apiconnect.angelone.in"
LOGIN_PATH = "/rest/auth/angelbroking/user/v1/loginByPassword"
REQUIRED = ("ANGELONE_API_KEY", "ANGELONE_CLIENT_CODE", "ANGELONE_MPIN", "ANGELONE_TOTP_SECRET")

Post = Callable[[str, dict, dict[str, str]], tuple[int, dict]]


class AngelCredentialsError(FyersCredentialsError):
    """A login or token problem. Subclasses Fyers' so the shared collector stops the run on it
    instead of logging the same error for every contract."""


class AngelNetworkError(AngelCredentialsError):
    """Angel One could not be reached (no route, timeout). Still stops the run, but is reported
    as a connection problem, not as a login to fix."""


class AngelUnavailableError(AngelNetworkError):
    """Angel One answered with a server error (HTTP 5xx): reached, but not serving logins."""


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


def load_credentials(env: Mapping[str, str] | None = None) -> AngelCredentials:
    if env is None:
        load_dotenv()
        env = os.environ
    missing = [k for k in REQUIRED if not env.get(k, "").strip()]
    if missing:
        raise AngelCredentialsError(f"Angel One is not configured: set {', '.join(missing)}")
    return AngelCredentials(
        client_code=env["ANGELONE_CLIENT_CODE"].strip(),
        api_key=env["ANGELONE_API_KEY"].strip(),
        pin=env["ANGELONE_MPIN"].strip(),
        totp_secret=env["ANGELONE_TOTP_SECRET"].strip(),
        public_ip=env.get("ANGELONE_PUBLIC_IP", "").strip() or "0.0.0.0",
    )


def totp_now(secret: str, at: float | None = None) -> str:
    """RFC 6238, SHA-1, 30 s, 6 digits (the same code Google Authenticator shows)."""
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


def _answer(request: urllib.request.Request) -> tuple[int, dict]:
    """Send one request to SmartAPI: (HTTP status, JSON body); status 0 = not reached."""
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            raw, status = response.read(), response.status
    except urllib.error.HTTPError as error:
        raw, status = error.read(), error.code
    except (urllib.error.URLError, TimeoutError) as error:
        return 0, {"status": False, "message": f"network: {error}"}
    try:
        parsed = json.loads(raw)
    except ValueError:
        return status, {"status": False, "message": f"HTTP {status}, not JSON"}
    return status, parsed if isinstance(parsed, dict) else {"status": False, "message": "bad body"}


def post_json(path: str, body: dict, headers: dict[str, str]) -> tuple[int, dict]:
    return _answer(
        urllib.request.Request(
            BASE_URL + path, data=json.dumps(body).encode(), headers=headers, method="POST"
        )
    )


Get = Callable[[str, dict[str, str]], tuple[int, dict]]


def get_json(path: str, headers: dict[str, str]) -> tuple[int, dict]:
    """A GET to SmartAPI (read-only calls such as `getRMS`), answered like `post_json`."""
    return _answer(urllib.request.Request(BASE_URL + path, headers=headers, method="GET"))


def login(
    creds: AngelCredentials,
    post: Post = post_json,
    now: Callable[[], float] = time.time,
    sleep: Callable[[float], None] = time.sleep,
) -> Session:
    """One login attempt. Waits for a fresh TOTP window rather than send a code about to expire."""
    for attempt in range(3):
        left = 30 - int(now()) % 30
        if left < 4:
            sleep(left + 0.5)
        status, body = post(
            LOGIN_PATH,
            {
                "clientcode": creds.client_code,
                "password": creds.pin,
                "totp": totp_now(creds.totp_secret, now()),
            },
            request_headers(creds.api_key, creds.public_ip),
        )
        # Status 0 = the request never reached Angel One: safe to retry, no lockout count.
        # Anything that got an answer (even a 5xx) is never re-sent.
        if status != 0 or attempt == 2:
            break
        sleep(2 * (attempt + 1))
    jwt = (body.get("data") or {}).get("jwtToken") if body.get("status") else None
    if not jwt:
        detail = _scrub(str(body.get("message") or f"HTTP {status}"), creds)
        code = body.get("errorcode") or ""
        if status == 0:
            raise AngelNetworkError(f"Angel One could not be reached: {detail}")
        if status >= 500:
            raise AngelUnavailableError(f"Angel One is unavailable (HTTP {status}): {detail}")
        raise AngelCredentialsError(f"Angel One login failed: {code} {detail}".strip())
    return Session(jwt=jwt, api_key=creds.api_key, public_ip=creds.public_ip)


def mask_client(code: str | None) -> str | None:
    """`R123456` -> `R1•••56`: enough to tell accounts apart, not the whole code."""
    code = (code or "").strip()
    if not code:
        return None
    if len(code) <= 4:
        return code[0] + "•••"
    return f"{code[:2]}•••{code[-2:]}"


def redact(text: str, creds: AngelCredentials) -> str:
    """The PIN, TOTP seed and API key replaced, longest first (a short PIN that occurs inside the
    key must not leave part of the key behind), and the client code masked. No truncation."""
    secrets = (creds.pin, creds.totp_secret, creds.api_key)
    for secret in sorted((s for s in secrets if s and len(s) >= 4), key=len, reverse=True):
        text = text.replace(secret, "<redacted>")
    if len(creds.client_code) >= 4:
        text = text.replace(creds.client_code, mask_client(creds.client_code) or "")
    return text


def _scrub(text: str, creds: AngelCredentials) -> str:
    """`redact`, then cut to length (after masking, so a cut never leaves a code half-shown)."""
    return redact(text, creds)[:160]
