"""The completed day's paper result for Adaptive and, beside it, the T1 parallel track."""

from __future__ import annotations

import fcntl
import json
from collections.abc import Iterator
from contextlib import contextmanager
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
#   <day>-<hash16>.group.sent  its copy reached the friends' group
#   <day>-<hash16>.t1.sent     T1 is settled: its result went out (inside the main message or as
#                              its own follow-up), or the day has no T1 entry and never will
#   <day>-<hash16>.group-t1-owed.sent  the group's copy went without T1's result, so the group is
#                              owed T1's follow-up (a group copy sent before 2026-10-28 had no T1
#                              part and writes no such marker, so it is owed nothing)
#   <day>-<hash16>.group-t1.sent       the group's T1 is settled, as `.t1.sent` is the owner's
#
# Each destination has its own marker, so a failure on the group never makes a retry send the
# owner's chat the same message again.
#
# Before BL-125 a single `.sent` marker meant "sent to the owner AND the group" (and the message had
# no T1 part). Such a marker is recognised by its text and still covers every piece, so a day marked
# under the old scheme is never sent again in part (no group copy, no T1 follow-up).

MARKER_KINDS = {
    "": ".sent",
    "group": ".group.sent",
    "t1": ".t1.sent",
    "group-t1-owed": ".group-t1-owed.sent",
    "group-t1": ".group-t1.sent",
}
LEGACY_MARKER_TEXT = "sent to the configured Telegram destinations\n"


def _notifications_dir(root: Path | None) -> Path:
    return store.rotation_dir(root or data_dir()) / "result-notifications"


def sent_marker(result: DailyResult, root: Path | None = None, kind: str = "") -> Path:
    return _notifications_dir(root) / f"{result.day}-{result.entry_hash[:16]}{MARKER_KINDS[kind]}"


def _legacy(result: DailyResult, root: Path | None) -> bool:
    """A pre-BL-125 marker: one file for the owner and the group together."""
    try:
        return sent_marker(result, root).read_text() == LEGACY_MARKER_TEXT
    except OSError:
        return False


def was_sent(result: DailyResult, root: Path | None = None, kind: str = "") -> bool:
    return sent_marker(result, root, kind).exists() or _legacy(result, root)


def mark_sent(result: DailyResult, root: Path | None = None, kind: str = "") -> None:
    path = sent_marker(result, root, kind)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"{kind or 'owner'}: sent\n")


def tentative_path(day: date | str, root: Path | None = None) -> Path:
    """The lists the evening message sent for session `day` (its "(Tentative)" section)."""
    return _notifications_dir(root) / f"{day}.tentative.json"


def _picks_doc(picks, sent_on: date) -> dict | None:
    if picks is None or isinstance(picks, str):  # a note: no list was sent
        return None
    return {
        "day": picks.day.isoformat(),
        "sent_on": sent_on.isoformat(),
        "core": list(picks.core),
        "buy": list(picks.buy),
    }


def save_tentative(sent_on: date, adaptive=None, t1=None, root: Path | None = None) -> None:
    """Keep what the evening message listed for the next session, so the 09:16 message can say
    whether its picks changed. A list given as None keeps the one already saved (the T1 follow-up
    adds T1 to Adaptive's). Never raises: the morning line is only left out."""
    first = adaptive if adaptive is not None and not isinstance(adaptive, str) else t1
    if first is None or isinstance(first, str):
        return
    try:
        path = tentative_path(first.day.isoformat(), root)
        doc = read_tentative(first.day, root)
        for key, picks in (("adaptive", adaptive), ("t1", t1)):
            part = _picks_doc(picks, sent_on)
            if part is not None:
                doc[key] = part
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(doc, indent=2) + "\n")
    except Exception:  # noqa: BLE001 - the message is already out; only the morning line is lost
        pass


def read_tentative(day: date | str, root: Path | None = None) -> dict:
    """{'adaptive': {...}, 't1': {...}} as `save_tentative` kept them; {} when there is none."""
    try:
        doc = json.loads(tentative_path(str(day), root).read_text())
    except Exception:  # noqa: BLE001 - no data root, no file, a torn file: the line is left out
        return {}
    return doc if isinstance(doc, dict) else {}


@contextmanager
def sending_lock(day: date, root: Path | None = None) -> Iterator[None]:
    """One exclusive lock per day around deciding, sending and marking the evening message, so two
    runs that overlap (the 16:00 job's retries, the 21:00 job's step, a run by hand) can never both
    send it. The same `fcntl.flock` the journal append and the results store use."""
    folder = _notifications_dir(root)
    folder.mkdir(parents=True, exist_ok=True)
    with open(folder / f"{day.isoformat()}.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield


def _total_and_rows(result: DailyResult) -> tuple[float, list[tuple[str, float]]]:
    key = RESULT_KEYS[0]
    return result.gains[key], result.strategies.get(key, [])


def render(
    result: DailyResult,
    t1: DailyResult | str | None = None,
    tomorrow=None,
    tomorrow_t1=None,
    live: list[str] | None = None,
) -> str:
    """The evening message (BL-125): Adaptive's result, T1's (or the note saying why it is not
    there), BL-141's live-vs-paper lines (`live`, the owner's copy only), then tomorrow's
    strategies in full. `tomorrow` / `tomorrow_t1` are `tomorrow.NextPicks` (or a note for T1);
    without `tomorrow` there is no section."""
    t1_part = _total_and_rows(t1) if isinstance(t1, DailyResult) else t1
    return messages.render_result(
        result.day, _total_and_rows(result), t1_part, tomorrow, tomorrow_t1, live=live
    )


def render_t1_followup(t1: DailyResult, tomorrow_t1=None) -> str:
    """T1's result as a message of its own, for when it was not ready for the main message."""
    return messages.render_result(
        t1.day, None, _total_and_rows(t1), None, tomorrow_t1, heading="Tuned Adaptive result"
    )
