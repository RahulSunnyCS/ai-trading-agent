"""
`max_runup` checked directly against every one of the golden fixture's 15
sessions' real `max_runup` values (from `golden_15_sessions.expected.txt`'s
"VARIANT D" table) — this is the single scalar Variant D's entire adaptive
threshold is built from, so a regression here would silently corrupt every
downstream D assertion in the golden parity test without pointing at the
actual cause.
"""

import json
from pathlib import Path

import pytest

from option_backtesting.features.path import max_runup, session_high, session_low

FIXTURE_PATH = Path(__file__).parent.parent / "golden" / "fixture_15_sessions.json"

EXPECTED_MAX_RUNUP = {
    "2026-08-17": 26.30,
    "2026-08-18": 18.15,
    "2026-08-19": 1.40,
    "2026-08-20": 28.10,
    "2026-08-21": 2.50,
    "2026-08-24": 43.30,
    "2026-08-25": 72.05,
    "2026-08-26": 7.75,
    "2026-08-27": 29.25,
    "2026-08-28": 27.65,
    "2026-08-31": 35.05,
    "2026-09-01": 42.45,
    "2026-09-02": 6.10,
    "2026-09-03": 15.25,
    "2026-09-04": 7.40,
}


def _atm_straddle(session: dict) -> tuple[float, list[float]]:
    open_ = session["atm_ce"]["open"] + session["atm_pe"]["open"]
    closes = [
        c + p for c, p in zip(session["atm_ce"]["closes"], session["atm_pe"]["closes"], strict=True)
    ]
    return open_, closes


@pytest.fixture
def fixture_sessions() -> list[dict]:
    return json.loads(FIXTURE_PATH.read_text())["sessions"]


def test_max_runup_matches_golden_fixture_for_every_session(fixture_sessions: list[dict]) -> None:
    for session in fixture_sessions:
        open_, closes = _atm_straddle(session)
        got = max_runup(open_, closes)
        assert got == pytest.approx(EXPECTED_MAX_RUNUP[session["date"]], abs=0.01), session["date"]


def test_max_runup_checks_runup_before_folding_in_current_bar() -> None:
    # A single bar that itself sets a new low must NOT count as runup off
    # itself — the reference checks `mx = max(mx, p - lo)` BEFORE
    # `lo = min(lo, p)`, so a monotonically falling series has runup 0.
    assert max_runup(100.0, [90.0, 80.0, 70.0]) == 0.0


def test_max_runup_zero_when_series_never_exceeds_open() -> None:
    assert max_runup(100.0, [100.0, 100.0]) == 0.0


class TestSessionHighLow:
    def test_high_includes_open_and_closes_up_to_until_inclusive(self) -> None:
        assert session_high(50.0, [60.0, 70.0, 55.0], until_bar=1) == 70.0

    def test_high_ignores_bars_after_until(self) -> None:
        assert session_high(50.0, [60.0, 999.0], until_bar=0) == 60.0

    def test_low_includes_open_and_closes_up_to_until_inclusive(self) -> None:
        assert session_low(50.0, [60.0, 40.0, 55.0], until_bar=1) == 40.0

    def test_until_none_means_open_only(self) -> None:
        assert session_high(50.0, [999.0], until_bar=None) == 50.0
        assert session_low(50.0, [-999.0], until_bar=None) == 50.0
