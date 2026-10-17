"""BL-121: the read guard. Only the registered cells may be opened.

Judged cells (Phase 0): NIFTY in P2 and in P3, each arm separately. P1 (2025-12-03 -> 2026-10-08), the days
between P2 and P1, and every day after 2026-10-08 stay unread until Phase 2's gate is met (an arm
screen-passed). Every function in this folder that opens a lake file calls `assert_day` first.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

P2 = (date(2025, 1, 10), date(2025, 8, 29))
P3 = (date(2022, 4, 5), date(2024, 10, 8))
PERIODS = {"P2": P2, "P3": P3}
UNDERLYING = "NIFTY"


class ForbiddenDay(RuntimeError):
    """A day outside the registered cells: not to be read before the gate."""


def period_of(underlying: str, day: date) -> str | None:
    if underlying != UNDERLYING:
        return None
    for period, (lo, hi) in PERIODS.items():
        if lo <= day <= hi:
            return period
    return None


def assert_day(underlying: str, day: date) -> str:
    period = period_of(underlying, day)
    if period is None:
        raise ForbiddenDay(f"{underlying} {day} is outside the BL-121 cells")
    return period


def cell_days(root: Path, period: str) -> tuple[list[date], dict[date, str]]:
    """Weekday sessions of the period that data_quality keeps, and the ones it skips."""
    from option_backtesting.legwise.market import backtest_days

    lo, hi = PERIODS[period]
    days, skipped = backtest_days(root, UNDERLYING, lo, hi)
    days = [d for d in days if d.weekday() < 5]
    for d in days:
        assert_day(UNDERLYING, d)
    return days, skipped
