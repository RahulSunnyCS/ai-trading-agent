"""The 15:50 capital reading (scheduler `contract-notes-capital`) and the owner's typed inputs,
both in `contract-notes/manual/<day>.json`.

The owner's Capital is the money an account had that session morning (owner, 2026-10-26: read
it after the close). So the reading after day D's close is recorded twice: as D's
`closing_funds` and as the NEXT session's `capital` (per broker).

- Angel One: SmartAPI `getRMS` `net` (free margin), ONE login under the guard every Angel One
  login shares (`obt angel funds`'s; it waits for the lock and the cool-down).
- Finvasia: not read. Its only source is AlgoTest's figure from that platform's morning broker
  login, and a 15:50 AlgoTest login would collide with the 15:40/15:55 live capture and the
  Quantiply disable; Shoonya's own API is never logged in to (BL-143). Finvasia's capital stays
  what the owner types (the page's inputs, or the sheet's import).

Every write holds `manual/.lock` (the page, this job and `reconcile.js --import-manual` must not
undo each other's fields), writes a unique temporary file flushed to disk and renames it. A
damaged day file is kept beside as `<day>.json.damaged` and read as empty.
"""

from __future__ import annotations

import csv
import fcntl
import json
import os
import tempfile
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

from .store import store_dir

HOLIDAYS = Path(__file__).resolve().parent.parent / "data" / "reference" / "holidays.csv"


def next_session(day: date) -> date:
    """The next trading day after `day` (weekends and the reference holidays skipped)."""
    holidays = set()
    with HOLIDAYS.open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            try:
                holidays.add(date.fromisoformat(row["date"]))
            except (KeyError, ValueError, TypeError):
                continue
    d = day + timedelta(days=1)
    while d.weekday() >= 5 or d in holidays:
        d += timedelta(days=1)
    return d


def write_manual(root: Path, day: date, update: Callable[[dict], dict]) -> dict:
    """Read `manual/<day>.json`, apply `update`, write it back: under the folder's lock, through
    a unique temporary file flushed to disk."""
    folder = store_dir(root) / "manual"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{day}.json"
    with (folder / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            current = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
            if not isinstance(current, dict):
                raise ValueError("not an object")
        except ValueError:
            os.replace(path, path.with_name(f"{path.name}.damaged"))
            current = {}
        nxt = update(dict(current))
        fd, tmp = tempfile.mkstemp(dir=folder, prefix=f".{day}.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(json.dumps(nxt, indent=2) + "\n")
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise
    return nxt


def record_capital(root: Path, day: date, broker: str, amount: float, source: str) -> date:
    """The reading after `day`'s close: `day`'s closing funds and the next session's capital.
    Returns the next session."""
    at = datetime.now(UTC).isoformat()
    value = round(float(amount), 2)

    def closing(m: dict) -> dict:
        m.setdefault("day", day.isoformat())
        m["closing_funds"] = {**(m.get("closing_funds") or {}), broker: value}
        return m

    nxt = next_session(day)

    def opening(m: dict) -> dict:
        m.setdefault("day", nxt.isoformat())
        m["capital"] = {**(m.get("capital") or {}), broker: value}
        read = dict(m.get("capital_read_at") or {})
        read[broker] = {"at": at, "source": source, "after_close_of": day.isoformat()}
        m["capital_read_at"] = read
        return m

    write_manual(root, day, closing)
    write_manual(root, nxt, opening)
    return nxt


def read_angelone_capital() -> float:
    """One guarded SmartAPI login, one getRMS read. Raises on any failure."""
    from ..angelone.check import session
    from ..angelone.funds import read_funds

    with session(source="margin") as sess:
        funds = read_funds(sess)
    if funds.net is None:
        raise RuntimeError("Angel One getRMS gave no net figure")
    return float(funds.net)
