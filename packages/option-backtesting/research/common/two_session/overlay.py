"""Overlays on a recorded path: an earlier exit, an overall stop, a target, a profit lock or a
lock-and-trail, applied at bar closes exactly as the engine applies its overall stop and target
(parity: research/common/two_session/parity.py). Charges under an overlay come from the recorded
trades (exact on the sell side; a trade still open at the overlay exit is valued at its entry,
which moves only the exchange fee and stamp by a rupee or two)."""

from __future__ import annotations

import numpy as np

from option_backtesting.legwise.market import minute_index
from option_backtesting.ruletest.charges import day_charges

NO_TRIGGER = -1


def first_trigger(
    path: np.ndarray,
    start: int,
    end: int,
    stop: float | None = None,
    target: float | None = None,
    lock: tuple[float, float] | None = None,
    locktrail: tuple[float, float, float] | None = None,
) -> int:
    """The first minute in [start, end] at whose close any rule fires, else NO_TRIGGER. `lock`
    = (arm, level); `locktrail` = (arm, level, step) rising `step` per `step` of peak MTM past
    arm (1:1)."""
    seg = path[start : end + 1]
    fire = np.zeros(len(seg), dtype=bool)
    if stop is not None:
        fire |= seg <= -stop
    if target is not None:
        fire |= seg >= target
    if lock is not None or locktrail is not None:
        best = np.maximum.accumulate(np.maximum(seg, 0.0))
        if lock is not None:
            arm, level = lock
            fire |= (best >= arm) & (seg <= level)
        if locktrail is not None:
            arm, level, step = locktrail
            lvl = level + step * np.floor(np.maximum(best - arm, 0.0) / step)
            fire |= (best >= arm) & (seg <= lvl)
    hit = np.flatnonzero(fire)
    return int(start + hit[0]) if len(hit) else NO_TRIGGER


def apply(path: np.ndarray, entry: str, exit_: str, **rules) -> tuple[float, int, bool]:
    """(gross, the minute the day ended, whether a rule fired) for one recorded path under an
    exit time and the rules of `first_trigger`. The engine judges its rules at the closes of the
    minutes before the exit minute and fills the exit at the exit minute's `price_at`, the
    previous minute's close (BL-009): so the rules run over [entry, exit - 1] and an unforced day
    ends at the path's value at exit - 1."""
    start, last = minute_index(entry), minute_index(exit_) - 1
    m = first_trigger(path, start, last, **rules)
    if m == NO_TRIGGER:
        return float(path[last]), last, False
    return float(path[m]), m, True


def charges_at(events: np.ndarray, end_minute: int, underlying: str, day: str) -> tuple[float, int]:
    """(charges, orders) for the trades that exist by `end_minute` (the overlay's last minute)."""
    orders, buy, sell = 0, 0.0, 0.0
    for ev in events:
        if np.isnan(ev[0]) or ev[0] > end_minute:
            continue
        entry_min, exit_min, side, qty, ep, xp = ev
        entry_value = ep * qty
        closed_before = exit_min >= 0 and exit_min <= end_minute and not np.isnan(xp)
        exit_value = xp * qty if closed_before else entry_value
        orders += 2
        if side > 0:  # sold at entry, bought back at exit
            sell += entry_value
            buy += exit_value
        else:
            buy += entry_value
            sell += exit_value
    return day_charges(underlying, day, orders, buy, sell).total, orders
