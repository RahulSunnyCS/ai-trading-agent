"""The 15:50 capital reading (scheduler `contract-notes-capital`): the money each broker account
had at the close, into `contract-notes/manual/<day>.json` as `capital: {broker: amount}`.

- Angel One: SmartAPI `getRMS` `net` (free margin), ONE login under the guard every Angel One
  login shares (`obt angel funds`'s; it waits for the lock and the cool-down).
- Finvasia: not read. Its only source is AlgoTest's figure from that platform's morning broker
  login, and a 15:50 AlgoTest login would collide with the 15:40/15:55 live capture and the
  Quantiply disable; Shoonya's own API is never logged in to (BL-143). Finvasia's capital stays
  what the owner types (the page's inputs, or the sheet's import) and the day's total is carried
  forward from the last full figure until both brokers have one.

Only `capital` and `capital_read_at` are written; every other field of the day's file is kept.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable
from datetime import UTC, date, datetime
from pathlib import Path

from .store import store_dir


def write_manual(root: Path, day: date, update: Callable[[dict], dict]) -> dict:
    """Read `manual/<day>.json`, apply `update`, write it back atomically and flushed to disk."""
    path = store_dir(root) / "manual" / f"{day}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    current = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    nxt = update(dict(current))
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    with tmp.open("w", encoding="utf-8") as f:
        f.write(json.dumps(nxt, indent=2) + "\n")
        f.flush()
        os.fsync(f.fileno())
    tmp.replace(path)
    return nxt


def record_capital(root: Path, day: date, broker: str, amount: float, source: str) -> dict:
    def update(m: dict) -> dict:
        m.setdefault("day", day.isoformat())
        capital = dict(m.get("capital") or {})
        capital[broker] = round(float(amount), 2)
        m["capital"] = capital
        read = dict(m.get("capital_read_at") or {})
        read[broker] = {"at": datetime.now(UTC).isoformat(), "source": source}
        m["capital_read_at"] = read
        return m

    return write_manual(root, day, update)


def read_angelone_capital() -> float:
    """One guarded SmartAPI login, one getRMS read. Raises on any failure."""
    from ..angelone.check import session
    from ..angelone.funds import read_funds

    with session(source="margin") as sess:
        funds = read_funds(sess)
    if funds.net is None:
        raise RuntimeError("Angel One getRMS gave no net figure")
    return float(funds.net)
