"""The automation settings (BL-140) as the export jobs read them: the current version the
scheduler writes to `automation-settings.json` beside its database whenever the owner saves the
dashboard's Settings › Automation page (`apps/scheduler/src/automation.ts` writes it and holds the
validation; `packages/broker-login/src/automation-settings.ts` is the TypeScript reader).

No file yet means today's setup (the scheduler's defaults), so the jobs behave exactly as before
until the owner saves something. A file that cannot be read is an error: never guess."""

from __future__ import annotations

import json
import os
from pathlib import Path

PLATFORMS = ("algotest", "quantiply")
BROKERS = ("finvasia", "angelone")

DEFAULT = {
    "version": 0,
    "masters": {"logins": True, "uploads": True, "deploy": False},
    "rows": {
        "algotest.finvasia": {"login": True, "list": "t1", "upload": True},
        "algotest.angelone": {"login": True, "list": "none", "upload": False},
        "quantiply.angelone": {"login": True, "list": "core", "upload": True},
        "quantiply.finvasia": {"login": False, "list": "none", "upload": False},
    },
}


def settings_path() -> Path:
    base = os.environ.get("SCHEDULER_STATE_DIR", "").strip()
    folder = (
        Path(base) if base else Path.home() / "Library" / "Application Support" / "ai-trading-agent"
    )
    return folder / "automation-settings.json"


def read(path: Path | None = None) -> tuple[dict, str]:
    """(settings, where they came from: 'settings vN' or 'defaults')."""
    path = path or settings_path()
    if not path.exists():
        return DEFAULT, "settings: defaults (none saved yet)"
    data = json.loads(path.read_text())
    if not isinstance(data.get("masters"), dict) or not isinstance(data.get("rows"), dict):
        raise ValueError(f"{path}: not automation settings")
    for p in PLATFORMS:
        for b in BROKERS:
            row = data["rows"].get(f"{p}.{b}")
            if row is None:
                raise ValueError(f"{path}: row {p}.{b} missing")
            if row.get("list") not in ("none", "core", "t1"):
                raise ValueError(f"{path}: row {p}.{b} has list {row.get('list')!r}")
    return data, f"settings v{data.get('version', 0)}"


def upload_books(settings: dict, platform: str, broker: str | None = None) -> list[str]:
    """The lists (`core`, `t1`) to upload to `platform`, for one broker's row or any of them;
    empty when uploads are switched off or no row uploads."""
    if not settings["masters"].get("uploads"):
        return []
    books = set()
    for b in [broker] if broker else BROKERS:
        row = settings["rows"][f"{platform}.{b}"]
        if row.get("upload") and row.get("list") in ("core", "t1"):
            books.add(row["list"])
    return sorted(books)
