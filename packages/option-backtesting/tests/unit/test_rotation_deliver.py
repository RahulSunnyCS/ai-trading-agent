"""When the rotation messages are sent (BL-125): the morning records the day's entries and sends
nothing (owner, 2026-11-09: the evening's list is the source of truth), and the evening message's
sent markers make a retry safe and a late T1 result deliverable."""

from __future__ import annotations

import time as clock
from datetime import date, datetime, time

import pytest

from option_backtesting.rotation import deliver, journal, store, tomorrow
from option_backtesting.rotation import pick as pick_mod
from option_backtesting.rotation import result as rotation_result
from option_backtesting.rotation.deliver import IST
from option_backtesting.rotation.journal import AlreadyRecorded

DAY = date(2026, 10, 20)
LIVE_CORE = ["N_ditm1_0917", "N_wide_1117", "N_p100_1202"]
T1_CORE = ["N_ditm1-t1s36_0947", "N_p150-t1s11_0917", "N_p150-t1s11_1317"]


@pytest.fixture(autouse=True)
def groups(monkeypatch):
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "123")
    monkeypatch.setenv("TELEGRAM_ROTATION_CHAT_ID", "-456")


class Sent:
    """Records every message: (chat, text); `fail` makes the sends to a chat fail; `events` (shared
    with a Recorder) keeps the order of sends and records."""

    def __init__(self, events=None, pause=0.0):
        self.messages: list[tuple[str | None, str]] = []
        self.fail: set[str | None] = set()
        self.events = events if events is not None else []
        self.pause = pause

    def __call__(self, text, severity="info", chat_id=None):
        clock.sleep(self.pause)
        self.messages.append((chat_id, text))
        self.events.append(("send", chat_id))
        return chat_id not in self.fail

    def to(self, chat):
        return [t for c, t in self.messages if c == chat]


# -- morning ------------------------------------------------------------------------------------


def _entry(core, track=None, **extra):
    entry = {
        "day": DAY.isoformat(),
        "weekday": "Tue",
        "vix_open": 14.01,
        "vix_source": "fyers",
        "lists": {"C": {"core": core, "buy": []}},
        "hash": "f1a772478960abcd" if track is None else "aaaaaaaa22222222",
        "recorded_at": f"{DAY.isoformat()}T09:16:25+05:30",
        "before_first_entry": True,
        **extra,
    }
    if track:
        entry["track"] = track
    return entry


class Recorder:
    """A stand-in for `pick.record`: returns a result per track or raises what it was given."""

    def __init__(self, live=None, t1=None):
        self.live_outcome = live if live is not None else _entry(LIVE_CORE)
        #: queue of outcomes for T1 calls: an entry (success) or an exception to raise
        self.t1_outcomes = [t1 if t1 is not None else _entry(T1_CORE, track="t1")]
        self.calls: list[dict] = []

    def __call__(self, day, **kw):
        self.calls.append({"day": day, **kw})
        if kw.get("track"):
            outcome = self.t1_outcomes.pop(0) if len(self.t1_outcomes) > 1 else self.t1_outcomes[0]
        else:
            outcome = self.live_outcome
        if isinstance(outcome, Exception):
            raise outcome
        return pick_mod.PickResult(outcome, pick_mod.render(outcome, None), None)


def _run(recorder, alerts=None, catch_up=None, printed=None, **kw):
    alerts = alerts if alerts is not None else []
    kw.setdefault("with_t1", True)
    return deliver.record_day(
        DAY,
        record_fn=recorder,
        alert=lambda title, body: alerts.append((title, body)),
        catch_up=catch_up or (lambda t, root=None: (0, 0)),
        echo=(printed.append if printed is not None else lambda m: None),
        err=lambda m: None,
        **kw,
    )


@pytest.fixture
def no_telegram(monkeypatch):
    """Fails the test if anything in the morning reaches Telegram's sender."""
    from option_backtesting import notify

    monkeypatch.setattr(
        notify, "send", lambda *a, **k: pytest.fail("the morning must send no message")
    )


def test_the_morning_records_adaptive_then_t1_and_sends_no_message(no_telegram):
    rec, alerts, printed = Recorder(), [], []
    assert _run(rec, alerts, printed=printed) == 0
    assert [c["track"] for c in rec.calls] == [None, "t1"] and alerts == []
    # printed for the job log only
    assert printed[0].startswith("🎯 ADAPTIVE · Tue 20 Oct")
    assert printed[1].startswith("🧪 Tuned Adaptive (In Testing phase) · Tue 20 Oct")
    # each list ranks with its own evening VIX: no live read is handed from one to the other
    assert all(c["vix_open"] is None for c in rec.calls)


def test_a_failed_t1_alerts_the_owner_and_the_job_retries(no_telegram):
    rec = Recorder()
    rec.t1_outcomes = [pick_mod.PickError("the t1 track lacks results for 1 day(s)")]
    alerts = []
    assert _run(rec, alerts) == 2
    assert alerts == [
        (
            "T1 TRACK Rotation pick NOT recorded for 2026-10-20",
            "the t1 track lacks results for 1 day(s)",
        )
    ]


def test_an_unexpected_t1_failure_alerts_as_failed(no_telegram):
    rec = Recorder()
    rec.t1_outcomes = [KeyError("dte")]
    alerts = []
    assert _run(rec, alerts) == 2
    assert alerts[0][0] == "T1 TRACK Rotation pick FAILED for 2026-10-20"


def test_missing_t1_results_are_stored_then_t1_is_recorded(no_telegram):
    rec = Recorder()
    rec.t1_outcomes = [
        pick_mod.PickError("lacks results: run `obt rotation update --track t1`"),
        _entry(T1_CORE, track="t1"),
    ]
    alerts, caught = [], []
    catch = lambda t, root=None: caught.append(t) or (1, 0)  # noqa: E731
    assert _run(rec, alerts, catch_up=catch) == 0
    assert caught == ["t1"] and alerts == []
    assert [c["track"] for c in rec.calls] == [None, "t1", "t1"]


def test_a_dry_run_never_stores_missing_t1_results_and_alerts_nothing(no_telegram):
    rec = Recorder()
    rec.t1_outcomes = [pick_mod.PickError("lacks results: run `obt rotation update --track t1`")]
    alerts, caught = [], []
    catch = lambda t, root=None: caught.append(t) or (1, 0)  # noqa: E731
    assert _run(rec, alerts, catch_up=catch, dry_run=True) == 2
    assert caught == [] and alerts == []
    assert all(call["dry_run"] for call in rec.calls)


def test_a_failed_adaptive_entry_alerts_and_t1_is_not_tried(no_telegram):
    rec = Recorder(live=pick_mod.PickError("no India VIX close or open"))
    alerts = []
    assert _run(rec, alerts) == 2
    assert alerts == [("Rotation pick NOT recorded for 2026-10-20", "no India VIX close or open")]
    assert [c["track"] for c in rec.calls] == [None]


def test_a_retry_completes_only_what_is_missing(no_telegram):
    rec = Recorder(live=AlreadyRecorded("done"))
    printed = []
    assert _run(rec, printed=printed) == 0
    assert printed[0].startswith("already recorded")
    rec = Recorder(live=AlreadyRecorded("done"), t1=AlreadyRecorded("done"))
    assert _run(rec) == 0


def test_no_telegram_turns_the_failure_alert_off(no_telegram):
    rec = Recorder(live=RuntimeError("boom"))
    alerts = []
    assert _run(rec, alerts, telegram=False) == 2 and alerts == []


def test_a_track_entry_on_its_own_records_only_that_track(no_telegram):
    rec = Recorder()
    assert _run(rec, track="t1", with_t1=False) == 0
    assert [c["track"] for c in rec.calls] == ["t1"]


def _at(hh, mm, ss, micro=0):
    return lambda: datetime(2026, 10, 20, hh, mm, ss, micro, tzinfo=IST)


# -- evening ------------------------------------------------------------------------------------


def _write(root, names, value=100.0):
    for name in names:
        store.append_result(name, {"day": DAY.isoformat(), "net": value, "gross": value}, root)


def _journal(root, core, track=None):
    return journal.append(
        store.journal_path(root, track),
        {
            "day": DAY.isoformat(),
            "weekday": "Tue",
            "before_first_entry": True,
            "lists": {"C": {"core": core, "buy": []}},
        },
    )


@pytest.fixture
def evening(tmp_path, monkeypatch):
    root = tmp_path / "TradingData"
    _journal(root, LIVE_CORE)
    _write(root, LIVE_CORE)
    nxt = tomorrow.NextPicks(date(2026, 10, 21), "Wed", LIVE_CORE, [], None, None)
    t1_next = tomorrow.NextPicks(date(2026, 10, 21), "Wed", T1_CORE, [], None, None)
    monkeypatch.setattr(
        tomorrow,
        "next_session_picks",
        lambda today, root=None, track=None: t1_next if track else nxt,
    )
    return root


def _t1_ready(root):
    _journal(root, T1_CORE, "t1")
    _write(root, T1_CORE, -50.0)


def _send(root, sent, **kw):
    kw.setdefault("echo", lambda m: None)
    kw.setdefault("alert", lambda title, body: None)  # never the real Telegram
    return deliver.send_result(DAY, root=root, send=sent, **kw)


def test_the_evening_message_has_both_lists_and_tomorrow_and_a_retry_sends_nothing(evening):
    _t1_ready(evening)
    sent = Sent()
    assert _send(evening, sent) == 0
    private, group = sent.to(None)[0], sent.to("-456")[0]
    assert (
        "🎯 Adaptive   +₹300" in private
        and "🧪 Tuned Adaptive (In Testing phase)   −₹150" in private
    )
    assert "➡️ Wed 21 Oct" in private and private.rstrip().endswith("MTMSL4000")
    assert group == private  # no live capture here, so nothing is the owner's alone
    assert _send(evening, sent) == 0  # a retry
    assert len(sent.messages) == 2


def test_t1_not_ready_waits_until_the_deadline_then_goes_without_it_and_t1_follows_later(evening):
    _journal(evening, T1_CORE, "t1")  # recorded this morning; its strategies are not scored yet
    sent = Sent()
    before = lambda: datetime(2026, 10, 20, 16, 5, tzinfo=IST)  # noqa: E731
    after = lambda: datetime(2026, 10, 20, 16, 25, tzinfo=IST)  # noqa: E731
    until = time(16, 25)
    assert _send(evening, sent, wait_until=until, now_fn=before) == 2
    assert sent.messages == []  # nothing yet: the scheduler retries in five minutes
    assert _send(evening, sent, wait_until=until, now_fn=after) == 0
    assert (
        "🧪 Tuned Adaptive (In Testing phase) · result not ready" in sent.to(None)[0]
        and "🧪 Tuned Adaptive (In Testing phase) · not ready" not in sent.to(None)[0]
    )
    assert "· result not ready" in sent.to("-456")[0]
    assert len(sent.messages) == 2
    # still not scored: a later run says so and sends nothing
    assert _send(evening, sent) == 0 and len(sent.messages) == 2
    # the results arrive: T1 follows on its own, once, to the owner and then the group
    _write(evening, T1_CORE, -50.0)
    assert _send(evening, sent) == 0
    (c1, follow), (c2, again) = sent.messages[-2:]
    assert (c1, c2) == (None, "-456") and again == follow
    assert follow.startswith("📊 Tue 20 Oct · Tuned Adaptive result")
    assert "🎯" not in follow and "−₹150" in follow
    assert _send(evening, sent) == 0 and len(sent.messages) == 4  # and never again


def test_a_manual_run_does_not_wait(evening):
    _journal(evening, T1_CORE, "t1")
    sent = Sent()
    assert _send(evening, sent) == 0 and len(sent.messages) == 2


def test_no_t1_entry_means_the_message_says_so_and_nothing_follows(evening):
    sent = Sent()
    assert _send(evening, sent, wait_until=time(16, 25)) == 0  # no waiting for what will not come
    assert "🧪 Tuned Adaptive (In Testing phase) · not recorded today" in sent.to(None)[0]
    _t1_ready(evening)  # even if T1 shows up afterwards, Adaptive's message is not repeated
    assert _send(evening, sent) == 0
    assert len(sent.messages) == 2


def test_adaptive_not_scored_yet_is_not_ready_and_sends_nothing(evening):
    store.result_path("N_p100_1202", evening).unlink()
    sent = Sent()
    assert _send(evening, sent) == 2 and sent.messages == []


def test_a_failed_group_copy_is_retried_alone_and_the_owner_is_not_sent_it_twice(evening):
    _t1_ready(evening)
    sent = Sent()
    sent.fail.add("-456")
    assert _send(evening, sent) == 2
    sent.fail.clear()
    assert _send(evening, sent) == 0
    assert len(sent.to(None)) == 1 and len(sent.to("-456")) == 2


def test_a_failed_owner_message_is_retried_whole(evening):
    _t1_ready(evening)
    sent = Sent()
    sent.fail.add(None)
    assert _send(evening, sent) == 2
    sent.fail.clear()
    assert _send(evening, sent) == 0
    assert len(sent.to(None)) == 2 and len(sent.to("-456")) == 1


def test_a_missing_tomorrow_never_stops_the_result(evening, monkeypatch):
    _t1_ready(evening)

    def boom(*a, **k):
        raise RuntimeError("no history")

    monkeypatch.setattr(tomorrow, "next_session_picks", boom)
    sent = Sent()
    assert _send(evening, sent) == 0
    assert "➡️" not in sent.to(None)[0] and "🎯 Adaptive   +₹300" in sent.to(None)[0]


def test_t1s_tomorrow_failing_alone_says_not_ready(evening, monkeypatch):
    _t1_ready(evening)
    real = tomorrow.next_session_picks

    def picks(today, root=None, track=None):
        if track:
            raise RuntimeError("t1 history short")
        return real(today, root, track)

    monkeypatch.setattr(tomorrow, "next_session_picks", picks)
    sent = Sent()
    assert _send(evening, sent) == 0
    assert sent.to(None)[0].rstrip().endswith("🧪 Tuned Adaptive (In Testing phase) · not ready")


def test_force_resends_everything_and_no_telegram_sends_and_marks_nothing(evening):
    _t1_ready(evening)
    sent = Sent()
    assert _send(evening, sent, telegram=False) == 0 and sent.messages == []
    assert _send(evening, sent) == 0 and len(sent.messages) == 2
    assert _send(evening, sent, force=True) == 0 and len(sent.messages) == 4


def test_no_tomorrow_flag_leaves_the_section_out(evening):
    _t1_ready(evening)
    sent = Sent()
    assert _send(evening, sent, with_tomorrow=False) == 0
    assert "➡️" not in sent.to(None)[0]


def test_markers_are_per_destination_and_keyed_on_the_live_entry(evening):
    done = rotation_result.calculate(DAY, evening)
    for kind in ("", "group", "t1"):
        assert not rotation_result.was_sent(done, evening, kind)
        rotation_result.mark_sent(done, evening, kind)
        assert rotation_result.was_sent(done, evening, kind)
    names = sorted(p.name for p in (store.rotation_dir(evening) / "result-notifications").iterdir())
    assert [n[len("2026-10-20-") + 16 :] for n in names] == [".group.sent", ".sent", ".t1.sent"]


# -- evening robustness (review S2, S3, old markers) ---------------------------------------------


def test_an_unreadable_t1_never_stops_adaptives_result_and_t1_follows_once_fixed(evening):
    _t1_ready(evening)
    path = store.journal_path(evening, "t1")
    good = path.read_text()
    path.write_text(good + '{"day": "2026-10-21", "lis')  # a torn line: JournalCorrupt
    sent, errors, alerts = Sent(), [], []
    run = _send(
        evening,
        sent,
        wait_until=time(16, 25),
        now_fn=_at(16, 0, 0),
        err=errors.append,
        alert=lambda title, body: alerts.append((title, body)),
    )
    assert run == 0
    owner, group = sent.to(None)[0], sent.to("-456")[0]
    assert (
        "🎯 Adaptive   +₹300" in owner
        and "🧪 Tuned Adaptive (In Testing phase) · result not ready" in owner
    )
    assert "🎯 Adaptive   +₹300" in group
    assert errors and "JournalCorrupt" in errors[0]
    # the owner is told, once, why T1 is missing
    assert len(alerts) == 1 and alerts[0][0] == "T1 TRACK result for 2026-10-20 could not be read"
    assert "JournalCorrupt" in alerts[0][1]
    # T1 stays owed: once the journal is readable again, it follows on its own
    path.write_text(good)
    assert _send(evening, sent) == 0
    assert sent.messages[-1][1].startswith("📊 Tue 20 Oct · Tuned Adaptive result")
    assert [c for c, _ in sent.messages[2:]] == [None, "-456"]


def test_a_broken_t1_results_row_is_an_error_not_a_crash(evening, monkeypatch):
    _journal(evening, T1_CORE, "t1")
    real = store.read_net

    def torn(name, root=None):
        if "-t1" in name:
            raise ValueError("could not convert string to float: ''")
        return real(name, root)

    monkeypatch.setattr(store, "read_net", torn)
    sent = Sent()
    assert _send(evening, sent, err=lambda m: None) == 0
    assert "🧪 Tuned Adaptive (In Testing phase) · result not ready" in sent.to(None)[0]
    done = rotation_result.calculate(DAY, evening)
    assert not rotation_result.was_sent(done, evening, "t1")


def test_two_overlapping_runs_send_the_evening_message_once(evening):
    import threading

    _t1_ready(evening)
    sent = Sent(pause=0.2)  # a slow Telegram widens the window the lock has to close
    codes: list[int] = []
    runs = [threading.Thread(target=lambda: codes.append(_send(evening, sent))) for _ in range(3)]
    for run in runs:
        run.start()
    for run in runs:
        run.join()
    assert codes == [0, 0, 0]
    assert len(sent.to(None)) == 1 and len(sent.to("-456")) == 1


def test_a_held_lock_makes_a_second_run_wait(evening):
    import threading

    _t1_ready(evening)
    sent = Sent()
    with rotation_result.sending_lock(DAY, evening):
        run = threading.Thread(target=lambda: _send(evening, sent))
        run.start()
        run.join(0.3)
        assert run.is_alive() and sent.messages == []
    run.join(5)
    assert len(sent.messages) == 2


def test_a_print_only_run_takes_no_lock_and_writes_nothing(evening):
    _t1_ready(evening)
    sent = Sent()
    folder = store.rotation_dir(evening) / "result-notifications"
    assert _send(evening, sent, telegram=False) == 0
    assert not folder.exists() and sent.messages == []


def test_a_day_marked_under_the_old_scheme_is_not_sent_again_in_part(evening):
    """Before BL-125 one `.sent` marker covered the owner and the group; it still does."""
    _t1_ready(evening)
    done = rotation_result.calculate(DAY, evening)
    marker = rotation_result.sent_marker(done, evening)
    marker.parent.mkdir(parents=True)
    marker.write_text(rotation_result.LEGACY_MARKER_TEXT)
    sent = Sent()
    assert _send(evening, sent) == 0
    assert sent.messages == []  # no group copy, no T1 follow-up
    # a marker written by the new scheme covers the owner only
    marker.write_text("owner: sent\n")
    assert _send(evening, sent) == 0
    # the group copy it had not had, and T1, owed, on its own, in the same run
    assert [c for c, _ in sent.messages] == ["-456", None]
    assert _send(evening, sent) == 0
    assert [c for c, _ in sent.messages] == ["-456", None]  # nothing more


def test_a_group_that_keeps_failing_never_holds_back_the_owners_t1_result(evening):
    """The bot was removed from the friends' group: the owner still gets everything."""
    _journal(evening, T1_CORE, "t1")  # T1 recorded, results not stored yet
    sent = Sent()
    sent.fail.add("-456")
    # past the deadline: Adaptive goes to the owner without T1; the group copy fails
    assert _send(evening, sent, wait_until=time(16, 25), now_fn=_at(16, 30, 0)) == 2
    assert "🧪 Tuned Adaptive (In Testing phase) · result not ready" in sent.to(None)[0]
    _write(evening, T1_CORE, -50.0)  # the T1 results arrive (the 21:00 catch-up)
    assert _send(evening, sent) == 2  # the group still fails, so the job still says so
    owner = sent.to(None)
    assert len(owner) == 2 and owner[1].startswith("📊 Tue 20 Oct · Tuned Adaptive result")
    assert _send(evening, sent) == 2
    assert len(sent.to(None)) == 2  # T1 is never sent twice while the group keeps failing


def test_a_group_t1_followup_that_fails_is_retried_alone(evening):
    _journal(evening, T1_CORE, "t1")  # T1 recorded, results not stored yet
    sent = Sent()
    assert _send(evening, sent) == 0  # both chats get Adaptive with T1 not ready
    _write(evening, T1_CORE, -50.0)
    sent.fail.add("-456")
    assert _send(evening, sent) == 2  # the owner has T1's result; the group's copy failed
    sent.fail.clear()
    assert _send(evening, sent) == 0
    assert [c for c, _ in sent.messages] == [None, "-456", None, "-456", "-456"]
    assert _send(evening, sent) == 0 and len(sent.messages) == 5


def test_a_group_owed_t1_is_settled_without_a_message_when_t1_has_no_entry(evening):
    done = rotation_result.calculate(DAY, evening)  # no T1 journal: kind "none"
    for kind in ("", "group", "t1", "group-t1-owed"):
        rotation_result.mark_sent(done, evening, kind)
    sent = Sent()
    assert _send(evening, sent) == 0 and sent.messages == []
    assert rotation_result.was_sent(done, evening, "group-t1")


def test_a_group_copy_sent_before_it_carried_t1_is_owed_no_followup(evening):
    """Before 2026-10-28 the group's evening copy had no T1 part: such a day owes the group nothing."""
    _journal(evening, T1_CORE, "t1")
    done = rotation_result.calculate(DAY, evening)
    rotation_result.mark_sent(done, evening)
    rotation_result.mark_sent(done, evening, "group")
    _write(evening, T1_CORE, -50.0)
    sent = Sent()
    assert _send(evening, sent) == 0
    assert [c for c, _ in sent.messages] == [None]  # the owner's T1 follow-up only


def test_before_not_before_the_evening_run_sends_nothing_and_after_it_sends(evening):
    _t1_ready(evening)
    sent = Sent()
    assert _send(evening, sent, not_before=time(16, 0), now_fn=_at(15, 56, 0)) == 0
    assert sent.messages == []
    folder = store.rotation_dir(evening) / "result-notifications"
    assert not folder.exists() or not any(folder.glob("*.sent"))
    # a late retry of the evening run (17:15): the result goes out at once
    assert _send(evening, sent, not_before=time(16, 0), now_fn=_at(17, 15, 0)) == 0
    assert len(sent.to(None)) == 1 and len(sent.to("-456")) == 1
    # and the 16:00 job (or the 21:00 one) then finds it sent
    assert _send(evening, sent) == 0 and len(sent.messages) == 2


def test_result_soft_fail_alerts_and_exits_zero(monkeypatch):
    from typer.testing import CliRunner

    from option_backtesting.rotation.cli import rotation_app

    alerts = []
    monkeypatch.setattr(deliver, "send_result", lambda *a, **k: 2)
    monkeypatch.setattr(deliver, "send_alert", lambda title, body: alerts.append(title))
    soft = CliRunner().invoke(rotation_app, ["result", "--day", "2026-10-20", "--soft-fail"])
    assert soft.exit_code == 0 and alerts == [
        "Rotation result for 2026-10-20: not everything was sent (exit 2)"
    ]
    hard = CliRunner().invoke(rotation_app, ["result", "--day", "2026-10-20"])
    assert hard.exit_code == 2 and len(alerts) == 1

    def boom(*a, **k):
        raise ValueError("torn row")

    monkeypatch.setattr(deliver, "send_result", boom)
    soft = CliRunner().invoke(rotation_app, ["result", "--day", "2026-10-20", "--soft-fail"])
    assert soft.exit_code == 0 and len(alerts) == 2


def test_the_evening_keeps_its_lists_for_the_next_mornings_entry(evening):
    _t1_ready(evening)
    assert _send(evening, Sent()) == 0
    saved = rotation_result.read_tentative("2026-10-21", evening)
    assert saved["adaptive"]["core"] == LIVE_CORE and saved["t1"]["core"] == T1_CORE
    assert saved["adaptive"]["sent_on"] == DAY.isoformat()
    # a print-only run keeps nothing
    rotation_result.tentative_path("2026-10-21", evening).unlink()
    assert _send(evening, Sent(), telegram=False) == 0
    assert rotation_result.read_tentative("2026-10-21", evening) == {}


def test_the_margin_block_goes_to_the_owner_only_and_never_holds_the_message(evening, monkeypatch):
    from option_backtesting.rotation import margin_lines

    _t1_ready(evening)
    monkeypatch.setattr(
        margin_lines,
        "owner_lines",
        lambda today, picks, root=None, echo=print: ["🏦 Margin for Wed"],
    )
    sent = Sent()
    assert _send(evening, sent) == 0
    private, group = sent.to(None)[0], sent.to("-456")[0]
    assert private.rstrip().endswith("🏦 Margin for Wed")
    assert "🏦" not in group


def test_a_failing_margin_block_is_left_out(evening, monkeypatch):
    from option_backtesting.rotation import automation_settings

    _t1_ready(evening)

    def broken(*a, **k):
        raise OSError("settings unreadable")

    monkeypatch.setattr(automation_settings, "read", broken)
    sent = Sent()
    assert _send(evening, sent) == 0
    assert "🏦" not in sent.to(None)[0]


def test_a_long_message_gets_the_margin_block_one_line_per_account(evening, monkeypatch):
    from option_backtesting.rotation import margin_lines

    _t1_ready(evening)
    block = [
        "🏦 Margin for Wed",
        "Angel One · T1 3 lots (AlgoTest)",
        "  needs ≈ ₹6 L: " + "x" * 4000,
        "  ✅ fits, ₹1 L spare",
        "Your own strategies on these accounts come on top of these needs.",
    ]
    monkeypatch.setattr(
        margin_lines, "owner_lines", lambda today, picks, root=None, echo=print: block
    )
    sent = Sent()
    assert _send(evening, sent) == 0
    private = sent.to(None)[0]
    assert "Angel One: ✅ fits, ₹1 L spare" in private and "xxxx" not in private
