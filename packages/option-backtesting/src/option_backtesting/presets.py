"""
Shared preset-strategy lookup — used by both the FastAPI service
(api/routes.py) and the MCP server (mcp/server.py). `preset_names()` is the
allow-list: a caller-supplied preset name is only ever accepted when it's a
member of this enumerated set, resolved fresh from disk on every call —
never used to build a filesystem path before that check, so a client can
never supply a name that resolves outside `STRATEGIES_DIR`.
"""

from __future__ import annotations

from pathlib import Path

STRATEGIES_DIR = Path(__file__).parent.parent.parent / "strategies"


def preset_names() -> list[str]:
    return sorted(p.stem for p in STRATEGIES_DIR.glob("*.yaml"))
