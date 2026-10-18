"""Sending the rotation Telegram messages (BL-125): what goes to whom, and in what order.

The text itself is `messages.py`; this module decides when it is sent. Nothing here changes what is
picked, scored or journaled: it calls `pick.record` and `result.calculate` exactly as before and
only chooses how their output reaches Telegram.

Morning (`pick_and_send`): Adaptive is recorded first and is never held back by T1. T1 is recorded
right after (it reuses the live entry's VIX read); both go out as ONE message when T1 is ready
within `T1_WAIT_S`. If T1 fails or is slow, the Adaptive message goes at once with T1 marked "not
recorded today", the failure alerts the owner as before, and if T1 records later (a catch-up of its
results, or the job's retry) it follows as a message of its own. The friends' group copy is always
Adaptive alone.

Evening (`send_result`): one message for both lists plus tomorrow's strategies. See `send_result`
for the sent-marker design.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from datetime import date, datetime, time
from pathlib import Path
from zoneinfo import ZoneInfo

from . import journal, messages, result, store, tomorrow
from . import pick as pick_mod
from .journal import AlreadyRecorded
from .pick import PickError, PickResult

IST = ZoneInfo("Asia/Kolkata")
NOT_READY = "🧪 T1 · not ready"
#: how long the Adaptive message waits for T1 to be recorded after Adaptive's own entry is written
T1_WAIT_S = 30.0

Echo = Callable[[str], None]
#: (text, severity, chat_id or None for the owner's chat) -> delivered
SendText = Callable[..., bool]


def send_text(text: str, severity: str = "info", chat_id: str | None = None) -> bool:
    """One plain-text Telegram message (no icon or source line: the layout is the message's own),
    through the repo's notify path. Returns whether it was delivered."""
    from ..notify import Notification, send

    delivered, _ = send(
        Notification(source="options-rotation", severity=severity, title="", body=text, plain=True),
        chat_id=chat_id,
    )
    return delivered


def send_alert(title: str, body: str) -> None:
    from ..notify import Notification, send

    send(Notification(source="options-rotation", severity="error", title=title, body=body))


def group_chat_id() -> str | None:
    """The friends' group, when one is configured and is not the owner's own chat (an identical id
    sends once)."""
    group = os.environ.get("TELEGRAM_ROTATION_CHAT_ID", "").strip()
    if group and group != os.environ.get("TELEGRAM_CHAT_ID", "").strip():
        return group
    return None


def _journal_entry(day: date, root: Path | None, track: str | None) -> dict | None:
    path = store.journal_path(root, track)
    return next((e for e in journal.read(path) if e.get("day") == day.isoformat()), None)


# -- morning ------------------------------------------------------------------------------------


def _needs_catch_up(error: Exception, track: str) -> bool:
    return f"obt rotation update --track {track}" in str(error)


def _default_catch_up(track: str) -> tuple[int, int]:
    from .update import update_track

    return update_track(track)


def pick_and_send(
    day: date,
    *,
    vix_open: float | None = None,
    dry_run: bool = False,
    telegram: bool = True,
    track: str | None = None,
    with_t1: bool = False,
    echo: Echo = print,
    err: Echo | None = None,
    record_fn: Callable[..., PickResult] | None = None,
    send: SendText = send_text,
    alert: Callable[[str, str], None] = send_alert,
    catch_up: Callable[[str], tuple[int, int]] | None = None,
    root: Path | None = None,
    t1_wait_s: float = T1_WAIT_S,
) -> int:
    """Record the day's entry and send it. Returns the process exit code (0 ok, 2 not recorded or
    the T1 step failed: the job retries and, for T1, the owner is alerted)."""
    err = err or echo
    tag = f"{track.upper()} TRACK " if track else ""
    send_live = telegram and not dry_run

    def alert_if(title: str, body: str) -> None:
        if send_live:
            alert(tag + title, body)

    def attempt(t: str | None, vix: float | None = None, source: str | None = None):
        """(PickResult | None, error | None, already): one record() with its outcome sorted."""
        try:
            r = (record_fn or pick_mod.record)(
                day, vix_open=vix, dry_run=dry_run, track=t, vix_source=source
            )
            return r, None, False
        except AlreadyRecorded:
            return None, None, True
        except Exception as error:  # noqa: BLE001 - every failure must alert and retry
            return None, error, False

    # A parallel track picked on its own (by hand): its own layout, the owner's chat only.
    if track:
        r, error, already = attempt(track, vix_open)
        if already:
            echo(f"already recorded: {day.isoformat()} is already in the journal")
            return 0
        if error is not None:
            return _failed(error, day, alert_if, err)
        echo(r.text)
        if send_live:
            send(r.text, _severity(r.entry))  # never the friends' group
        return 0

    live, error, live_already = attempt(None, vix_open)
    if error is not None:
        return _failed(error, day, alert_if, err)
    if live_already:  # a retry after a success: the day has its entry (and its message)
        echo(f"already recorded: {day.isoformat()} is already in the journal")
    if not with_t1:
        if live is not None:
            echo(live.text)
            if send_live:
                _send_to_all(live.text, live.text, _severity(live.entry), send)
        return 0

    # Adaptive and T1 together. T1 shares the live entry's VIX read: one poll, one value.
    entry = live.entry if live else _journal_entry(day, root, None)
    vix = entry.get("vix_open") if entry else None
    source = entry.get("vix_source") if entry else None
    pool = ThreadPoolExecutor(max_workers=1)
    future = pool.submit(attempt, "t1", vix, source)
    try:
        t1, t1_error, t1_already = future.result(timeout=t1_wait_s)
        in_time = True
    except FutureTimeout:
        t1 = t1_error = None
        t1_already = False
        in_time = False

    if live is not None:
        # Adaptive goes out now, with T1 beside it when it is in, whatever happens to T1 next.
        if in_time and (t1 is not None or t1_already):
            t1_entry = t1.entry if t1 else _journal_entry(day, root, "t1")
            t1_options = t1.options if t1 else None
            private, group = messages.render_morning(live.entry, live.options, t1_entry, t1_options)
            echo(private)
            if send_live:
                _send_to_all(private, group, _severity(live.entry), send)
            pool.shutdown(wait=False)
            return 0
        private, group = messages.render_morning(live.entry, live.options, None)
        echo(private)
        if send_live:
            _send_to_all(private, group, _severity(live.entry), send)

    # T1 did not make the message. If it records (after a catch-up of its results, or on a retry)
    # it follows as a message of its own; if it fails the owner is alerted and the job retries.
    if not in_time:
        t1, t1_error, t1_already = future.result()
    pool.shutdown(wait=False)
    if t1_error is not None and _needs_catch_up(t1_error, "t1"):
        echo(f"T1 track: {t1_error}; storing its missing results now")
        try:
            (catch_up or _default_catch_up)("t1")
            t1, t1_error, t1_already = attempt("t1", vix, source)
        except Exception as error:  # noqa: BLE001
            t1_error = error
    if t1_already:
        echo("T1 track: already recorded")
        return 0
    if t1_error is not None:
        return _failed(t1_error, day, lambda t, b: alert_if("T1 TRACK " + t, b), err, tag="T1 ")
    echo(t1.text)
    if send_live:
        send(t1.text, _severity(t1.entry))  # T1 is private to the owner
    return 0


def _severity(entry: dict) -> str:
    return "info" if entry.get("before_first_entry") else "warn"


def _send_to_all(private: str, group: str, severity: str, send: SendText) -> bool:
    ok = send(private, severity)
    group_id = group_chat_id()
    if group_id:
        ok = send(group, severity, chat_id=group_id) and ok
    return ok


def _failed(error: Exception, day: date, alert_if, err: Echo, tag: str = "") -> int:
    """The same words and alerts the pick command has always used."""
    if isinstance(error, (PickError, ValueError)):
        err(f"{tag}not recorded: {error}")
        alert_if(f"Rotation pick NOT recorded for {day}", str(error))
    else:
        err(f"{tag}not recorded: {type(error).__name__}: {error}")
        alert_if(f"Rotation pick FAILED for {day}", f"{type(error).__name__}: {str(error)[:300]}")
    return 2


# -- evening ------------------------------------------------------------------------------------


def _t1_state(day: date, root: Path | None):
    """('ready', DailyResult) | ('pending', reason) | ('none', reason)."""
    try:
        return "ready", result.calculate(day, root, track="t1")
    except result.NoEntry as error:
        return "none", str(error)
    except result.ResultUnavailable as error:
        return "pending", str(error)


def _tomorrow_adaptive(today: date, root: Path | None, echo: Echo):
    """Adaptive's expected picks for the next session, or None: a failure here never stops the
    result going out."""
    try:
        return tomorrow.next_session_picks(today, root)
    except Exception as error:  # noqa: BLE001
        echo(f"tomorrow section skipped: {type(error).__name__}: {error}")
        return None


def _tomorrow_t1(today: date, root: Path | None, echo: Echo):
    """T1's expected picks, or the note saying they are not ready."""
    try:
        return tomorrow.next_session_picks(today, root, track="t1") or NOT_READY
    except Exception as error:  # noqa: BLE001
        echo(f"T1 tomorrow skipped: {type(error).__name__}: {error}")
        return NOT_READY


def send_result(
    day: date,
    *,
    telegram: bool = True,
    force: bool = False,
    with_tomorrow: bool = True,
    wait_until: time | None = None,
    echo: Echo = print,
    now_fn: Callable[[], datetime] = lambda: datetime.now(IST),
    send: SendText = send_text,
    root: Path | None = None,
) -> int:
    """The evening message for `day`. Returns the exit code (0 done or nothing left to send, 2
    not ready: the scheduler retries, and alerts the owner when the retries run out).

    Adaptive is the message. T1 rides along when its results are in. If they are not:

    - the T1 journal has no entry for the day (T1 was not recorded, so nothing will ever be
      scored): the message goes out now saying so, and T1 is settled;
    - the entry exists but its strategies are not all scored yet: until `wait_until` (IST) nothing
      is sent and the exit code is 2, so the scheduler's retry runs again in a few minutes. At or
      after it the message goes out with `🧪 T1 · result not ready`, and T1 stays unsettled so the
      next run (a retry, the 21:00 catch-up job, or by hand) sends T1's result as a message of its
      own once it is there.

    Sent markers (`result.sent_marker`) are per destination and per piece, so a retry never sends
    the owner's chat the same message twice, a failed group copy is retried alone, and a late T1
    result is still delivered."""
    try:
        adaptive = result.calculate(day, root)
    except result.ResultUnavailable as error:
        echo(f"result not ready: {error}")
        return 2
    kind, t1 = _t1_state(day, root)
    group_id = group_chat_id()
    marked = telegram and not force

    def done(which: str = "") -> bool:
        return marked and result.was_sent(adaptive, root, which)

    owner_needed = not done()
    group_needed = bool(group_id) and not done("group")

    if owner_needed or group_needed:
        if (
            owner_needed
            and kind == "pending"
            and not done("t1")
            and telegram
            and not force
            and wait_until is not None
            and now_fn().astimezone(IST).time() < wait_until
        ):
            echo(f"T1 results are not complete yet ({t1}); trying again before {wait_until:%H:%M}")
            return 2
        next_adaptive = _tomorrow_adaptive(day, root, echo) if with_tomorrow else None
        next_t1 = _tomorrow_t1(day, root, echo) if next_adaptive is not None else None
        if kind == "ready":
            t1_part = t1
        elif kind == "pending":
            t1_part = "🧪 T1 · result not ready"
        else:
            t1_part = "🧪 T1 · not recorded today"
        private = result.render(adaptive, t1_part, next_adaptive, next_t1)
        group = result.render(adaptive, None, next_adaptive, None)
        echo(private)
        if not telegram:
            return 0
        ok = True
        if owner_needed:
            if send(private):
                result.mark_sent(adaptive, root)
                if kind != "pending":
                    result.mark_sent(adaptive, root, "t1")
            else:
                ok = False
        if group_needed:
            if send(group, chat_id=group_id):
                result.mark_sent(adaptive, root, "group")
            else:
                ok = False
        if not ok:
            echo("Telegram delivery was incomplete; the pieces that went out are marked sent")
            return 2
        return 0

    # The result message is out. Complete T1 if it is still owed.
    if done("t1"):
        echo("already sent to Telegram")
        return 0
    if kind == "none":
        result.mark_sent(adaptive, root, "t1")
        echo("already sent to Telegram")
        return 0
    if kind == "pending":
        echo(f"T1 result still not ready: {t1}")
        return 0
    next_t1 = _tomorrow_t1(day, root, echo) if with_tomorrow else None
    text = result.render_t1_followup(t1, next_t1)
    echo(text)
    if not telegram:
        return 0
    if send(text):
        result.mark_sent(adaptive, root, "t1")
        return 0
    echo("Telegram delivery of the T1 result failed; it is not marked sent")
    return 2
