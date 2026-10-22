"""BL-156: the event dates (read 5) and the day groups of read 8, all known in advance.

Event dates are the ones registered in backlog/BL-156-eight-poc-reads.md (RBI MPC decision days, the two
Budget-day special sessions, the Indian session after a US FOMC decision). Groups are built from the
trading days themselves plus `reference/holidays.csv`; nothing here reads a result.
"""

from __future__ import annotations

import csv
from datetime import date, timedelta
from pathlib import Path

RBI = [
    "2024-10-09", "2024-12-06", "2025-02-07", "2025-04-09", "2025-06-06", "2025-08-07", "2025-10-01",
    "2025-12-05", "2026-02-06", "2026-04-08", "2026-06-05", "2026-08-05", "2026-10-07",
]
BUDGET = ["2025-02-01", "2026-02-01"]
FED_MORNING = [
    "2024-11-08", "2024-12-19", "2025-01-30", "2025-03-20", "2025-05-08", "2025-06-19", "2025-07-31",
    "2025-09-18", "2025-10-30", "2025-12-11", "2026-01-29", "2026-03-19", "2026-04-30", "2026-06-18",
    "2026-07-30", "2026-09-17",
]
EVENTS = {"rbi": RBI, "budget": BUDGET, "fed": FED_MORNING}

REFERENCE = Path(__file__).resolve().parents[2] / "src/option_backtesting/data/reference"


def holidays() -> set[date]:
    with (REFERENCE / "holidays.csv").open() as f:
        return {date.fromisoformat(r["date"]) for r in csv.DictReader(f)}


def _is_weekday_holiday(d: date, hols: set[date]) -> bool:
    return d.weekday() < 5 and d in hols


def groups(days: list[date], weekly_expiries: set[date]) -> dict[date, set[str]]:
    """The read-8 groups of every trading day. `weekly_expiries`: the NIFTY weekly expiry dates
    observed in the lake; the monthly expiry is a month's last one."""
    hols = holidays()
    days = sorted(days)
    out: dict[date, set[str]] = {d: set() for d in days}
    events = {date.fromisoformat(s) for v in EVENTS.values() for s in v}
    monthly = set()
    by_month: dict[tuple[int, int], list[date]] = {}
    for e in sorted(weekly_expiries):
        by_month.setdefault((e.year, e.month), []).append(e)
    for v in by_month.values():
        monthly.add(v[-1])
    expiry_week: set[date] = set()
    for m in monthly:
        k = days.index(m) if m in out else None
        if k is not None:
            expiry_week.update(days[max(0, k - 4) : k + 1])
    for i, d in enumerate(days):
        g = out[d]
        if d.weekday() == 0:
            g.add("monday")
        if i + 1 < len(days):
            nxt = days[i + 1]
            # a holiday between this day and the next trading day (a weekend alone is not one)
            gap = [d + timedelta(k) for k in range(1, (nxt - d).days)]
            if any(_is_weekday_holiday(x, hols) for x in gap):
                g.add("before_holiday")
        if i > 0:
            prev = days[i - 1]
            gap = [prev + timedelta(k) for k in range(1, (d - prev).days)]
            if any(_is_weekday_holiday(x, hols) for x in gap):
                g.add("after_holiday")
        if i == 0 or days[i - 1].month != d.month:
            g.add("month_first")
        if i + 1 == len(days) or days[i + 1].month != d.month:
            g.add("month_last")
        if d in expiry_week:
            g.add("expiry_week")
        if d in events:
            g.add("event")
    return out


GROUP_NAMES = [
    "before_holiday", "after_holiday", "monday", "expiry_week", "month_first", "month_last", "event",
]
