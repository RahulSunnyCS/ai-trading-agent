"""Read the contract-notes store (`TRADING_DATA_ROOT/contract-notes/`), read-only.

- `days/<day>.jsonl`: one line per broker account and session (`status` note / no_trade /
  no_note / failed); an F&O note's line has `fno` (the sheet's five figures), `charges`, `trades`
  and `trades_check`; a `kite` line has `eq` and `trades`.
- `ledger/<day>.jsonl`: one event per ledger e-mail (`deposit`, `withdrawal`,
  `collateral_interest`, `margin_warning`, `settlement`).
- `manual/<day>.json`: the inputs typed by hand or read at 15:50: `algos`, `capital_total`,
  `capital` (per broker).

A damaged line is reported in `Book.problems`, never guessed at and never fatal.

`load_cached` is `load` kept in memory against the store's file stamps (`stamp`: the name, size
and mtime of every file `load` reads): reading the ~900 small files costs seconds on the
external disk, a stamp about 10 ms. The cached `Book` is shared between requests: treat it as
read-only.
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

FNO_BROKERS = ("finvasia", "angelone")


@dataclass
class Book:
    """Everything the store holds, by day."""

    lines: dict[date, list[dict]] = field(default_factory=dict)
    ledger: dict[date, list[dict]] = field(default_factory=dict)
    manual: dict[date, dict] = field(default_factory=dict)
    problems: list[str] = field(default_factory=list)

    @property
    def days(self) -> list[date]:
        """Every session the store has a line for, in order."""
        return sorted(self.lines)

    def fno_lines(self, day: date, account: str | None = None) -> list[dict]:
        """The F&O brokers' lines of `day` (one account's when `account` is `broker/id`)."""
        out = [ln for ln in self.lines.get(day, []) if ln.get("broker") in FNO_BROKERS]
        if account is not None:
            out = [ln for ln in out if f"{ln['broker']}/{ln['account']}" == account]
        return out

    def accounts(self, brokers: tuple[str, ...] = FNO_BROKERS) -> list[str]:
        """Every `broker/account` with a line, in order."""
        seen = {
            f"{ln['broker']}/{ln['account']}"
            for lines in self.lines.values()
            for ln in lines
            if ln.get("broker") in brokers
        }
        return sorted(seen)


def store_dir(root: Path) -> Path:
    return root / "contract-notes"


def _day_of(path: Path) -> date | None:
    try:
        return date.fromisoformat(path.name.split(".")[0])
    except ValueError:
        return None


def _jsonl(path: Path, problems: list[str]) -> list[dict]:
    out = []
    for i, text in enumerate(path.read_text(encoding="utf-8").split("\n"), start=1):
        if not text.strip():
            continue
        try:
            out.append(json.loads(text))
        except json.JSONDecodeError:
            problems.append(f"{path.parent.name}/{path.name} line {i} is damaged")
    return out


def load(root: Path) -> Book:
    """The whole store under `root` (TRADING_DATA_ROOT). A missing store is an empty book."""
    base = store_dir(root)
    book = Book()
    for path in sorted((base / "days").glob("*.jsonl")):
        day = _day_of(path)
        if day is not None:
            book.lines[day] = _jsonl(path, book.problems)
    for path in sorted((base / "ledger").glob("*.jsonl")):
        day = _day_of(path)
        if day is not None:
            book.ledger[day] = _jsonl(path, book.problems)
    for path in sorted((base / "manual").glob("*.json")):
        day = _day_of(path)
        if day is None:
            continue
        try:
            book.manual[day] = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            book.problems.append(f"manual/{path.name} is damaged")
    return book


# The folders `load` reads and the files it takes from each (its globs).
_READ = (("days", ".jsonl"), ("ledger", ".jsonl"), ("manual", ".json"))
_load_lock = threading.Lock()
_loaded: dict[Path, tuple[tuple, Book]] = {}  # root -> (stamp, book), the newest per root


def stamp(root: Path) -> tuple:
    """(folder, name, size, mtime_ns) of every file `load` reads under `root`, in order. Any
    change to a note, a ledger event or a manual input moves it."""
    base = store_dir(root)
    out = []
    for folder, suffix in _READ:
        try:
            with os.scandir(base / folder) as entries:
                for entry in entries:
                    if entry.name.endswith(suffix):
                        st = entry.stat()
                        out.append((folder, entry.name, st.st_size, st.st_mtime_ns))
        except FileNotFoundError:
            continue
    return tuple(sorted(out))


def load_cached(root: Path) -> Book:
    """`load(root)`, read again only when `stamp(root)` moved. One load at a time, so the page's
    reads arriving together wait for one read of the store rather than each making their own.
    The stamp is taken before the read: a file changed during it is read again next time."""
    key = Path(root)
    with _load_lock:
        current = stamp(key)
        hit = _loaded.get(key)
        if hit is not None and hit[0] == current:
            return hit[1]
        book = load(key)
        _loaded[key] = (current, book)
        while len(_loaded) > 4:  # roots: one in use, a few in tests
            _loaded.pop(next(iter(_loaded)))
        return book


def forget() -> None:
    """Drop every cached book (after a write, so even a same-instant change is read)."""
    with _load_lock:
        _loaded.clear()
