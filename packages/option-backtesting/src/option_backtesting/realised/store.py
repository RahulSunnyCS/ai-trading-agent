"""Read the contract-notes store (`TRADING_DATA_ROOT/contract-notes/`), read-only.

- `days/<day>.jsonl`: one line per broker account and session (`status` note / no_trade /
  no_note / failed); an F&O note's line has `fno` (the sheet's five figures), `charges`, `trades`
  and `trades_check`; a `kite` line has `eq` and `trades`.
- `ledger/<day>.jsonl`: one event per ledger e-mail (`deposit`, `withdrawal`,
  `collateral_interest`, `margin_warning`, `settlement`).
- `manual/<day>.json`: the inputs typed by hand or read at 15:50: `algos`, `capital_total`,
  `capital` (per broker).

A damaged line is reported in `Book.problems`, never guessed at and never fatal.
"""

from __future__ import annotations

import json
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
