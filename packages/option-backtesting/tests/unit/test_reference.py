"""
Reference data loader tests. Cross-checks against
apps/server/src/ingestion/brokers/instrument-registry.ts's hard-coded
constants (STRIKE_INTERVALS, WEEKLY_EXPIRY_DOW) — those values must agree
with this loader's "current" row, since both encode the same real-world
market facts. Also pins the exact DTE values baked into the golden fixture
(see tests/golden/), which is the cheapest possible correctness check: those
numbers were computed by hand against real AlgoTest data.
"""

from datetime import date

import pytest

from option_backtesting.data.reference.loader import ReferenceData


@pytest.fixture()
def rd() -> ReferenceData:
    return ReferenceData()


class TestStrikeStep:
    """Must match STRIKE_INTERVALS in instrument-registry.ts."""

    def test_nifty(self, rd: ReferenceData) -> None:
        assert rd.strike_step("NIFTY", date(2026, 9, 1)) == 50

    def test_banknifty(self, rd: ReferenceData) -> None:
        assert rd.strike_step("BANKNIFTY", date(2026, 9, 1)) == 100

    def test_sensex(self, rd: ReferenceData) -> None:
        assert rd.strike_step("SENSEX", date(2026, 9, 1)) == 100


class TestLotSize:
    """2026 values per the design handoff's "Known data facts" — NIFTY 65,
    BANKNIFTY 30, SENSEX 20 — which is also what the golden fixture uses
    (L=65 in golden_15_sessions.py)."""

    def test_nifty_2026(self, rd: ReferenceData) -> None:
        assert rd.lot_size("NIFTY", date(2026, 9, 1)) == 65

    def test_banknifty_2026(self, rd: ReferenceData) -> None:
        assert rd.lot_size("BANKNIFTY", date(2026, 9, 1)) == 30

    def test_sensex_2026(self, rd: ReferenceData) -> None:
        assert rd.lot_size("SENSEX", date(2026, 9, 1)) == 20

    def test_missing_era_raises(self, rd: ReferenceData) -> None:
        """No fabricated fallback for a date before any effective row."""
        with pytest.raises(ValueError, match="No lot_sizes row"):
            rd.lot_size("NIFTY", date(2020, 1, 1))


class TestHolidays:
    def test_known_holiday(self, rd: ReferenceData) -> None:
        assert rd.is_holiday(date(2026, 8, 15))  # Independence Day

    def test_ordinary_trading_day(self, rd: ReferenceData) -> None:
        assert not rd.is_holiday(date(2026, 9, 1))

    def test_weekend_is_not_a_trading_day_even_without_holiday_row(
        self, rd: ReferenceData
    ) -> None:
        # 2026-09-06 is a Sunday and is not in holidays.csv — is_trading_day
        # must still be False.
        assert not rd.is_trading_day(date(2026, 9, 6))


class TestCurrentExpiry:
    """Pins the exact DTE values from golden_15_sessions.py's DTE dict —
    the golden fixture's 15 sessions, 17 Aug-4 Sep 2026. NIFTY weekly expiry
    is Tuesday; 0901 (1 Sep) is the expiry day itself (DTE 0)."""

    @pytest.mark.parametrize(
        "day,expected_expiry",
        [
            (date(2026, 8, 17), date(2026, 8, 18)),  # Mon -> Tue, DTE 1
            (date(2026, 8, 18), date(2026, 8, 18)),  # Tue expiry day, DTE 0
            (date(2026, 8, 19), date(2026, 8, 25)),  # Wed -> next Tue, DTE 6
            (date(2026, 8, 20), date(2026, 8, 25)),  # Thu, DTE 5
            (date(2026, 8, 21), date(2026, 8, 25)),  # Fri, DTE 4
            (date(2026, 9, 1), date(2026, 9, 1)),  # Tue expiry day, DTE 0
            (date(2026, 9, 2), date(2026, 9, 8)),  # Wed -> next Tue, DTE 6
            (date(2026, 9, 3), date(2026, 9, 8)),  # Thu, DTE 5
            (date(2026, 9, 4), date(2026, 9, 8)),  # Fri, DTE 4
        ],
    )
    def test_nifty_dte_matches_golden_fixture(
        self, rd: ReferenceData, day: date, expected_expiry: date
    ) -> None:
        assert rd.current_expiry("NIFTY", day) == expected_expiry
        assert (expected_expiry - day).days == {
            date(2026, 8, 17): 1,
            date(2026, 8, 18): 0,
            date(2026, 8, 19): 6,
            date(2026, 8, 20): 5,
            date(2026, 8, 21): 4,
            date(2026, 9, 1): 0,
            date(2026, 9, 2): 6,
            date(2026, 9, 3): 5,
            date(2026, 9, 4): 4,
        }[day]

    def test_sensex_weekly_is_thursday(self, rd: ReferenceData) -> None:
        # 2026-09-03 is a Thursday.
        assert rd.current_expiry("SENSEX", date(2026, 9, 1)) == date(2026, 9, 3)

    def test_banknifty_monthly_last_tuesday(self, rd: ReferenceData) -> None:
        # September 2026's last Tuesday is the 29th.
        assert rd.current_expiry("BANKNIFTY", date(2026, 9, 1)) == date(2026, 9, 29)

    def test_banknifty_rolls_to_next_month_after_last_tuesday(
        self, rd: ReferenceData
    ) -> None:
        assert rd.current_expiry("BANKNIFTY", date(2026, 9, 30)) == date(2026, 10, 27)
