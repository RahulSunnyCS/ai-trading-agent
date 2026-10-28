"""Kite's unattended login (owner, 2026-10-28): Fridays and trading Mondays, inside the 08:02
morning broker login (`packages/broker-login/src/local-login.ts` runs `mbt kite auto-login`), so
its result is in the same Telegram report. Off until `KITE_AUTO_LOGIN=on`.

Zerodha's stated position is that automating the Kite login is not allowed
(https://kite.trade/forum/discussion/comment/19966/). The owner chose to do it knowing that; BL-142
records the decision. So this logs in exactly as a person would, on Kite's own login page, and
nothing more: no undocumented endpoints, nothing that hides that a browser is scripted, and it
stops at a captcha or any check it does not recognise instead of trying to pass it.

Flow: Kite Connect's login URL for this app (`kite.login_url`) -> user ID and password -> the
external TOTP code -> Kite redirects to the app's registered redirect URL with `request_token`.
That redirect is intercepted, never loaded, so the URL can be the hosted dashboard's. The token is
exchanged and stored exactly as a manual login does (`finish_login`, shared with the API callback).

Safety: a refused user ID or password is never retried, and it holds every later run until one of
KITE_USER_ID / KITE_PASSWORD / KITE_TOTP_SECRET changes in `.env` (a lockout costs more than a
missed login). A refused TOTP code is retried once, with the next 30-second window's code.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import time
import urllib.parse
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

from . import kite
from .angelone import totp_now

SWITCH = "KITE_AUTO_LOGIN"
CREDENTIAL_KEYS = ("KITE_USER_ID", "KITE_PASSWORD", "KITE_TOTP_SECRET")
HOLD_FILE = kite.TOKEN_CACHE.parent / ".kite_login_hold.json"
LOG_DIR = Path.home() / "Library" / "Logs" / "ai-trading-agent" / "kite-login"

# Kite's own messages for a refused user ID or password, and a locked or blocked account.
REFUSED = re.compile(
    r"invalid\s.*(user|password)|incorrect\s.*password|user\s*id.*(not|invalid)|"
    r"blocked|locked|disabled|suspended",
    re.I,
)
TOTP_REFUSED = re.compile(r"(invalid|incorrect|wrong|expired).*(totp|code|otp)", re.I)
# Anything that asks for a person: stop, never try to pass it.
HUMAN_CHECK = re.compile(r"captcha|verify you are human|are you a robot|security check", re.I)


class KiteLoginError(Exception):
    """kind: 'refused' (user ID / password: hold, never retry), 'totp' (code refused), 'human'
    (a captcha or unknown check: log in by hand), 'other'."""

    def __init__(self, message: str, kind: str = "other"):
        super().__init__(message)
        self.kind = kind


@dataclass
class Outcome:
    """What `local-login.ts` reads (its `BrokerResult`): OK, FAIL or SKIPPED and why."""

    status: str
    detail: str
    name: str = "Kite"


def switched_on(env: os._Environ | dict = os.environ) -> bool:
    return env.get(SWITCH, "").strip().lower() == "on"


def credentials(env: os._Environ | dict = os.environ) -> dict[str, str]:
    values = {key: env.get(key, "").strip() for key in CREDENTIAL_KEYS}
    missing = [key for key, value in values.items() if not value]
    if missing:
        raise KiteLoginError(f"{', '.join(missing)} missing from .env")
    return values


def _digest(creds: dict[str, str]) -> str:
    joined = "\n".join(f"{key}={creds[key]}" for key in CREDENTIAL_KEYS)
    return hashlib.sha256(joined.encode()).hexdigest()


def held(creds: dict[str, str]) -> str | None:
    """Why logins are held (a refusal with these same credentials), or None."""
    try:
        hold = json.loads(HOLD_FILE.read_text())
    except (OSError, ValueError):
        return None
    if hold.get("digest") != _digest(creds):
        return None  # the credentials changed since: try again
    return hold.get("reason") or "refused before"


def hold(creds: dict[str, str], reason: str) -> None:
    HOLD_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(HOLD_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(
            {"digest": _digest(creds), "reason": reason, "at": datetime.now(UTC).isoformat()},
            handle,
        )


def request_token_from(url: str, state: str) -> str | None:
    """The request_token of Kite's redirect back to the app for this login, or None for any other
    URL (another login's state, a failed login)."""
    query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    token = (query.get("request_token") or [""])[0]
    if not token or (query.get("status") or [""])[0] != "success":
        return None
    if (query.get("state") or [""])[0] != state:
        return None
    return token


def classify(message: str) -> str:
    if HUMAN_CHECK.search(message):
        return "human"
    if TOTP_REFUSED.search(message):
        return "totp"
    if REFUSED.search(message):
        return "refused"
    return "other"


def _fresh_code(secret: str) -> str:
    """A code with at least 8 s of its window left, so it is still valid when Kite checks it."""
    left = 30 - time.time() % 30
    if left < 8:
        time.sleep(left + 0.5)
    return totp_now(secret)


def _next_window_code(secret: str) -> str:
    time.sleep(30 - time.time() % 30 + 0.5)
    return totp_now(secret)


def _page_message(page) -> str:
    """Kite's visible error or notice text on the login form ('' when none)."""
    texts = page.eval_on_selector_all(
        ".error, .su-message, .su-alert, [class*='error'], [role='alert']",
        "els => els.filter(e => e.offsetParent !== null).map(e => e.innerText.trim())",
    )
    return " ".join(t for t in texts if t)[:300]


def _stop_on_human_check(page) -> None:
    if any(f.url and "captcha" in f.url.lower() for f in page.frames) or HUMAN_CHECK.search(
        page.locator("body").inner_text(timeout=5_000)
    ):
        raise KiteLoginError("Kite asked for a human check: log in by hand today", "human")


def _screenshot(page) -> str:
    try:
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        path = LOG_DIR / f"{datetime.now():%Y-%m-%d-%H%M%S}.png"
        page.screenshot(path=str(path))
        return str(path)
    except Exception:  # noqa: BLE001 - a diagnostic only
        return ""


def browser_login(creds: dict[str, str], *, headed: bool = False, wait_s: float = 25) -> str:
    """Log in on Kite's page and return the request_token. Raises KiteLoginError."""
    from playwright.sync_api import sync_playwright

    state = secrets.token_urlsafe(16)
    url = kite.login_url(state)
    captured: dict[str, str] = {}

    def on_redirect(route) -> None:
        token = request_token_from(route.request.url, state)
        if token:
            captured["token"] = token
            route.fulfill(status=200, content_type="text/plain", body="ok")
        else:
            route.continue_()

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not headed)
        try:
            context = browser.new_context()
            # Kite's redirect to the app is answered here, never loaded.
            context.route(lambda u: "request_token=" in u, on_redirect)
            page = context.new_page()
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=45_000)
                _stop_on_human_check(page)
                page.locator("input#userid").fill(creds["KITE_USER_ID"], timeout=20_000)
                page.locator("input#password").fill(creds["KITE_PASSWORD"])
                page.locator("button[type=submit]").click()
                _enter_totp(page, creds["KITE_TOTP_SECRET"], captured, wait_s)
            except KiteLoginError as error:
                shot = _screenshot(page)
                raise KiteLoginError(
                    f"{error}{f' (screenshot {shot})' if shot else ''}", error.kind
                ) from None
            except Exception as error:  # noqa: BLE001 - Playwright timeouts and selector misses
                shot = _screenshot(page)
                raise KiteLoginError(
                    f"{type(error).__name__}: {str(error).splitlines()[0][:160]}"
                    f"{f' (screenshot {shot})' if shot else ''}"
                ) from None
        finally:
            browser.close()
    return captured["token"]


def _totp_field(page):
    """The TOTP input once the password form has gone: Kite shows one 6-digit field (numeric,
    or a text input it reuses), and no password field."""
    return page.locator(
        "input[type=number]:visible, input[autocomplete='one-time-code']:visible, "
        "input[maxlength='6']:visible, input[type=text]:visible"
    ).first


def _on_totp_step(page) -> bool:
    return page.locator("input#password:visible").count() == 0 and _totp_field(page).count() > 0


def _wait_for(page, done, captured: dict, wait_s: float) -> None:
    """Poll until `done()` or the redirect was captured; raise on a Kite message or a check."""
    deadline = time.monotonic() + wait_s
    while time.monotonic() < deadline:
        if captured.get("token") or done():
            return
        message = _page_message(page)
        if message:
            kind = classify(message)
            if kind != "other":
                raise KiteLoginError(f"Kite: {message}", kind)
        page.wait_for_timeout(500)
    message = _page_message(page)
    raise KiteLoginError(f"Kite: {message}" if message else "timed out", classify(message))


def _enter_totp(page, secret: str, captured: dict, wait_s: float) -> None:
    _wait_for(page, lambda: _on_totp_step(page), captured, wait_s)
    field = _totp_field(page)
    if captured.get("token"):
        return
    _stop_on_human_check(page)
    for attempt in (1, 2):
        code = _fresh_code(secret) if attempt == 1 else _next_window_code(secret)
        field.fill(code)
        submit = page.locator("button[type=submit]:visible")
        if submit.count():
            submit.first.click()  # Kite usually submits a full code by itself
        try:
            _wait_for(page, lambda: False, captured, wait_s)
        except KiteLoginError as error:
            if error.kind == "totp" and attempt == 1:
                continue
            if "authorize" in page.url.lower() or page.get_by_text("Authorize").count():
                raise KiteLoginError(
                    "Kite asks to authorise the app: log in by hand once from Broker logins"
                ) from None
            raise
        if captured.get("token"):
            return


def finish_login(request_token: str) -> str:
    """Exchange the request_token, keep today's token and, when Kite is the holdings source, read
    the holdings at once. The note says what happened. Shared with the API's /api/kite/callback."""
    from . import holdings_store, holdings_sync, notify
    from .db_read import open_catalog

    creds = kite.exchange_request_token(request_token)
    kite.save_token(creds)
    note = "Kite connected."
    try:
        with open_catalog() as con:
            source = holdings_store.settings(con, holdings_store.owner())["holdings_source"]
        if source == "kite":
            snapshot = holdings_sync.sync("kite")
            note += f" Holdings read: {len(snapshot.get('rows', []))} names."
    except Exception as error:  # noqa: BLE001 - the login worked; the read is best effort
        note += f" Holdings not read: {notify.redact(str(error))}"
    return note


def auto_login(*, headed: bool = False, env: os._Environ | dict = os.environ) -> Outcome:
    """The whole unattended run. Never raises; the outcome says what happened."""
    from . import notify

    if not switched_on(env):
        return Outcome("SKIPPED", f"{SWITCH} is not on")
    try:
        creds = credentials(env)
        for value in creds.values():
            notify.register_secret(value)
        if not kite.configured():
            return Outcome("FAIL", "KITE_API_KEY / KITE_API_SECRET missing from .env")
        cached = kite.cached_credentials()
        if cached is not None:
            try:
                if kite.probe(cached):
                    return Outcome("OK", "already logged in today")
            except RuntimeError:
                pass  # Kite unreachable: the login below says so if it is
        reason = held(creds)
        if reason:
            return Outcome(
                "FAIL",
                f"held: {reason}. Fix KITE_USER_ID / KITE_PASSWORD in .env (that lifts the hold), "
                "or log in by hand",
            )
        try:
            token = browser_login(creds, headed=headed)
        except KiteLoginError as error:
            if error.kind == "refused":
                hold(creds, str(error))
            raise
        return Outcome("OK", finish_login(token))
    except KiteLoginError as error:
        return Outcome("FAIL", notify.redact(str(error)))
    except (kite.KiteCredentialsError, RuntimeError) as error:
        return Outcome("FAIL", notify.redact(str(error)))


def outcome_json(outcome: Outcome) -> str:
    return json.dumps(asdict(outcome))
