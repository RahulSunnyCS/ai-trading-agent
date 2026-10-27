"""Telegram messages, mirroring packages/notify (TypeScript) for a Python caller.

A deliberate copy of packages/momentum-backtesting's notify.py (the two Python
packages share no code — see technical.md's Package Index), same contract as
@trading/notify's `send()`: the Notification shape (source, severity, title,
body), an IST stamp, `parse_mode` never set (index and broker names break
Telegram's Markdown parser and Telegram then silently drops the whole message),
link previews off, and every outbound string redacted against the secrets this
process knows. Never raises — a failed notification must not take down the job
it reports on. Without TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID it prints instead.
"""

from __future__ import annotations

import json
import os
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from .fyers.auth import load_dotenv

SEVERITY_ICON = {"info": "ℹ️", "warn": "⚠️", "error": "❌", "action_required": "🔔"}
IST = ZoneInfo("Asia/Kolkata")
TELEGRAM_LIMIT = 4096

#: Environment variables whose values must never leave the process.
SECRET_ENV = (
    "TELEGRAM_BOT_TOKEN",
    "DATABASE_URL",
    "FYERS_ACCESS_TOKEN",
    "FYERS_APP_SECRET",
    "FYERS_PIN",
    "FYERS_TOTP_SECRET",
    "FYERS_CLIENT_ID",
)


def redact(text: str) -> str:
    secrets = {v for k in SECRET_ENV if len(v := os.environ.get(k, "").strip()) >= 4}
    for secret in sorted(secrets, key=len, reverse=True):
        text = text.replace(secret, "***REDACTED***")
    return text


def prefs_path() -> Path:
    """Same file and override as @trading/notify's prefs.ts (`disabled` and `levels`)."""
    override = os.environ.get("NOTIFY_PREFS_FILE", "").strip()
    if override:
        return Path(override)
    return Path.home() / ".config" / "ai-trading-agent" / "notifications.json"


def disabled_types(path: Path | None = None) -> set[str]:
    """Switched-off types. Fails open: a missing or broken file means everything is on, so a
    bad preferences file can never be what silences a failure alert."""
    path = path or prefs_path()
    try:
        text = path.read_text()
    except OSError:
        return set()
    try:
        listed = json.loads(text).get("disabled")
    except (ValueError, AttributeError):
        print(f"  notification preferences at {path} are not valid JSON; sending everything")
        return set()
    return {t for t in listed if isinstance(t, str)} if isinstance(listed, list) else set()


#: BL-173 (owner, 2026-10-28): a type's level when the preferences file says nothing about it
#: ("all" otherwise). Same table as @trading/notify's DEFAULT_LEVELS (prefs.ts).
DEFAULT_LEVELS = {
    "momentum.preview": "off",
    "momentum.journal": "failures",
    "momentum.live_rules": "failures",
    "options.daily": "failures",
    "scheduler.recovered": "off",
    "quantiply.switch_off": "failures",
}

_FAILURE_ICONS = ("⚠️", "⚠", "❌", "🚨", "💥", "🔴", "⛔")


def looks_like_failure(text: str) -> bool:
    """A failure, read from the text's first icon (the warning icons every sender puts first)."""
    return text.lstrip().startswith(_FAILURE_ICONS)


def file_levels(path: Path | None = None) -> dict[str, str]:
    """The levels the file sets: `levels`, then `disabled` as off. Fails open."""
    path = path or prefs_path()
    out = dict.fromkeys(disabled_types(path), "off")
    try:
        levels = json.loads(path.read_text()).get("levels")
    except (OSError, ValueError, AttributeError):
        return out
    if isinstance(levels, dict):
        out.update({t: v for t, v in levels.items() if v in ("all", "failures", "off")})
    return out


def level_of(kind: str, path: Path | None = None) -> str:
    return file_levels(path).get(kind) or DEFAULT_LEVELS.get(kind, "all")


def is_enabled(
    kind: str | None,
    path: Path | None = None,
    failure: bool | None = None,
    text: str = "",
) -> bool:
    """An untagged message (kind None) is always sent; a `failures` type only its failures."""
    if kind is None:
        return True
    level = level_of(kind, path)
    if level == "off":
        return False
    if level == "failures":
        return looks_like_failure(text) if failure is None else failure
    return True


@dataclass
class Notification:
    source: str
    severity: str  # info | warn | error | action_required
    title: str
    body: str = ""
    # Which switch on the dashboard's Notifications page controls this message (a key of
    # NOTIFICATION_TYPES in packages/notify/src/prefs.ts). None means always sent.
    type: str | None = None
    # True: send title + body exactly as written, without the severity icon and the
    # "source, time" line. For a message whose layout is its own (the rotation's picks and result).
    # Redaction, the preferences switch and truncation still apply.
    plain: bool = False


def render(n: Notification, now: datetime | None = None) -> str:
    if n.plain:
        lines = [part for part in (n.title, n.body) if part]
    else:
        stamp = (now or datetime.now(IST)).astimezone(IST).strftime("%d %b, %H:%M")
        lines = [f"{SEVERITY_ICON[n.severity]} {n.title}", f"{n.source}, {stamp} IST"]
        if n.body:
            lines += ["", n.body]
    text = redact("\n".join(lines))
    if len(text) > TELEGRAM_LIMIT:
        text = text[: TELEGRAM_LIMIT - 20] + "\n… (truncated)"
    return text


def send(n: Notification, *, chat_id: str | None = None) -> tuple[bool, str]:
    """Send (or, without TELEGRAM_* configured, print) the message.
    Returns (delivered, text). An explicit chat_id overrides the default destination."""
    load_dotenv()
    text = render(n)
    failure = looks_like_failure(text) if n.plain else n.severity != "info"
    if not is_enabled(n.type, failure=failure):
        print(f"\n[telegram: '{n.type}' is off or failures-only, message below]\n{text}")
        return False, text
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat = (chat_id if chat_id is not None else os.environ.get("TELEGRAM_CHAT_ID", "")).strip()
    if not (token and chat):
        print(f"\n[telegram not configured, message below]\n{text}")
        return False, text
    body = json.dumps({"chat_id": chat, "text": text, "disable_web_page_preview": True})
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=body.encode(),
        headers={"content-type": "application/json"},
    )
    try:
        urllib.request.urlopen(request, timeout=15).read()
    except Exception as error:  # never let a notification failure break the job
        print(f"  telegram send failed: {redact(str(error))}")
        return False, text
    return True, text
