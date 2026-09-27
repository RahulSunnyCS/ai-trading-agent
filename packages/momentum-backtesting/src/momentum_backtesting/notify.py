"""Telegram messages, mirroring packages/notify (TypeScript) for a Python caller.

Same contract as @trading/notify's `send()`: the Notification shape (source, severity,
title, body, runUrl), an IST stamp, `parse_mode` never set (broker and index names break
Telegram's Markdown parser and Telegram then silently drops the whole message), link
previews off, and every outbound string redacted against the secrets this process knows.
Never raises - a failed notification must not take down the job it reports on.
"""

import json
import os
import urllib.request
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

SEVERITY_ICON = {"info": "ℹ️", "warn": "⚠️", "error": "❌", "action_required": "🔔"}
IST = ZoneInfo("Asia/Kolkata")
TELEGRAM_LIMIT = 4096

# Environment variables whose values must never leave the process.
SECRET_ENV = (
    "TELEGRAM_BOT_TOKEN",
    "MOMENTUM_DATABASE_URL",
    "DATABASE_URL",
    "FYERS_ACCESS_TOKEN",
    "FYERS_APP_SECRET",
    "FYERS_PIN",
    "FYERS_TOTP_SECRET",
    "FYERS_CLIENT_ID",
)
_registry: set[str] = set()


def register_secret(value: str | None) -> None:
    if value and len(value) >= 4:
        _registry.add(value)


def redact(text: str) -> str:
    for secret in sorted(_registry | _env_secrets(), key=len, reverse=True):
        text = text.replace(secret, "***REDACTED***")
    return text


def _env_secrets() -> set[str]:
    return {v for k in SECRET_ENV if len(v := os.environ.get(k, "").strip()) >= 4}


@dataclass
class Notification:
    source: str
    severity: str  # info | warn | error | action_required
    title: str
    body: str = ""
    run_url: str | None = None


def ist_stamp(now: datetime | None = None) -> str:
    return (now or datetime.now(IST)).astimezone(IST).strftime("%d %b, %H:%M")


def render(n: Notification, now: datetime | None = None) -> str:
    lines = [f"{SEVERITY_ICON[n.severity]} {n.title}", f"{n.source}, {ist_stamp(now)} IST"]
    if n.body:
        lines += ["", n.body]
    if n.run_url:
        lines += ["", f"🔗 {n.run_url}"]
    text = redact("\n".join(lines))
    if len(text) > TELEGRAM_LIMIT:
        text = text[: TELEGRAM_LIMIT - 20] + "\n… (truncated)"
    return text


def send(n: Notification) -> str:
    """Sends (or, without TELEGRAM_* configured, prints) the message. Returns the text."""
    text = render(n)
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not (token and chat):
        print(f"\n[telegram not configured, message below]\n{text}")
        return text
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
    return text


def run_url() -> str | None:
    server, repo, run = (
        os.environ.get("GITHUB_SERVER_URL"),
        os.environ.get("GITHUB_REPOSITORY"),
        os.environ.get("GITHUB_RUN_ID"),
    )
    return f"{server}/{repo}/actions/runs/{run}" if server and repo and run else None
