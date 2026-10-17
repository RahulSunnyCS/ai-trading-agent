"""BL-120: the read guard. Only the registered screening cells may be opened.

Judged cells (Phase 0): NIFTY in P2 and P3, SENSEX in P2. P1 (2025-12-03 -> 2026-10-08), the days
between P2 and P1, and every day after 2026-10-08 stay unread until Phase 2's gate is met (a cell
screen-passed). Every function in this folder that opens a lake file calls `assert_day` first.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

P2 = (date(2025, 1, 10), date(2025, 8, 29))
P3 = (date(2022, 4, 5), date(2024, 10, 8))
PERIODS = {"P2": P2, "P3": P3}
CELLS = [("P2", "NIFTY"), ("P3", "NIFTY"), ("P2", "SENSEX")]


class ForbiddenDay(RuntimeError):
    """A day outside the registered cells: not to be read before the gate."""


def period_of(underlying: str, day: date) -> str | None:
    for period, und in CELLS:
        lo, hi = PERIODS[period]
        if und == underlying and lo <= day <= hi:
            return period
    return None


def assert_day(underlying: str, day: date) -> str:
    period = period_of(underlying, day)
    if period is None:
        raise ForbiddenDay(f"{underlying} {day} is outside the BL-120 screening cells")
    return period


def cell_days(root: Path, underlying: str, period: str) -> tuple[list[date], dict[date, str]]:
    """Weekday sessions of the cell that data_quality keeps, and the ones it skips."""
    from option_backtesting.legwise.market import backtest_days

    if (period, underlying) not in CELLS:
        raise ForbiddenDay(f"{underlying} {period} is not a BL-120 cell")
    lo, hi = PERIODS[period]
    days, skipped = backtest_days(root, underlying, lo, hi)
    days = [d for d in days if d.weekday() < 5]
    for d in days:
        assert_day(underlying, d)
    return days, skipped
