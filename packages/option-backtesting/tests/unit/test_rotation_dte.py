"""Days to expiry counted in weekdays (BL-109): the helper, the stored-day conversion on read, the
journal entry labels, and the live labels."""

from datetime import date
from types import SimpleNamespace

from option_backtesting.rotation import dte, live, store


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
