"""The evening message's month so far (owner, 2026-10-30): paper per list, the account's real
month in the owner's copy only, from November 2026."""

from __future__ import annotations

from datetime import date

import pytest

from option_backtesting.rotation import deliver, journal, messages, month, store, tomorrow

CORE = ["N_ditm1_0917", "N_wide_1117", "N_p100_1202"]
T1 = ["N_ditm1-t1s36_0947", "N_p150-t1s11_0917", "N_p150-t1s11_1317"]
NON_EXPIRY = {"NIFTY": "2", "SENSEX": "4"}


@pytest.fixture(autouse=True)
def groups(monkeypatch):
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "123")
    monkeypatch.setenv("TELEGRAM_ROTATION_CHAT_ID", "-456")


def _day(root, day, values, core=CORE, track=None, dte=NON_EXPIRY, score=True):
    """One journal day; `values` is each pick's net, in `core` order."""
    journal.append(
        store.journal_path(root, track),
        {
            "day": day.isoformat(),
            "weekday": day.strftime("%a"),
            "before_first_entry": True,
            "dte": dte,
            "dte_basis": "weekdays",
            "lists": {"C": {"core": core, "buy": []}},
        },
    )
    if score:
        for name, value in zip(core, values, strict=True):
            store.append_result(name, {"day": day.isoformat(), "net": value, "gross": value}, root)


def test_nothing_before_november():
    assert month.month_start(date(2026, 10, 30)) is None
    assert month.paper(date(2026, 10, 30)) is None
    assert month.real(date(2026, 10, 30)) is None
    assert month.month_start(date(2026, 11, 3)) == date(2026, 11, 1)
    assert month.month_start(date(2026, 12, 9)) == date(2026, 12, 1)


def test_paper_counts_the_months_scored_days_and_leaves_out_one_still_scoring(tmp_path):
    root = tmp_path / "TradingData"
    _day(root, date(2026, 10, 30), [900, 900, 900])  # last month: not counted
    _day(root, date(2026, 11, 2), [400, -100, 100])  # +400, won
    _day(root, date(2026, 11, 3), [-300, -100, 100])  # -300, lost
    _day(root, date(2026, 11, 4), [0, 0, 0], score=False)  # not scored: left out, never zero
    m = month.paper(date(2026, 11, 4), root)
    assert (m.net, m.days, m.won, m.as_traded) == (100, 2, 1, None)
    assert month.paper(date(2026, 11, 2), root).days == 1  # never a later day


def test_a_dir_x2_list_adds_its_as_traded_month(tmp_path):
    root = tmp_path / "TradingData"
    _day(root, date(2026, 11, 2), [400, -100, 100])  # Dir at 2 lots: +800
    _day(root, date(2026, 11, 3), [-300, -100, 100], dte={"NIFTY": "0", "SENSEX": "2"})  # expiry
    m = month.paper(date(2026, 11, 3), root, boost=True)
    assert (m.net, m.as_traded) == (100, 800 - 300)  # the expiry day is not doubled


def test_real_counts_the_contract_notes_days_with_a_profit(monkeypatch, tmp_path):
    from option_backtesting.realised import views

    calls = []

    def days(root, *, start=None, end=None, account=None):
        calls.append((start, end))
        return {
            "days": [
                {"day": "2026-11-02", "profit": 1500.5},
                {"day": "2026-11-03", "profit": -700.0},
                {"day": "2026-11-04", "profit": None},  # notes still open: not counted
            ]
        }

    monkeypatch.setattr(views, "days", days)
    m = month.real(date(2026, 11, 5), tmp_path)
    assert calls == [(date(2026, 11, 1), date(2026, 11, 5))]
    assert (m.net, m.days, m.won, m.through) == (800.5, 2, 1, date(2026, 11, 3))


def test_month_lines():
    a = month.Month(12340, 13, 9)
    t = month.Month(15100, 13, 10, as_traded=18200)
    r = month.Month(12450, 1, 1, through=date(2026, 11, 2))
    assert messages.month_lines(date(2026, 11, 20), a, t, r) == [
        "📅 November so far · paper, 1 lot per strategy",
        "🎯 Adaptive   +₹12,340 · won 9 of 13 days (69%)",
        "🧪 Tuned Adaptive   +₹15,100 · won 10 of 13 days (77%)",
        "   As traded (Dir ×2): +₹18,200",
        "💰 Your account to Mon 2 Nov   +₹12,450 · won 1 of 1 day (100%)",
    ]
    assert messages.month_lines(date(2026, 11, 20)) == []
    assert messages.month_lines("2026-11-20", real=r)[0] == "📅 November so far"


def _evening(root, monkeypatch, day):
    nxt = tomorrow.NextPicks(date(2026, 11, 4), "Wed", CORE, [], None, None)
    monkeypatch.setattr(tomorrow, "next_session_picks", lambda today, root=None, track=None: nxt)
    monkeypatch.setattr(deliver, "message_boost", lambda: {"adaptive": False, "t1": True})
    sent = []

    def send(text, severity="info", chat_id=None):
        sent.append((chat_id, text))
        return True

    code = deliver.send_result(
        day, root=root, send=send, echo=lambda m: None, alert=lambda title, body: None
    )
    return code, {chat: text for chat, text in sent}


def test_the_owner_gets_paper_and_real_the_group_paper_only(tmp_path, monkeypatch):
    root = tmp_path / "TradingData"
    for d, v in ((date(2026, 11, 2), 300.0), (date(2026, 11, 3), -100.0)):
        _day(root, d, [v, v, v])
        _day(root, d, [v, v, v], core=T1, track="t1")
    monkeypatch.setattr(
        month, "real", lambda day, root=None: month.Month(5000, 1, 1, through=date(2026, 11, 2))
    )
    code, sent = _evening(root, monkeypatch, date(2026, 11, 3))
    assert code == 0
    owner, group = sent[None], sent["-456"]
    for text in (owner, group):
        assert "📅 November so far · paper, 1 lot per strategy" in text
        assert "🎯 Adaptive   +₹600 · won 1 of 2 days (50%)" in text
        assert "🧪 Tuned Adaptive   +₹600 · won 1 of 2 days (50%)" in text
        assert "   As traded (Dir ×2): +₹800" in text  # T1 trades the Dir ×2 rule
        assert text.index("📅 November") < text.index("➡️ Wed 4 Nov")
    assert "💰 Your account to Mon 2 Nov   +₹5,000" in owner
    assert "Your account" not in group


def test_a_failure_leaves_the_month_out_never_the_message(tmp_path, monkeypatch):
    root = tmp_path / "TradingData"
    _day(root, date(2026, 11, 2), [300.0, 300.0, 300.0])

    def broken(*a, **k):
        raise OSError("disk gone")

    monkeypatch.setattr(month, "paper", broken)
    monkeypatch.setattr(month, "real", broken)
    code, sent = _evening(root, monkeypatch, date(2026, 11, 2))
    assert code == 0
    assert "🎯 Adaptive   +₹900" in sent[None] and "so far" not in sent[None]


def test_october_messages_are_unchanged(tmp_path, monkeypatch):
    root = tmp_path / "TradingData"
    _day(root, date(2026, 10, 30), [300.0, 300.0, 300.0])
    code, sent = _evening(root, monkeypatch, date(2026, 10, 30))
    assert code == 0 and "so far" not in sent[None]
