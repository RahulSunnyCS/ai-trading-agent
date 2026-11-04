"""T1's drawdown line in the evening message (owner, 2026-11-04): how deep it is now, from which
high, and how often the last two years were at least that deep."""

from __future__ import annotations

from datetime import date

import pytest

from option_backtesting.rotation import deliver, journal, messages, standing, store, tomorrow

T1 = ["N_ditm1-t1s36_0947", "N_p150-t1s11_0917", "N_p150-t1s11_1317"]
CORE = ["N_ditm1_0917", "N_wide_1117", "N_p100_1202"]


@pytest.fixture(autouse=True)
def groups(monkeypatch):
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "123")
    monkeypatch.setenv("TELEGRAM_ROTATION_CHAT_ID", "-456")


def _day(root, day, total, core=T1, track="t1", score=True):
    """One journal day whose picks add up to `total` (the first pick carries it)."""
    journal.append(
        store.journal_path(root, track),
        {
            "day": day.isoformat(),
            "weekday": day.strftime("%a"),
            "before_first_entry": True,
            "dte": {"NIFTY": "2", "SENSEX": "4"},
            "dte_basis": "weekdays",
            "lists": {"C": {"core": core, "buy": []}},
        },
    )
    if score:
        for name, value in zip(core, [total, 0.0, 0.0], strict=True):
            store.append_result(name, {"day": day.isoformat(), "net": value, "gross": value}, root)


def _series(*values):
    return [(date(2026, 1, 1 + i), v) for i, v in enumerate(values)]


def test_measure_reads_the_drawdown_from_the_running_high():
    s = standing.measure(_series(1000, -400, 800, -600, -500))
    # running totals 1000, 600, 1400, 800, 300: the high is the third day, 1,100 below it now
    assert (s.drawdown, s.high_day, s.days) == (1100, date(2026, 1, 3), 5)
    # drawdowns 0, 400, 0, 600, 1100: only today is at least 1,100 deep; three days under water
    assert (s.at_least, s.under_water, s.deepest, s.deepest_day) == (1, 3, 1100, date(2026, 1, 5))


def test_measure_at_a_new_high_and_below_the_zero_start():
    high = standing.measure(_series(-200, 500))
    assert (high.drawdown, high.at_least, high.under_water) == (0, 0, 1)
    low = standing.measure(_series(-200, -100))  # never above the zero start
    assert (low.drawdown, low.high_day, low.at_least) == (300, None, 1)
    assert standing.measure([]) is None


def test_t1_joins_rederived_days_and_journal_days(tmp_path):
    root = tmp_path / "TradingData"
    for name, value in zip(T1, [700.0, 0.0, 0.0], strict=True):  # a re-derived day before it
        store.append_result(name, {"day": "2026-10-16", "net": value, "gross": value}, root)
    _day(root, date(2026, 10, 19), -300.0)
    _day(root, date(2026, 10, 20), 0.0, score=False)  # not scored: left out, never zero
    _day(root, date(2026, 10, 21), -600.0)
    s = standing.t1(date(2026, 10, 21), root, slip=0, earlier={date(2026, 10, 16): T1})
    assert (s.drawdown, s.high_day, s.days, s.left_out) == (900, date(2026, 10, 16), 3, 1)
    assert (s.first_day, s.recorded_from, s.at_least) == (date(2026, 10, 16), date(2026, 10, 19), 1)


def test_no_standing_until_todays_result_is_stored(tmp_path):
    root = tmp_path / "TradingData"
    _day(root, date(2026, 10, 19), 500.0)
    _day(root, date(2026, 10, 20), 0.0, score=False)
    assert standing.t1(date(2026, 10, 20), root, slip=0, earlier={}) is None


def test_the_window_is_the_last_two_years(tmp_path):
    root = tmp_path / "TradingData"
    old, recent = date(2024, 9, 2), date(2026, 10, 16)  # 2024-09-02 is more than 730 days back
    early = date(2024, 10, 21)  # two days after the window opens (730 days back is a Saturday)
    for d, v in ((old, 5000.0), (early, 0.0), (recent, 100.0)):
        for name, value in zip(T1, [v, 0.0, 0.0], strict=True):
            store.append_result(name, {"day": d.isoformat(), "net": value, "gross": value}, root)
    _day(root, date(2026, 10, 19), -50.0)
    s = standing.t1(date(2026, 10, 19), root, slip=0, earlier={old: T1, recent: T1})
    assert (s.first_day, s.days, s.drawdown, s.window_full) == (recent, 2, 50, False)
    s = standing.t1(date(2026, 10, 19), root, slip=0, earlier={early: T1, recent: T1})
    assert s.window_full  # the first stored day is within a week of the window's start


def test_the_lines():
    s = standing.Standing(
        day=date(2026, 11, 4),
        drawdown=21504.4,
        high_day=date(2026, 10, 26),
        days=440,
        at_least=15,
        under_water=292,
        deepest=32385.8,
        deepest_day=date(2026, 10, 5),
        first_day=date(2025, 1, 10),
        left_out=0,
        recorded_from=date(2026, 10, 19),
        slippage_pct=0.5,
    )
    assert messages.standing_lines(s) == [
        "📉 Tuned Adaptive drawdown −₹21,504 from its high on Mon 26 Oct",
        "   in the last 2 years: this deep or deeper on 3% of days",
        "   (440 trading days since 10 Jan 2025, all the data there is)",
        "   below a high on 66% · deepest −₹32,386 (Oct 2026)",
        "   paper, 1 lot per strategy, 0.5% slippage; picks before Mon 19 Oct re-derived",
    ]
    gaps = standing.Standing(**{**s.__dict__, "left_out": 2})
    assert messages.standing_lines(gaps)[-1].endswith("re-derived; 2 days without results left out")
    full = standing.Standing(**{**s.__dict__, "window_full": True, "days": 500})
    assert messages.standing_lines(full)[2] == "   (500 trading days since 10 Jan 2025)"
    top = standing.Standing(**{**s.__dict__, "drawdown": 0.0, "at_least": 0})
    assert messages.standing_lines(top)[0] == "📈 Tuned Adaptive at a new high today"
    assert messages.standing_lines(None) == []


def _evening(root, monkeypatch, day):
    nxt = tomorrow.NextPicks(date(2026, 11, 5), "Thu", CORE, [], None, None)
    monkeypatch.setattr(tomorrow, "next_session_picks", lambda today, root=None, track=None: nxt)
    monkeypatch.setattr(deliver, "message_boost", lambda: {"adaptive": False, "t1": False})
    monkeypatch.setattr(standing, "_earlier_picks", lambda root, start, until: {})
    sent = []

    def send(text, severity="info", chat_id=None):
        sent.append((chat_id, text))
        return True

    code = deliver.send_result(
        day, root=root, send=send, echo=lambda m: None, alert=lambda title, body: None
    )
    return code, {chat: text for chat, text in sent}


def test_both_copies_carry_the_line_after_the_month(tmp_path, monkeypatch):
    root = tmp_path / "TradingData"
    for d, v in ((date(2026, 11, 2), 900.0), (date(2026, 11, 3), -300.0)):
        _day(root, d, v, core=CORE, track=None)
        _day(root, d, v)
    code, sent = _evening(root, monkeypatch, date(2026, 11, 3))
    assert code == 0
    for text in (sent[None], sent["-456"]):
        assert "📉 Tuned Adaptive drawdown −₹300 from its high on Mon 2 Nov" in text
        assert text.index("📅 November") < text.index("📉 Tuned") < text.index("➡️ Thu 5 Nov")


def test_a_failure_leaves_the_line_out_never_the_message(tmp_path, monkeypatch):
    root = tmp_path / "TradingData"
    _day(root, date(2026, 11, 2), 900.0, core=CORE, track=None)
    _day(root, date(2026, 11, 2), 900.0)

    def broken(*a, **k):
        raise OSError("disk gone")

    monkeypatch.setattr(standing, "t1", broken)
    code, sent = _evening(root, monkeypatch, date(2026, 11, 2))
    assert code == 0 and "🧪 Tuned Adaptive" in sent[None] and "drawdown" not in sent[None]


def test_the_ladder_names_the_depth_each_share_of_days_reached():
    drawdowns = [float(x) for x in range(100)]  # 0 .. 99, one day each
    assert standing.ladder(drawdowns) == ((25, 75.0), (10, 90.0), (5, 95.0))
    assert standing.ladder([0.0, 0.0, 500.0]) == ((25, 500.0), (10, 500.0), (5, 500.0))
    assert standing.ladder([]) == ()
    s = standing.measure(_series(1000, -400, 800, -600, -500))
    assert s.ladder == ((25, 600.0), (10, 1100.0), (5, 1100.0))
    assert (
        messages.standing_lines(s)[4] == "   25% of days −₹600 or deeper · 10% −₹1,100 · 5% −₹1,100"
    )


def test_keep_writes_the_daily_series(tmp_path):
    import csv

    root = tmp_path / "TradingData"
    _day(root, date(2026, 10, 19), 500.0)
    _day(root, date(2026, 10, 20), -800.0)
    s = standing.t1(date(2026, 10, 20), root, slip=0, earlier={}, keep=True)
    with standing.series_path(root).open() as f:
        rows = list(csv.DictReader(f))
    assert [(r["day"], r["net"], r["total"], r["high"], r["drawdown"]) for r in rows] == [
        ("2026-10-19", "500.00", "500.00", "500.00", "0.00"),
        ("2026-10-20", "-800.00", "-300.00", "500.00", "800.00"),
    ]
    assert rows[0]["picks"] == " ".join(T1)
    assert s.drawdown == 800
    assert not list(standing.series_path(root).parent.glob("*.tmp"))
