"""The owner's placement record: did the day's basket actually get placed on AlgoTest.

The journal says what the rule picked at 09:16; nothing links that to what the owner did by hand.
This is a separate, append-only file, `TRADING_DATA_ROOT/rotation/placements.jsonl`, one JSON
object per line:

    {"day": "2026-10-12", "list": "A", "status": "placed", "note": "", "at": "2026-10-12T09:31:07"}

`status` is `placed`, `changed` (the note says what was changed) or `not_placed`. A later row for
the same (day, list) supersedes the earlier one in the read view; the earlier rows stay in the
file, so the record of what the owner said and when is never rewritten. The file is never read by
the ranking, the journal or the results, and nothing here writes to them: scheduled (the journal),
simulated (the results) and executed (this) stay three separate things.
"""

from __future__ import annotations

import fcntl
import json
import os
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from ..fyers.daily import data_dir
from . import journal, store

IST = ZoneInfo("Asia/Kolkata")
STATUSES = ("placed", "changed", "not_placed")
NOTE_MAX = 300
COLUMNS = ("day", "list", "status", "note", "at")


class PlacementError(ValueError):
    """The row is refused; nothing was written."""


def placements_path(root: Path | None = None) -> Path:
    return store.rotation_dir(root) / "placements.jsonl"


@contextmanager
def _write_lock(root: Path | None) -> Iterator[None]:
    """One exclusive lock for every append, the same approach as `store._write_lock`: the
    validation read and the append are one step."""
    directory = store.rotation_dir(root)
    directory.mkdir(parents=True, exist_ok=True)
    with open(directory / ".placements.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


@dataclass(frozen=True)
class Read:
    rows: list[dict]  # every row, in file order
    skipped: int  # lines that are not a valid row (a torn write or a hand edit)


def read(root: Path | None = None) -> Read:
    """Every row of the file. A line that is not a valid row is counted and skipped, so one bad
    line never hides the rest of the record."""
    path = placements_path(root)
    if not path.exists():
        return Read([], 0)
    rows: list[dict] = []
    skipped = 0
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            skipped += 1
            continue
        if (
            isinstance(row, dict)
            and all(isinstance(row.get(c), str) for c in COLUMNS)
            and row["status"] in STATUSES
        ):
            rows.append({c: row[c] for c in COLUMNS})
        else:
            skipped += 1
    return Read(rows, skipped)


def current(rows: list[dict]) -> dict[tuple[str, str], dict]:
    """{(day, list): the latest row}: a later row supersedes an earlier one."""
    out: dict[tuple[str, str], dict] = {}
    for row in rows:
        out[(row["day"], row["list"])] = row
    return out


def in_range(rows: list[dict], start: date | None, end: date | None) -> list[dict]:
    def keep(row: dict) -> bool:
        d = date.fromisoformat(row["day"])
        return (start is None or d >= start) and (end is None or d <= end)

    return [r for r in rows if keep(r)]


def validate(
    day: str, list_key: str, status: str, note: str, root: Path | None = None
) -> dict[str, str]:
    """The cleaned row fields, or PlacementError saying what is wrong. Reads the journal only."""
    try:
        parsed = date.fromisoformat(day)
    except (TypeError, ValueError) as error:
        raise PlacementError("day must be YYYY-MM-DD") from error
    if parsed.isoformat() != day:
        raise PlacementError("day must be YYYY-MM-DD")
    if status not in STATUSES:
        raise PlacementError(f"status must be one of {', '.join(STATUSES)}")
    if not isinstance(note, str):
        raise PlacementError("note must be text")
    note = note.strip()
    if len(note) > NOTE_MAX:
        raise PlacementError(f"note is {len(note)} characters; at most {NOTE_MAX}")
    if "\n" in note or "\r" in note:
        note = " ".join(note.split())
    if status == "changed" and not note:
        raise PlacementError("say what was changed in the note")
    try:
        entries = journal.read(store.journal_path(root))
    except journal.JournalCorrupt as error:
        raise PlacementError(f"the journal cannot be read: {error}") from error
    entry = next((e for e in entries if e.get("day") == day), None)
    if entry is None:
        raise PlacementError(f"{day} has no journal entry: only a recorded day can be marked")
    if list_key not in entry.get("lists", {}):
        known = ", ".join(entry.get("lists", {})) or "none"
        raise PlacementError(f"list {list_key!r} is not in the {day} entry (lists: {known})")
    return {"day": day, "list": list_key, "status": status, "note": note}


def append(
    day: str,
    list_key: str,
    status: str,
    note: str = "",
    root: Path | None = None,
    now: datetime | None = None,
) -> dict:
    """Validate and append one row; returns it. Never touches the journal or the results."""
    root = root or data_dir()
    path = placements_path(root)
    with _write_lock(root):
        fields = validate(day, list_key, status, note, root)
        row = {
            **fields,
            "at": (now or datetime.now(IST)).astimezone(IST).isoformat(timespec="seconds"),
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size and not path.read_bytes().endswith(b"\n"):
            # a torn last line: start on a fresh line so the new row is not glued to it
            with path.open("a") as f:
                f.write("\n")
        with path.open("a") as f:
            f.write(json.dumps({c: row[c] for c in COLUMNS}, sort_keys=False) + "\n")
            f.flush()
            os.fsync(f.fileno())
    return row
