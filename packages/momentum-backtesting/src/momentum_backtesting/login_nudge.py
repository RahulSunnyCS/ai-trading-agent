"""The phone half of the Fyers and Kite login reminders.

Both brokers' logins end on this package's API (`mbt serve`), and the hosted dashboard forwards
`/api/auth/fyers/*` and `/api/momentum/kite/*` to it through the Cloudflare tunnel. So once each
broker app's redirect URL is the dashboard host, the owner can log in from a phone. The reminders
link to the Broker logins page there and say when a phone login cannot work right now: the API
or the tunnel is not running on this Mac (both are kept up by launchd, deploy/launchd/).
"""

from __future__ import annotations

import os
import socket
import subprocess

BROKER_LOGINS_PATH = "/brokerLogins"
API_PORT = 8765


def broker_logins_url() -> str | None:
    """The hosted Broker logins page, or None when DASHBOARD_PUBLIC_URL is not set."""
    base = os.environ.get("DASHBOARD_PUBLIC_URL", "").strip().rstrip("/")
    return f"{base}{BROKER_LOGINS_PATH}" if base else None


def _api_listening(port: int = API_PORT) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            return True
    except OSError:
        return False


def _tunnel_running() -> bool:
    try:
        found = subprocess.run(
            ["pgrep", "-x", "cloudflared"], capture_output=True, timeout=5, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return found.returncode == 0


def phone_blockers() -> list[str]:
    """What stops a phone login right now (empty when nothing does)."""
    blockers = []
    if not _api_listening():
        blockers.append(f"the Momentum API (127.0.0.1:{API_PORT}) is not running")
    if not _tunnel_running():
        blockers.append("the Cloudflare tunnel (cloudflared) is not running")
    return blockers


def how_to_log_in(laptop: str) -> tuple[str, str | None]:
    """The reminder's how-to text and the link to send with it. `laptop` is the laptop-only way,
    used when no hosted dashboard is configured or a phone login cannot work right now."""
    url = broker_logins_url()
    if url is None:
        return laptop, None
    blockers = phone_blockers()
    if blockers:
        return (
            f"A phone login won't work right now: {'; '.join(blockers)}. {laptop}",
            url,
        )
    return f"From your phone: open the link, then Log in. Or {laptop[0].lower()}{laptop[1:]}", url
