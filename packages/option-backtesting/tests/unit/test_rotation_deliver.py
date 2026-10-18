"""When the rotation messages are sent (BL-125): one morning message that T1 can never delay or
lose Adaptive from, and an evening message whose sent markers make a retry safe and a late T1
result deliverable."""

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
    """Records every message: (chat, text); `fail` makes the sends to a chat fail."""

    def __init__(self):
        self.messages: list[tuple[str | None, str]] = []
        self.fail: set[str | None] = set()

    def __call__(self, text, severity="info", chat_id=None):
        self.messages.append((chat_id, text))
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

    def __init__(self, live=None, t1=None, delay_t1=0.0):
        self.live = live if live is not None else _entry(LIVE_CORE)
        self.t1 = t1
        self.calls: list[dict] = []
        self.delay_t1 = delay_t1
        #: queue of outcomes for T1 calls: an entry (success) or an exception to raise
        self.t1_outcomes = [self.t1 if self.t1 is not None else _entry(T1_CORE, track="t1")]
        self.live_outcome = self.live

    def __call__(self, day, **kw):
        self.calls.append({"day": day, **kw})
        track = kw.get("track")
        if track:
            clock.sleep(self.delay_t1)
            outcome = self.t1_outcomes.pop(0) if len(self.t1_outcomes) > 1 else self.t1_outcomes[0]
        else:
            outcome = self.live_outcome
        if isinstance(outcome, Exception):
            raise outcome
        return pick_mod.PickResult(outcome, pick_mod.render(outcome, None), None)


def _run(recorder, sent, alerts=None, catch_up=None, **kw):
    alerts = alerts if alerts is not None else []
    kw.setdefault("with_t1", True)
    return deliver.pick_and_send(
        DAY,
        record_fn=recorder,
        send=sent,
        alert=lambda title, body: alerts.append((title, body)),
        catch_up=catch_up or (lambda t: (0, 0)),
        echo=lambda m: None,
        err=lambda m: None,
        **kw,
    )


def test_adaptive_and_t1_go_out_as_one_message_and_the_group_gets_adaptive_alone():
    sent, alerts, rec = Sent(), [], Recorder()
    assert _run(rec, sent, alerts) == 0
    assert len(sent.messages) == 2 and alerts == []
    private, group = sent.to(None)[0], sent.to("-456")[0]
    assert "🎯 ADAPTIVE · Tue 20 Oct" in private and "🧪 T1 · TESTING PHASE · not traded" in private
    assert private.index("ADAPTIVE") < private.index("━━━") < private.index("TESTING PHASE")
    assert private.endswith("🔒 f1a77247 · 09:16")
    assert "🧪" not in group and group.endswith("🔒 f1a77247 · 09:16")
    # T1 is given the live entry's VIX read: one poll, one value, the same recorded source
    live_call, t1_call = rec.calls
    assert live_call["track"] is None and t1_call["track"] == "t1"
    assert (t1_call["vix_open"], t1_call["vix_source"]) == (14.01, "fyers")


def test_an_identical_group_id_sends_once(monkeypatch):
    monkeypatch.setenv("TELEGRAM_ROTATION_CHAT_ID", "123")
    sent = Sent()
    assert _run(Recorder(), sent) == 0
    assert [c for c, _ in sent.messages] == [None]


def test_a_failed_t1_never_delays_or_loses_adaptive_and_still_alerts_the_owner():
    rec = Recorder()
    rec.t1_outcomes = [pick_mod.PickError("the t1 track lacks results for 1 day(s)")]
    sent, alerts = Sent(), []
    assert _run(rec, sent, alerts) == 2  # the job retries
    private = sent.to(None)[0]
    assert private.splitlines()[0] == "🎯 ADAPTIVE · Tue 20 Oct"
    assert "🧪 T1 · TESTING PHASE · not recorded today" in private and len(sent.messages) == 2
    assert alerts == [
        (
            "T1 TRACK Rotation pick NOT recorded for 2026-10-20",
            "the t1 track lacks results for 1 day(s)",
        )
    ]


def test_an_unexpected_t1_failure_alerts_as_failed():
    rec = Recorder()
    rec.t1_outcomes = [KeyError("dte")]
    sent, alerts = Sent(), []
    assert _run(rec, sent, alerts) == 2
    assert alerts[0][0] == "T1 TRACK Rotation pick FAILED for 2026-10-20"
    assert len(sent.messages) == 2  # Adaptive went out anyway


def test_missing_t1_results_are_stored_then_t1_follows_as_its_own_message():
    rec = Recorder()
    rec.t1_outcomes = [
        pick_mod.PickError("lacks results: run `obt rotation update --track t1`"),
        _entry(T1_CORE, track="t1", before_first_entry=False),
    ]
    sent, alerts, caught = Sent(), [], []
    assert _run(rec, sent, alerts, catch_up=lambda t: caught.append(t) or (1, 0)) == 0
    assert caught == ["t1"] and alerts == []
    first, follow = sent.messages[0][1], sent.to(None)[-1]
    assert "not recorded today" in first  # Adaptive did not wait for the catch-up
    assert follow.startswith("⚠️ LATE · not a forward entry\n🧪 T1 · TESTING PHASE · not traded")
    assert "ADAPTIVE" not in follow
    assert sent.to("-456") == [sent.messages[1][1]]  # the group heard about Adaptive only


def test_a_slow_t1_does_not_hold_adaptive_back():
    rec = Recorder(delay_t1=0.4)
    sent = Sent()
    assert _run(rec, sent, t1_wait_s=0.05) == 0
    texts = [t for _, t in sent.messages]
    assert "not recorded today" in texts[0]  # Adaptive first, T1 marked as not recorded yet
    assert texts[-1].startswith("🧪 T1 · TESTING PHASE · not traded · Tue 20 Oct")


def test_a_failed_adaptive_pick_alerts_and_sends_no_message():
    rec = Recorder()
    rec.live_outcome = pick_mod.PickError("missing VIX")
    sent, alerts = Sent(), []
    assert _run(rec, sent, alerts) == 2
    assert sent.messages == []
    assert alerts == [("Rotation pick NOT recorded for 2026-10-20", "missing VIX")]
    assert [c["track"] for c in rec.calls] == [None]  # T1 is not tried without Adaptive


def test_a_retry_after_adaptive_was_recorded_sends_only_the_t1_message():
    rec = Recorder()
    rec.live_outcome = AlreadyRecorded("done")
    sent = Sent()
    assert _run(rec, sent) == 0
    assert len(sent.messages) == 1 and sent.messages[0][0] is None
    assert sent.messages[0][1].startswith("🧪 T1 · TESTING PHASE · not traded · Tue 20 Oct")


def test_a_retry_when_both_are_recorded_sends_nothing():
    rec = Recorder()
    rec.live_outcome = AlreadyRecorded("done")
    rec.t1_outcomes = [AlreadyRecorded("done")]
    sent = Sent()
    assert _run(rec, sent) == 0 and sent.messages == []


def test_a_dry_run_sends_nothing_and_alerts_nothing():
    rec = Recorder()
    rec.t1_outcomes = [RuntimeError("boom")]
    sent, alerts = Sent(), []
    assert _run(rec, sent, alerts, dry_run=True, telegram=True) == 2
    assert sent.messages == [] and alerts == []


def test_a_track_pick_on_its_own_is_private_and_uses_the_t1_layout():
    rec = Recorder()
    sent = Sent()
    assert _run(rec, sent, track="t1", with_t1=False) == 0
    assert [c for c, _ in sent.messages] == [None]
    assert sent.messages[0][1].startswith("🧪 T1 · TESTING PHASE · not traded · Tue 20 Oct")


def test_without_t1_adaptive_goes_to_the_owner_and_the_group():
    sent = Sent()
    assert _run(Recorder(), sent, with_t1=False) == 0
    assert [c for c, _ in sent.messages] == [None, "-456"]
    assert sent.messages[0][1] == sent.messages[1][1]


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
    return deliver.send_result(DAY, root=root, send=sent, **kw)


def test_the_evening_message_has_both_lists_and_tomorrow_and_a_retry_sends_nothing(evening):
    _t1_ready(evening)
    sent = Sent()
    assert _send(evening, sent) == 0
    private, group = sent.to(None)[0], sent.to("-456")[0]
    assert "🎯 Adaptive   +₹300" in private and "🧪 T1         −₹150" in private
    assert "➡️ Wed 21 Oct" in private and private.rstrip().endswith("MTMSL4000")
    assert "🧪" not in group and "➡️ Wed 21 Oct" in group
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
        "🧪 T1 · result not ready" in sent.to(None)[0]
        and "🧪 T1 · not ready" not in sent.to(None)[0]
    )
    assert len(sent.messages) == 2
    # still not scored: a later run says so and sends nothing
    assert _send(evening, sent) == 0 and len(sent.messages) == 2
    # the results arrive: T1 follows on its own, once, to the owner only
    _write(evening, T1_CORE, -50.0)
    assert _send(evening, sent) == 0
    follow = sent.messages[-1]
    assert follow[0] is None and follow[1].startswith("📊 Tue 20 Oct · T1 result")
    assert "Adaptive   +" not in follow[1] and "−₹150" in follow[1]
    assert _send(evening, sent) == 0 and len(sent.messages) == 3  # and never again


def test_a_manual_run_does_not_wait(evening):
    _journal(evening, T1_CORE, "t1")
    sent = Sent()
    assert _send(evening, sent) == 0 and len(sent.messages) == 2


def test_no_t1_entry_means_the_message_says_so_and_nothing_follows(evening):
    sent = Sent()
    assert _send(evening, sent, wait_until=time(16, 25)) == 0  # no waiting for what will not come
    assert "🧪 T1 · not recorded today" in sent.to(None)[0]
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
    assert sent.to(None)[0].rstrip().endswith("🧪 T1 · not ready")


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
