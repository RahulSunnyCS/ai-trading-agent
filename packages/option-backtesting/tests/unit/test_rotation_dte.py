"""Days to expiry counted in weekdays (BL-109): the helper, the stored-day conversion on read, the
journal entry labels, and the live labels."""

from datetime import date
from types import SimpleNamespace

from option_backtesting.rotation import dte, live, store, tomorrow


def test_a_friday_before_a_monday_expiry_is_one_weekday_not_three_days():
    friday = date(2026, 10, 16)
    assert dte.weekdays_after(friday, 3) == 1  # Sat, Sun, Mon
    assert dte.weekdays_between(friday, date(2026, 10, 19)) == 1
    assert dte.weekdays_after(friday, 6) == 4  # Mon to Thu: holidays are not excluded
    assert dte.weekdays_after(date(2026, 10, 19), 1) == 1  # Monday before a Tuesday expiry
    assert dte.weekdays_after(friday, 0) == 0  # the expiry day itself


def test_labels_keep_the_capped_and_unknown_values():
    day = date(2026, 10, 16)
    assert dte.from_calendar_label("3", day) == "1"
    assert dte.from_calendar_label("7+", day) == "7+"
    assert dte.from_calendar_label("unknown", day) == "unknown"
    assert dte.from_calendar_label(0, day) == "0"


def test_stored_days_are_converted_on_read_and_the_file_is_left_as_written(tmp_path):
    store.append_day(
        {
            "day": "2026-10-16",
            "weekday": "Fri",
            "vix_open": "14.2",
            "vix_band": "12-15",
            "dte_n": "3",
            "dte_s": "6",
        },
        tmp_path,
    )
    before = store.days_path(tmp_path).read_text()
    got = store.read_days(tmp_path)[date(2026, 10, 16)]
    assert (got["dte_n"], got["dte_s"]) == ("1", "4")
    assert store.days_path(tmp_path).read_text() == before  # never rewritten
    assert store.read_days(tmp_path)[date(2026, 10, 16)]["dte_n"] == "1"  # and idempotent


def test_a_journal_entry_is_read_on_the_weekday_basis_whichever_it_was_recorded_under():
    legacy = {"day": "2026-10-16", "dte": {"NIFTY": "3", "SENSEX": "6"}}
    assert dte.entry_labels(legacy) == {"NIFTY": "1", "SENSEX": "4"}
    recorded = {**legacy, "dte": {"NIFTY": "1", "SENSEX": "4"}, "dte_basis": "weekdays"}
    assert dte.entry_labels(recorded) == {"NIFTY": "1", "SENSEX": "4"}
    unknown = {"day": "2026-10-16", "dte": {"NIFTY": "unknown"}}
    assert dte.entry_labels(unknown) == {"NIFTY": "unknown", "SENSEX": "unknown"}


def test_the_calendar_labels_for_the_next_session_count_weekdays():
    # NIFTY's 20 Oct expiry moves to Monday 19 Oct for Dussehra; SENSEX expires Thursday 22 Oct
    assert live.calendar_dte_labels(date(2026, 10, 16)) == {"dte_n": "1", "dte_s": "4"}


def test_the_listed_master_labels_count_weekdays(monkeypatch):
    expiries = {"NIFTY": date(2026, 10, 19), "SENSEX": date(2026, 10, 22)}
    monkeypatch.setattr(live, "download_master", lambda segment: segment)
    monkeypatch.setattr(
        live,
        "parse_master",
        lambda raw, names: [
            SimpleNamespace(expiry=expiries[name], option_type="CE") for name in names
        ],
    )
    labels, source = live.listed_dte_labels(date(2026, 10, 16))
    assert source == "master"
    assert labels == {"dte_n": "1", "dte_s": "4"}


def test_calendar_basis_reads_the_labels_as_written(tmp_path):
    store.append_day(
        {
            "day": "2026-10-16",
            "weekday": "Fri",
            "vix_open": "14",
            "vix_band": "12-15",
            "dte_n": "3",
            "dte_s": "6",
        },
        tmp_path,
    )
    raw = store.read_days(tmp_path, "calendar")[date(2026, 10, 16)]
    assert (raw["dte_n"], raw["dte_s"]) == ("3", "6")


def test_readers_of_journal_entries_use_the_weekday_basis_for_a_legacy_entry():
    from option_backtesting.rotation import regime

    legacy = {
        "day": "2026-10-15",
        "before_first_entry": True,
        "weekday": "Thu",
        "vix_open": 14.0,
        "vix_band": "12-15",
        "dte": {"NIFTY": "4", "SENSEX": "0"},  # recorded in calendar days: Thu to Mon 19 Oct
    }
    row = regime._forward_rows([legacy])[date(2026, 10, 15)]
    assert (row["dte_n"], row["dte_s"]) == ("2", "0")
    assert dte.entry_basis(legacy) == "calendar"
    assert dte.recorded_labels(legacy) == {"NIFTY": "4", "SENSEX": "0"}


def _master(monkeypatch, expiries):
    monkeypatch.setattr(live, "download_master", lambda segment: segment)
    monkeypatch.setattr(
        live,
        "parse_master",
        lambda raw, names: [
            SimpleNamespace(expiry=expiries[name], option_type="CE") for name in names
        ],
    )


def _capture_expected(monkeypatch):
    """`expected_picks` stubbed: the labels it is given, and a fixed answer."""
    seen = {}

    def expected(day, root, dte_n, dte_s, last_day, track=None):
        seen.update(day=day, dte_n=dte_n, dte_s=dte_s, last_day=last_day, track=track)
        return SimpleNamespace(picks={"C": (["N_wide_0917"], [])}, next_best=None, expiry_only=None)

    monkeypatch.setattr(tomorrow, "expected_picks", expected)
    return seen


def test_the_evening_list_uses_the_listed_expiries_as_the_morning_pick_does(monkeypatch, tmp_path):
    """2026-11-04: Tue 10 Nov is a holiday, so NIFTY's weekly expiry moved to Mon 9 Nov (3 weekdays
    from Wed 4 Nov). The calendar still says Tuesday (4), and the ranking differs by DTE bucket, so
    the tentative list ranked on the calendar disagreed with the 09:16 pick."""
    _master(monkeypatch, {"NIFTY": date(2026, 11, 9), "SENSEX": date(2026, 11, 5)})
    seen = _capture_expected(monkeypatch)
    nxt = tomorrow.next_session_picks(date(2026, 11, 3), tmp_path)
    assert nxt is not None and nxt.day == date(2026, 11, 4)
    assert (seen["dte_n"], seen["dte_s"]) == ("3", "1")
    assert (seen["day"], seen["last_day"], seen["track"]) == (nxt.day, date(2026, 11, 3), None)
    assert nxt.dte == {"NIFTY": "3", "SENSEX": "1"} and nxt.dte_source == "master"
    assert live.calendar_dte_labels(nxt.day)["dte_n"] == "4"  # what the evening used to rank on


def test_the_evening_list_falls_back_to_the_calendar_when_the_master_cannot_be_read(
    monkeypatch, tmp_path, capsys
):
    def refuse(segment):
        raise OSError("offline")

    monkeypatch.setattr(live, "download_master", refuse)
    seen = _capture_expected(monkeypatch)
    nxt = tomorrow.next_session_picks(date(2026, 11, 3), tmp_path, track="t1")
    assert nxt is not None and seen["track"] == "t1"
    assert (seen["dte_n"], seen["dte_s"]) == ("4", "1")
    assert nxt.dte == {"NIFTY": "4", "SENSEX": "1"} and nxt.dte_source == "calendar"
    assert "using the calendar" in capsys.readouterr().err
