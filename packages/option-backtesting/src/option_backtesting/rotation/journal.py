"""The insert-only hash chain of daily entries (one line per trading day).

Each entry carries the SHA-256 of the previous entry's hash plus its own canonical JSON, so an edit,
a removal or a reorder of any earlier line breaks every later hash and `verify` names it. One entry
per day; a second entry for a recorded day is refused, never superseded.
"""

from __future__ import annotations

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


def read(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def head(path: Path) -> str:
    entries = read(path)
    return entries[-1]["hash"] if entries else GENESIS


def append(path: Path, fields: dict) -> dict:
    """Add an entry for fields['day']. Raises ValueError if that day is already recorded."""
    entries = read(path)
    if any(e["day"] == fields["day"] for e in entries):
        raise ValueError(f"{fields['day']} is already in the journal")
    entry = {**fields, "prev": entries[-1]["hash"] if entries else GENESIS}
    entry["hash"] = entry_hash(entry)
    path.parent.mkdir(parents=True, exist_ok=True)
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
    for n, e in enumerate(read(path), 1):
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
