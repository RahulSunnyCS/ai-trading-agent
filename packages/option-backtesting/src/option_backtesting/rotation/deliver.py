"""Sending the rotation Telegram messages (BL-125): what goes to whom, and in what order.

The text itself is `messages.py`; this module decides when it is sent. Nothing here changes what is
picked, scored or journaled: it calls `pick.record` and `result.calculate` exactly as before and
only chooses how their output reaches Telegram.

Morning (`pick_and_send`): Adaptive is recorded first and is never held back by T1. T1 is
recorded right after (reusing the live entry's VIX read); the message carries both when T1 is in by
`t1_deadline` (09:16:50 IST, or 20 s after Adaptive's entry when that is sooner or the run is
later). Otherwise it goes with Adaptive and T1 marked "not recorded today" (or "follows"), a T1
failure alerts the owner, and if T1 records later (after a catch-up of its results, or the job's
retry) it follows as a message of its own. The owner and the friends' group get every one of these
messages alike; alerts stay private.

Evening (`send_result`): one message for both lists plus tomorrow's strategies, under a per-day
lock. See `send_result` for the sent-marker design.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeout
from datetime import date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from . import journal, live_compare, messages, result, store, tomorrow
from . import pick as pick_mod
from .journal import AlreadyRecorded
from .pick import PickError, PickResult

IST = ZoneInfo("Asia/Kolkata")
#: the owner's 09:16 message waits for T1 until this IST time at the latest ...
T1_DEADLINE = time(9, 16, 50)
#: ... and never longer than this after Adaptive's entry is written
T1_MAX_WAIT_S = 20.0

Echo = Callable[[str], None]
#: (text, severity, chat_id or None for the owner's chat) -> delivered
SendText = Callable[..., bool]


def send_text(
    text: str, severity: str = "info", chat_id: str | None = None, kind: str | None = None
) -> bool:
    """One plain-text Telegram message (no icon or source line: the layout is the message's own),
    through the repo's notify path. Returns whether it was delivered. `kind` is its type on the
    Telegram alerts page (BL-173)."""
    from ..notify import Notification, send

    delivered, _ = send(
        Notification(
            source="options-rotation",
            severity=severity,
            title="",
            body=text,
            plain=True,
            type=kind,
        ),
        chat_id=chat_id,
    )
    return delivered


def send_pick_text(text: str, severity: str = "info", chat_id: str | None = None) -> bool:
    """The 09:16 pick's messages, typed `options.pick` (BL-173)."""
    return send_text(text, severity, chat_id, kind="options.pick")


def send_result_text(text: str, severity: str = "info", chat_id: str | None = None) -> bool:
    """The 16:00 result's messages, typed `options.result` (BL-173)."""
    return send_text(text, severity, chat_id, kind="options.result")


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


def _stderr(message: str) -> None:
    print(message, file=sys.stderr)


def _journal_entry(day: date, root: Path | None, track: str | None) -> dict | None:
    path = store.journal_path(root, track)
    return next((e for e in journal.read(path) if e.get("day") == day.isoformat()), None)


# -- morning ------------------------------------------------------------------------------------


def _needs_catch_up(error: Exception, track: str) -> bool:
    return f"obt rotation update --track {track}" in str(error)


def t1_deadline(recorded: datetime) -> datetime:
    """How long the owner's message may wait for T1 once Adaptive's entry is written: until 09:16:50
    IST, and never more than `T1_MAX_WAIT_S` after the entry (a later run, a retry or a run by hand,
    waits those 20 s)."""
    recorded = recorded.astimezone(IST)
    cap = recorded + timedelta(seconds=T1_MAX_WAIT_S)
    clock = datetime.combine(recorded.date(), T1_DEADLINE, tzinfo=IST)
    return min(cap, clock) if recorded < clock else cap


def _default_catch_up(track: str, root: Path | None = None) -> tuple[int, int]:
    from .update import update_track

    return update_track(track, root=root)


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
    send: SendText = send_pick_text,
    alert: Callable[[str, str], None] = send_alert,
    catch_up: Callable[..., tuple[int, int]] | None = None,
    root: Path | None = None,
    now_fn: Callable[[], datetime] = lambda: datetime.now(IST),
) -> int:
    """Record the day's entry and send it. Returns the process exit code (0 ok, 2 not recorded or
    the T1 step failed: the job retries and, for T1, the owner is alerted). A dry run writes
    nothing: no journal entry, no T1 catch-up, no message."""
    err = err or echo
    tag = f"{track.upper()} TRACK " if track else ""
    send_live = telegram and not dry_run
    boost = message_boost()

    def text_of(r: PickResult) -> str:
        return messages.render_entry(r.entry, r.options, boost) if any(boost.values()) else r.text

    def alert_if(title: str, body: str) -> None:
        if send_live:
            alert(tag + title, body)

    def attempt(t: str | None, vix: float | None = None, source: str | None = None):
        """(PickResult | None, error | None, already): one record() with its outcome sorted."""
        try:
            do_record = record_fn or pick_mod.record
            r = do_record(day, vix_open=vix, dry_run=dry_run, track=t, vix_source=source)
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
        echo(text_of(r))
        if send_live:
            send(text_of(r), _severity(r.entry))  # never the friends' group
        return 0

    live, error, live_already = attempt(None, vix_open)
    if error is not None:
        return _failed(error, day, alert_if, err)
    if live_already:  # a retry after a success: the day has its entry (and its message)
        echo(f"already recorded: {day.isoformat()} is already in the journal")
    if not with_t1:
        if live is not None:
            echo(text_of(live))
            if send_live:
                _send_to_all(text_of(live), _severity(live.entry), send)
        return 0

    # What last evening's message listed for today: each list says whether its picks changed.
    previous = result.read_tentative(day, root)

    # T1 next, sharing the live entry's VIX read: one poll, one value.
    entry = live.entry if live else _journal_entry(day, root, None)
    vix = entry.get("vix_open") if entry else None
    source = entry.get("vix_source") if entry else None
    wait_s = max(0.0, (t1_deadline(now_fn()) - now_fn().astimezone(IST)).total_seconds())
    pool = ThreadPoolExecutor(max_workers=1)
    future = pool.submit(attempt, "t1", vix, source)
    try:
        t1, t1_error, t1_already = future.result(timeout=wait_s)
        in_time = True
    except FutureTimeout:
        t1 = t1_error = None
        t1_already = False
        in_time = False

    if live is not None:
        # The message: Adaptive, with T1 beside it when it is in, whatever happens next.
        if in_time and (t1 is not None or t1_already):
            t1_entry = t1.entry if t1 else _journal_entry(day, root, "t1")
            t1_options = t1.options if t1 else None
            text = messages.render_morning(
                live.entry, live.options, t1_entry, t1_options, previous=previous, boost=boost
            )
            echo(text)
            if send_live:
                _send_to_all(text, _severity(live.entry), send)
            pool.shutdown(wait=False)
            return 0
        # Honest about why T1 is missing: still being recorded (slow, or its results are about to
        # be caught up) -> it follows on its own, or an alert says it failed; any other error ->
        # not recorded (alerted below, and the job's retry tries again).
        follows = not in_time or (
            t1_error is not None and _needs_catch_up(t1_error, "t1") and not dry_run
        )
        note = messages.T1_FOLLOWS if follows else messages.T1_NOT_RECORDED
        text = messages.render_morning(
            live.entry, live.options, None, t1_note=note, previous=previous, boost=boost
        )
        echo(text)
        if send_live:
            _send_to_all(text, _severity(live.entry), send)

    # T1 did not make the message. If it records (after a catch-up of its results, or on a retry)
    # it follows as a message of its own; if it fails the owner is alerted and the job retries.
    if not in_time:
        t1, t1_error, t1_already = future.result()
    pool.shutdown(wait=False)
    if t1_error is not None and _needs_catch_up(t1_error, "t1"):
        if dry_run:
            echo(f"T1 track: {t1_error}; a real run would store its missing results (dry run: not)")
        else:
            echo(f"T1 track: {t1_error}; storing its missing results now")
            try:
                (catch_up or _default_catch_up)("t1", root=root)
                t1, t1_error, t1_already = attempt("t1", vix, source)
            except Exception as error:  # noqa: BLE001
                t1_error = error
    if t1_already:
        echo("T1 track: already recorded")
        return 0
    if t1_error is not None:
        return _failed(t1_error, day, lambda t, b: alert_if("T1 TRACK " + t, b), err, tag="T1 ")
    echo(text_of(t1))
    if send_live:
        _send_to_all(text_of(t1), _severity(t1.entry), send)
    return 0


def message_boost() -> dict[str, bool]:
    """BL-183: which lists' messages say the Dir ×2 lots: Settings › Automation, for a platform
    whose `.env` upload switch is on. A message must always go: settings that cannot be read
    leave the lots out, never stop it."""
    from . import automation_settings

    try:
        settings, _ = automation_settings.read()
    except Exception:  # noqa: BLE001
        return {}
    return automation_settings.dir_boost_lists(settings, automation_settings.env_uploads_on())


def message_capital() -> dict[str, float]:
    """The capital the evening message shows (Settings › Automation, owner 2026-10-29):
    {'adaptive', 't1'}: the accounts that upload each list; 'total': every account added up.
    Settings that cannot be read give the defaults: the message must always go."""
    from . import automation_settings as auto

    try:
        settings, _ = auto.read()
    except Exception:  # noqa: BLE001
        settings = auto.DEFAULT
    return {
        "adaptive": auto.book_capital(settings, "core"),
        "t1": auto.book_capital(settings, "t1"),
        "total": sum(auto.capital(settings).values()),
    }


def _real_month(day, capital, root, echo):
    """The owner's real month from the contract notes; None (the lines left out) on any error."""
    try:
        return result.real_month(day, capital, root)
    except Exception as error:  # noqa: BLE001
        echo(f"the real month from the contract notes could not be read: {error}")
        return None


def _severity(entry: dict) -> str:
    return "info" if entry.get("before_first_entry") else "warn"


def _send_to_all(text: str, severity: str, send: SendText) -> bool:
    """The owner's chat, then the friends' group when one is configured."""
    ok = send(text, severity)
    group_id = group_chat_id()
    if group_id:
        ok = send(text, severity, chat_id=group_id) and ok
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


def _t1_state(day: date, root: Path | None, err: Echo):
    """('ready', DailyResult) | ('pending', reason) | ('none', reason) | ('error', reason).

    Any other failure reading T1 (a corrupt T1 journal, a results row read while it is being
    appended) is 'error': logged, never allowed to stop Adaptive's result, and left unsettled so a
    later run delivers T1."""
    try:
        return "ready", result.calculate(day, root, track="t1")
    except result.NoEntry as error:
        return "none", str(error)
    except result.ResultUnavailable as error:
        return "pending", str(error)
    except Exception as error:  # noqa: BLE001 - T1 must never hold Adaptive's result back
        err(f"T1 result could not be read ({type(error).__name__}: {error}); sending without it")
        return "error", f"{type(error).__name__}: {error}"


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
        picks = tomorrow.next_session_picks(today, root, track="t1")
    except Exception as error:  # noqa: BLE001
        echo(f"T1 tomorrow skipped: {type(error).__name__}: {error}")
        return messages.T1_TOMORROW_NOT_READY
    return picks or messages.T1_TOMORROW_NOT_READY


def send_result(
    day: date,
    *,
    telegram: bool = True,
    force: bool = False,
    with_tomorrow: bool = True,
    wait_until: time | None = None,
    not_before: time | None = None,
    echo: Echo = print,
    err: Echo = _stderr,
    now_fn: Callable[[], datetime] = lambda: datetime.now(IST),
    send: SendText = send_result_text,
    alert: Callable[[str, str], None] = send_alert,
    root: Path | None = None,
) -> int:
    """The evening message for `day`. Returns the exit code (0 done or nothing left to send, 2
    not ready: the scheduler retries, and alerts the owner when the retries run out).

    Adaptive is the message. T1 rides along when its results are in. If they are not:

    - the T1 journal has no entry for the day (T1 was not recorded, so nothing will ever be
      scored): the message goes out now saying so, and T1 is settled;
    - the entry exists but its strategies are not all scored yet: until `wait_until` (IST) nothing
      is sent and the exit code is 2, so the scheduler's retry runs again in a few minutes. At or
      after it the message goes out with `messages.T1_RESULT_NOT_READY`, and T1 stays unsettled so
      the next run (a retry, the 21:00 catch-up job, or by hand) sends T1's result as a message of
      its own once it is there;
    - T1 cannot be read at all (an error): the message goes out now with the same note, and T1
      stays unsettled.

    The friends' group gets the same message without the owner's live-vs-paper lines, and a late T1
    result follows to it as it does to the owner. Sent markers (`result.sent_marker`) are per
    destination and per piece, so a retry never sends the owner's chat the same message twice, a
    failed group copy is retried alone, and a late T1 result is still delivered. Deciding, sending
    and marking happen under `result.sending_lock`, so two overlapping runs cannot both send. The
    owner's message goes first; the group copy is sent and retried on its own, so a group that
    fails never holds back the owner's T1 follow-up.

    `not_before` (IST): earlier than it, send nothing and exit 0, because the 16:00 job sends. The
    evening run ends with `result --not-before 16:00`, so a run that only completes on a late retry
    (17:15, ...) still sends that evening; the markers make the two jobs safe together."""
    if (
        telegram
        and not force
        and not_before is not None
        and now_fn().astimezone(IST).time() < not_before
    ):
        echo(f"before {not_before:%H:%M}: the {not_before:%H:%M} job sends the result")
        return 0
    try:
        adaptive = result.calculate(day, root)
    except result.ResultUnavailable as error:
        echo(f"result not ready: {error}")
        return 2
    if not telegram:  # print only: no lock, no marker, nothing written
        return _send_result_locked(
            day,
            adaptive,
            False,
            force,
            with_tomorrow,
            wait_until,
            echo,
            err,
            now_fn,
            send,
            alert,
            root,
        )
    with result.sending_lock(day, root):
        return _send_result_locked(
            day,
            adaptive,
            True,
            force,
            with_tomorrow,
            wait_until,
            echo,
            err,
            now_fn,
            send,
            alert,
            root,
        )


def _send_result_locked(
    day, adaptive, telegram, force, with_tomorrow, wait_until, echo, err, now_fn, send, alert, root
) -> int:
    kind, t1 = _t1_state(day, root, err)
    group_id = group_chat_id()
    marked = telegram and not force

    def done(which: str = "") -> bool:
        return marked and result.was_sent(adaptive, root, which)

    owner_needed = not done()
    group_needed = bool(group_id) and not done("group")
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

    ok = True
    owner_out = done()  # the owner's message is (or, below, becomes) out
    t1_settled = done("t1")
    group_t1_owed = bool(group_id) and done("group-t1-owed") and not done("group-t1")
    if owner_needed or group_needed:
        next_adaptive = _tomorrow_adaptive(day, root, echo) if with_tomorrow else None
        next_t1 = _tomorrow_t1(day, root, echo) if next_adaptive is not None else None
        if kind == "ready":
            t1_part = t1
        elif kind == "none":
            t1_part = messages.T1_RESULT_NOT_RECORDED
        else:  # pending or error
            t1_part = messages.T1_RESULT_NOT_READY
        # BL-141: the day's live slippage, in the owner's copy only (never the friends' group)
        live = live_compare.owner_lines(day, root, echo)
        boost = message_boost()
        capital = message_capital()
        # each list's capital and month to date, in both chats; the real month, the owner's only
        # (owner, 2026-10-29)
        months = result.months_to_date(adaptive, t1_part, root, boost, capital, echo)
        real = _real_month(day, capital["total"], root, echo)
        private = result.render(
            adaptive, t1_part, next_adaptive, next_t1, live, boost=boost, months=months, real=real
        )
        group = result.render(adaptive, t1_part, next_adaptive, next_t1, boost=boost, months=months)
        echo(private)
        if not telegram:
            return 0
        # 1. the owner, always first
        if owner_needed:
            if send(private):
                result.mark_sent(adaptive, root)
                result.save_tentative(day, next_adaptive, next_t1, root)
                owner_out = True
                if kind in ("ready", "none"):
                    result.mark_sent(adaptive, root, "t1")
                    t1_settled = True
                if kind == "error":
                    alert(
                        f"T1 TRACK result for {day} could not be read",
                        f"{t1}\nAdaptive's result went out without it; T1 follows on its own "
                        "once it can be read (the 21:00 job runs the result again).",
                    )
            else:
                ok = False
                err("the owner's result message was not delivered; it is not marked sent")
        # 2. the friends' group, on its own: its failure is retried, never blocks the owner
        if group_needed:
            if send(group, chat_id=group_id):
                result.mark_sent(adaptive, root, "group")
                # settled like the owner's T1; otherwise the group is owed T1's follow-up
                group_t1_owed = kind not in ("ready", "none")
                result.mark_sent(adaptive, root, "group-t1-owed" if group_t1_owed else "group-t1")
            else:
                ok = False
                err("the group copy was not delivered; the next run retries it alone")

    # 3. the T1 result each chat is still owed, once that chat's main message is out
    owed = []
    if owner_out and not t1_settled:
        owed.append((None, "t1"))
    if group_t1_owed:
        owed.append((group_id, "group-t1"))
    if owed and kind == "none":
        for _, marker in owed:
            result.mark_sent(adaptive, root, marker)
    elif owed and kind in ("pending", "error"):
        echo(f"T1 result still not ready: {t1}")
    elif owed:
        next_t1 = _tomorrow_t1(day, root, echo) if with_tomorrow else None
        boost = message_boost()
        month = result.months_to_date(None, t1, root, boost, message_capital(), echo)["t1"]
        text = result.render_t1_followup(t1, next_t1, boost=boost, month=month)
        echo(text)
        for chat, marker in owed:
            if send(text, chat_id=chat):
                result.mark_sent(adaptive, root, marker)
                if chat is None:
                    result.save_tentative(day, None, next_t1, root)
            else:
                ok = False
                err(f"Telegram delivery of the T1 result failed ({marker}); it is not marked sent")
    elif not (owner_needed or group_needed):
        echo("already sent to Telegram")
    return 0 if ok else 2
