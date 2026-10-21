"""The automation settings (BL-140) as the export jobs read them: the current version the
scheduler writes to `automation-settings.json` beside its database whenever the owner saves the
dashboard's Settings › Automation page (`apps/scheduler/src/automation.ts` writes it and holds the
validation; `packages/broker-login/src/automation-settings.ts` is the TypeScript reader).

No file yet means today's setup (the scheduler's defaults), so the jobs behave exactly as before
until the owner saves something. A file that cannot be read is an error: never guess."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")
PLATFORMS = ("algotest", "quantiply")
BROKERS = ("finvasia", "angelone")

DEFAULT = {
    "version": 0,
    "masters": {"logins": True, "uploads": True, "deploy": False},
    "rows": {
        "algotest.finvasia": {
            "login": True,
            "list": "t1",
            "upload": True,
            "multiplier": 1,
            "addon": True,
        },
        "algotest.angelone": {
            "login": False,
            "list": "none",
            "upload": False,
            "multiplier": 1,
            "addon": True,
        },
        "quantiply.angelone": {
            "login": True,
            "list": "core",
            "upload": True,
            "multiplier": 1,
            "addon": True,
        },
        "quantiply.finvasia": {
            "login": False,
            "list": "none",
            "upload": False,
            "multiplier": 1,
            "addon": True,
        },
    },
    "pause": {"until": None},
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
            # A snapshot written before Phase 4 has neither field: 1 and yes, what the jobs did.
            # A bad value is an error, never a guess: a wrong multiplier changes a real order.
            multiplier = row.get("multiplier", 1)
            if (
                isinstance(multiplier, bool)
                or not isinstance(multiplier, int)
                or not 1 <= multiplier <= 10
            ):
                raise ValueError(f"{path}: row {p}.{b} has multiplier {row.get('multiplier')!r}")
            addon = row.get("addon", True)
            if not isinstance(addon, bool):
                raise ValueError(f"{path}: row {p}.{b} has addon {row.get('addon')!r}")
            row["multiplier"], row["addon"] = multiplier, addon
    pause = data.get("pause") or {}
    until = pause.get("until") if isinstance(pause, dict) else "?"
    if until is not None and not (isinstance(until, str) and _DAY.fullmatch(until)):
        raise ValueError(f"{path}: pause.until is {until!r}")
    data["pause"] = {"until": until}
    return data, f"settings v{data.get('version', 0)}"


def paused_for(settings: dict, session: str) -> str | None:
    """The pause's last day when a session on `session` (an IST day, YYYY-MM-DD) is paused, else
    None. Inclusive."""
    until = (settings.get("pause") or {}).get("until")
    return until if until is not None and session <= until else None


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


def _uploading_rows(settings: dict, platform: str, book: str) -> list[dict]:
    return [
        settings["rows"][f"{platform}.{b}"]
        for b in BROKERS
        if settings["rows"][f"{platform}.{b}"].get("upload")
        and settings["rows"][f"{platform}.{b}"].get("list") == book
    ]


def addon_wanted(settings: dict, platform: str, book: str) -> bool:
    """Whether the `platform` export of `book` carries the Buy add-on picks: yes unless every row
    that uploads that list has the add-on off. One export serves every account of a platform, so
    while any account that shares the list wants the add-on it stays in."""
    rows = _uploading_rows(settings, platform, book)
    if not settings["masters"].get("uploads") or not rows:
        return True  # nothing uploads this list: leave the export as it always was
    return any(r.get("addon", True) for r in rows)


def addon_mixed(settings: dict, platform: str, book: str) -> bool:
    """Whether the rows that upload this list disagree about the add-on (so the export keeps it
    for an account that asked to leave it out)."""
    rows = _uploading_rows(settings, platform, book)
    return len({bool(r.get("addon", True)) for r in rows}) > 1
