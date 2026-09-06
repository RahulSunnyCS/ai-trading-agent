from datetime import time

import pytest

from option_backtesting.bartime import parse_bar_times, time_to_bar_index

FIXTURE_TIMES = [
    "09:30",
    "09:45",
    "10:00",
    "10:15",
    "10:30",
    "10:45",
    "11:00",
    "11:15",
    "11:30",
    "11:45",
    "12:00",
    "12:15",
    "12:30",
    "12:45",
    "13:00",
    "13:15",
    "13:30",
    "13:45",
    "14:00",
    "14:15",
    "14:30",
    "14:45",
    "15:00",
    "15:15",
]


def test_parse_bar_times_produces_time_objects() -> None:
    parsed = parse_bar_times(FIXTURE_TIMES)
    assert parsed[0] == time(9, 30)
    assert parsed[-1] == time(15, 15)


def test_time_before_first_bar_is_pre_bar_sentinel() -> None:
    bar_times = parse_bar_times(FIXTURE_TIMES)
    assert time_to_bar_index(bar_times, "09:17") is None


def test_exact_match_on_first_bar() -> None:
    bar_times = parse_bar_times(FIXTURE_TIMES)
    assert time_to_bar_index(bar_times, "09:30") == 0


def test_exact_match_on_fallback_time_noon() -> None:
    bar_times = parse_bar_times(FIXTURE_TIMES)
    assert time_to_bar_index(bar_times, "12:00") == 10


def test_exact_match_on_last_bar() -> None:
    bar_times = parse_bar_times(FIXTURE_TIMES)
    assert time_to_bar_index(bar_times, "15:15") == 23


def test_unaligned_time_raises() -> None:
    bar_times = parse_bar_times(FIXTURE_TIMES)
    with pytest.raises(ValueError, match="does not align"):
        time_to_bar_index(bar_times, "12:07")
