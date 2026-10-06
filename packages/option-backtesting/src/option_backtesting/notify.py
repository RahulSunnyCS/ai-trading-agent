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
    """Same file and override as @trading/notify's prefs.ts: `{"disabled": [type, ...]}`."""
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


def is_enabled(kind: str | None, path: Path | None = None) -> bool:
    """An untagged message (kind None) is always sent."""
    return kind is None or kind not in disabled_types(path)


@dataclass
class Notification:
    source: str
    severity: str  # info | warn | error | action_required
    title: str
    body: str = ""
    # Which switch on the dashboard's Notifications page controls this message (a key of
    # NOTIFICATION_TYPES in packages/notify/src/prefs.ts). None means always sent.
    type: str | None = None


def render(n: Notification, now: datetime | None = None) -> str:
    stamp = (now or datetime.now(IST)).astimezone(IST).strftime("%d %b, %H:%M")
    lines = [f"{SEVERITY_ICON[n.severity]} {n.title}", f"{n.source}, {stamp} IST"]
    if n.body:
        lines += ["", n.body]
    text = redact("\n".join(lines))
    if len(text) > TELEGRAM_LIMIT:
        text = text[: TELEGRAM_LIMIT - 20] + "\n… (truncated)"
    return text


def send(n: Notification) -> tuple[bool, str]:
    """Send (or, without TELEGRAM_* configured, print) the message.
    Returns (delivered, text)."""
    load_dotenv()
    text = render(n)
    if not is_enabled(n.type):
        print(f"\n[telegram: '{n.type}' is switched off, message below]\n{text}")
        return False, text
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
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
