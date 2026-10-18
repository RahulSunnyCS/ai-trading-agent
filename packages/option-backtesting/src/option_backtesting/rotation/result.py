"""The completed day's paper result for Adaptive and, beside it, the T1 parallel track."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

from ..fyers.daily import data_dir
from . import journal, messages, store
from .lists import DISPLAY_NAMES, PUBLIC_KEYS

RESULT_KEYS = PUBLIC_KEYS
REPORT_LOTS = 1


class ResultUnavailable(RuntimeError):
    """The day has no morning entry, or one of its picked strategies is not scored yet."""


class NoEntry(ResultUnavailable):
    """The journal has no entry for the day: nothing was picked, so nothing will ever be scored."""


class NotScored(ResultUnavailable):
    """The day has an entry but one of its picked strategies has no stored result yet."""


@dataclass(frozen=True)
class DailyResult:
    day: date
    weekday: str
    gains: dict[str, float]
    entry_hash: str
    strategies: dict[str, list[tuple[str, float]]] = field(default_factory=dict)
    track: str | None = None


def calculate(day: date, root: Path | None = None, track: str | None = None) -> DailyResult:
    """Net P&L after estimated costs, reported at one lot per picked strategy. `track` reads that
    parallel track's journal (its variants' results live in its own folder, `store.result_path`)."""
    root = root or data_dir()
    where = f"{track.upper()} track " if track else ""
    path = store.journal_path(root, track)
    entries = [e for e in journal.read(path) if e.get("day") == day.isoformat()]
    if not entries:
        raise NoEntry(f"no {where}rotation picks were recorded for {day}")
    entry = entries[0]
    missing: set[str] = set()
    gains: dict[str, float] = {}
    strategies: dict[str, list[tuple[str, float]]] = {}
    for key in RESULT_KEYS:
        picked = entry.get("lists", {}).get(key)
        if not picked:
            raise NoEntry(f"the {day} {where}journal entry has no {DISPLAY_NAMES[key]} picks")
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
        raise NotScored(
            f"{where}results for {day} are not complete: {len(missing)} picked strategies missing "
            f"({sample}{suffix})"
        )
    return DailyResult(
        day,
        str(entry.get("weekday", "")),
        gains,
        str(entry.get("hash", "")),
        strategies,
        track,
    )


# -- sent markers -------------------------------------------------------------------------------
#
# One folder of empty-ish files per day and live entry, so a retry never sends the same thing twice
# and a late T1 result can still be delivered on its own:
#
#   <day>-<hash16>.sent        the result message reached the owner
#   <day>-<hash16>.group.sent  its Adaptive-only copy reached the friends' group
#   <day>-<hash16>.t1.sent     T1 is settled: its result went out (inside the main message or as
#                              its own follow-up), or the day has no T1 entry and never will
#
# Each destination has its own marker, so a failure on the group never makes a retry send the
# owner's chat the same message again.

MARKER_KINDS = {"": ".sent", "group": ".group.sent", "t1": ".t1.sent"}


def sent_marker(result: DailyResult, root: Path | None = None, kind: str = "") -> Path:
    root = root or data_dir()
    return (
        store.rotation_dir(root)
        / "result-notifications"
        / f"{result.day}-{result.entry_hash[:16]}{MARKER_KINDS[kind]}"
    )


def was_sent(result: DailyResult, root: Path | None = None, kind: str = "") -> bool:
    return sent_marker(result, root, kind).exists()


def mark_sent(result: DailyResult, root: Path | None = None, kind: str = "") -> None:
    path = sent_marker(result, root, kind)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("sent to the configured Telegram destinations\n")


def _total_and_rows(result: DailyResult) -> tuple[float, list[tuple[str, float]]]:
    key = RESULT_KEYS[0]
    return result.gains[key], result.strategies.get(key, [])


def render(
    result: DailyResult,
    t1: DailyResult | str | None = None,
    tomorrow=None,
    tomorrow_t1=None,
) -> str:
    """The evening message (BL-125): Adaptive's result, T1's (or the note saying why it is not
    there), then tomorrow's strategies in full. `tomorrow` / `tomorrow_t1` are
    `tomorrow.NextPicks` (or a note for T1); without `tomorrow` there is no section."""
    t1_part = _total_and_rows(t1) if isinstance(t1, DailyResult) else t1
    return messages.render_result(
        result.day, _total_and_rows(result), t1_part, tomorrow, tomorrow_t1
    )


def render_t1_followup(t1: DailyResult, tomorrow_t1=None) -> str:
    """T1's result as a message of its own, for when it was not ready for the main message."""
    return messages.render_result(
        t1.day, None, _total_and_rows(t1), None, tomorrow_t1, heading="T1 result"
    )
