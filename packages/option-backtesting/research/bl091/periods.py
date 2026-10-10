"""BL-091 Phase 1: the learning periods and the guard that keeps every other day unread.

Section E.3 of the item: the exploration learns on P2 (NIFTY and SENSEX) and P3 (NIFTY only). P1
(2025-12-03 -> 2026-10-08) and the gap before it are read only once the rule is frozen, so every
function in this folder that opens a lake file calls `assert_learning_day` first.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

P2 = (date(2025, 1, 10), date(2025, 8, 29))
P3 = (date(2022, 4, 5), date(2024, 10, 8))
PERIODS = {"P2": P2, "P3": P3}
UNDERLYINGS = {"P2": ("NIFTY", "SENSEX"), "P3": ("NIFTY",)}

SIZING = date(2026, 10, 12)  # lot_sizing current: the journal's sizing date
STEP = {"NIFTY": 50.0, "SENSEX": 100.0}
STOP_INR = 650.0  # owner, 2026-10-10: the live Widesl with a ₹650 MTM stop
RISE = 25.0  # E.2: an episode is a rise of at least 25 points
DECAY = 15.0  # E.2: decayed = gave back at least 15 points from the high
M_0920 = 5  # observation starts 09:20
M_1512 = 357  # a trigger here or later gets no attempt (entry would be 15:13)
M_1513 = 358  # no entry at or after 15:13
M_1528 = 373  # horizon: the completed 15:28 bar
MAX_ATTEMPTS = 5
COST_PER_ORDER = 20.0  # assumption for the second net column; the lists run at 0


class ForbiddenDay(RuntimeError):
    """A day outside P2 / P3 (or SENSEX outside P2): not to be read in this phase."""


def period_of(underlying: str, day: date) -> str | None:
    for name, (lo, hi) in PERIODS.items():
        if lo <= day <= hi and underlying in UNDERLYINGS[name]:
            return name
    return None


def assert_learning_day(underlying: str, day: date) -> str:
    period = period_of(underlying, day)
    if period is None:
        raise ForbiddenDay(f"{underlying} {day} is outside the learning periods (P2, P3)")
    return period


def learning_days(root: Path, underlying: str, period: str) -> tuple[list[date], dict[date, str]]:
    """Every collected option day of the period that data_quality keeps, and the ones it skips."""
    from option_backtesting.legwise.market import backtest_days

    if underlying not in UNDERLYINGS[period]:
        raise ForbiddenDay(f"{underlying} is not part of {period}")
    lo, hi = PERIODS[period]
    days, skipped = backtest_days(root, underlying, lo, hi)
    for d in days:
        assert_learning_day(underlying, d)
    return days, skipped
