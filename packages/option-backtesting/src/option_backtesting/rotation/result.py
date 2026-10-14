"""The completed day's paper result for the two public rotation strategies (Steady, Adaptive)."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from ..fyers.daily import data_dir
from . import journal, store
from .lists import DISPLAY_NAMES, PUBLIC_KEYS

RESULT_KEYS = PUBLIC_KEYS
REPORT_LOTS = 1


class ResultUnavailable(RuntimeError):
    """The day has no morning entry, or one of its picked strategies is not scored yet."""


@dataclass(frozen=True)
class DailyResult:
    day: date
    weekday: str
    gains: dict[str, float]
    entry_hash: str
    strategies: dict[str, list[tuple[str, float]]] = field(default_factory=dict)


def calculate(day: date, root: Path | None = None) -> DailyResult:
    """Net P&L after estimated costs, reported at one lot per picked strategy."""
    root = root or data_dir()
    entries = [e for e in journal.read(store.journal_path(root)) if e.get("day") == day.isoformat()]
    if not entries:
        raise ResultUnavailable(f"no rotation picks were recorded for {day}")
    entry = entries[0]
    missing: set[str] = set()
    gains: dict[str, float] = {}
    strategies: dict[str, list[tuple[str, float]]] = {}
    for key in RESULT_KEYS:
        picked = entry.get("lists", {}).get(key)
        if not picked:
            raise ResultUnavailable(f"the {day} journal entry has no {DISPLAY_NAMES[key]} picks")
        names = [*picked.get("core", []), *picked.get("buy", [])]
        values: list[tuple[str, float]] = []
        for name in names:
            value = store.read_net(name, root).get(day)
            if value is None:
                missing.add(name)
            else:
                values.append((name, REPORT_LOTS * value))
        strategies[key] = values
        gains[key] = sum(value for _, value in values)
    if missing:
        sample = ", ".join(sorted(missing)[:3])
        suffix = f" and {len(missing) - 3} more" if len(missing) > 3 else ""
        raise ResultUnavailable(
            f"results for {day} are not complete: {len(missing)} picked strategies missing "
            f"({sample}{suffix})"
        )
    return DailyResult(
        day,
        str(entry.get("weekday", "")),
        gains,
        str(entry.get("hash", "")),
        strategies,
    )


def sent_marker(result: DailyResult, root: Path | None = None) -> Path:
    root = root or data_dir()
    return (
        store.rotation_dir(root)
        / "result-notifications"
        / (f"{result.day}-{result.entry_hash[:16]}.sent")
    )


def was_sent(result: DailyResult, root: Path | None = None) -> bool:
    return sent_marker(result, root).exists()


def mark_sent(result: DailyResult, root: Path | None = None) -> None:
    path = sent_marker(result, root)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("sent to the configured Telegram destinations\n")


def _rupees(value: float) -> str:
    sign = "+" if value > 0 else "-" if value < 0 else ""
    return f"{sign}₹{abs(value):,.0f}"


def render(result: DailyResult) -> str:
    lines = [
        f"Paper result {result.day} ({result.weekday})",
        f"Net after estimated costs · {REPORT_LOTS} lot per strategy",
        "",
    ]
    for key in RESULT_KEYS:
        lines.append(f"{DISPLAY_NAMES[key]}: {_rupees(result.gains[key])}")
        lines.extend(
            f"  • {name}: {_rupees(value)}" for name, value in result.strategies.get(key, [])
        )
    lines.append(f"entry {result.entry_hash[:12]}")
    return "\n".join(lines)
