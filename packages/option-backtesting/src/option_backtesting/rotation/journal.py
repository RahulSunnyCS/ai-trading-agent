"""The insert-only hash chain of daily entries (one line per trading day).

Each entry carries the SHA-256 of the previous entry's hash plus its own canonical JSON, so an edit,
a removal or a reorder of any earlier line breaks every later hash and `verify` names it. One entry
per day; a second entry for a recorded day is refused, never superseded.
"""

from __future__ import annotations

import fcntl
import hashlib
import json
import os
from pathlib import Path

GENESIS = "0" * 64


def _canonical(entry: dict) -> str:
    return json.dumps(
        {k: v for k, v in entry.items() if k != "hash"}, sort_keys=True, separators=(",", ":")
    )


def entry_hash(entry: dict) -> str:
    return hashlib.sha256((entry["prev"] + _canonical(entry)).encode()).hexdigest()


class JournalCorrupt(ValueError):
    """A line of the journal is not valid JSON (a torn write or a hand edit)."""


def read(path: Path) -> list[dict]:
    if not path.exists():
        return []
    entries = []
    for n, line in enumerate(path.read_text().splitlines(), 1):
        if not line.strip():
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError as error:
            raise JournalCorrupt(
                f"{path.name} line {n} is not valid JSON ({error.msg}): a torn write or an edit; "
                "nothing was appended"
            ) from error
    return entries


def head(path: Path) -> str:
    entries = read(path)
    return entries[-1]["hash"] if entries else GENESIS


class AlreadyRecorded(ValueError):
    """The day already has its entry (a retry after a success, or a second process)."""


def append(path: Path, fields: dict) -> dict:
    """Add an entry for fields['day']. Raises AlreadyRecorded if that day is already recorded.
    The read, the duplicate check and the write happen under an exclusive file lock, so two
    processes cannot both append (or fork the chain)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path.with_suffix(".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        entries = read(path)
        if path.exists() and path.stat().st_size and not path.read_bytes().endswith(b"\n"):
            raise JournalCorrupt(f"{path.name} does not end with a newline (torn write)")
        if any(e["day"] == fields["day"] for e in entries):
            raise AlreadyRecorded(f"{fields['day']} is already in the journal")
        entry = {**fields, "prev": entries[-1]["hash"] if entries else GENESIS}
        entry["hash"] = entry_hash(entry)
        with path.open("a") as f:
            f.write(json.dumps(entry, sort_keys=True) + "\n")
            f.flush()
            os.fsync(f.fileno())
    return entry


def verify(path: Path) -> list[str]:
    """Problems found re-computing the chain (empty = intact)."""
    problems: list[str] = []
    prev = GENESIS
    seen: set[str] = set()
    try:
        entries = read(path)
    except JournalCorrupt as error:
        return [str(error)]
    for n, e in enumerate(entries, 1):
        if e.get("prev") != prev:
            problems.append(
                f"entry {n} ({e.get('day')}): prev hash does not match the entry before it"
            )
        if entry_hash(e) != e.get("hash"):
            problems.append(f"entry {n} ({e.get('day')}): content does not match its hash")
        if e.get("day") in seen:
            problems.append(f"entry {n}: duplicate day {e.get('day')}")
        seen.add(e.get("day"))
        prev = e.get("hash", "")
    return problems
