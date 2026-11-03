"""The evening message's month so far (owner, 2026-10-30): each list's paper result from the 1st of
the month to the day, and, in the owner's copy only, the account's real profit from the contract
notes. From `MONTH_FROM` (November 2026) on; before it there are no lines, so October's messages
are unchanged.

Paper = the result message's own figures (`result.calculate`, one lot per strategy, after
costs and `slippage.SLIPPAGE_PCT` % slippage on every fill) summed over the month's journal
entries; a day whose results are not complete, or with no entry, is left out, never counted as
zero. A list that trades the Dir ×2 rule also gets its
as-traded total (`result.as_traded`, from the setting, as the day's line). Real = the contract
notes' daily profit (after charges and algo fees, `realised.views.days`); the notes reach the
store at 00:00, so the 16:00 message counts up to the day before.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path

from ..fyers.daily import data_dir
from . import journal, result, slippage, store

MONTH_FROM = date(2026, 11, 1)


@dataclass(frozen=True)
class Month:
    """A month so far: the net, the days counted and the days won (net above zero)."""

    net: float
    days: int
    won: int
    #: the list's as-traded net (BL-183) when its accounts trade the Dir ×2 rule, else None
    as_traded: float | None = None
    #: the last day counted (the real figures run to the day before the message)
    through: date | None = None
    #: the % slippage on every fill the paper figures carry (`slippage.apply`)
    slippage_pct: float | None = None


def month_start(day: date) -> date | None:
    """The first day the month so far counts from, or None before `MONTH_FROM`."""
    if day < MONTH_FROM:
        return None
    return max(day.replace(day=1), MONTH_FROM)


def paper(
    day: date,
    root: Path | None = None,
    track: str | None = None,
    boost: bool = False,
    today: result.DailyResult | None = None,
    slip: float | None = None,
) -> Month | None:
    """A list's paper month up to and including `day` (None before `MONTH_FROM`, or with no day
    counted), each day after `slip` % slippage. `today` is the day's result when the caller
    already has it. Raises when a day cannot be slipped: the month is left out, never mixed."""
    slip = slippage.SLIPPAGE_PCT if slip is None else slip
    start = month_start(day)
    if start is None:
        return None
    root = root or data_dir()
    days = sorted(
        {
            date.fromisoformat(e["day"])
            for e in journal.read(store.journal_path(root, track))
            if start.isoformat() <= str(e.get("day", "")) <= day.isoformat()
        }
    )
    net = traded = 0.0
    counted = won = 0
    for d in days:
        if today is not None and d == today.day:
            r = today
        else:
            try:
                r = result.calculate(d, root, track)
            except result.ResultUnavailable:
                continue
        r = slippage.apply(r, root, slip)
        gain = r.gains[result.RESULT_KEYS[0]]
        net += gain
        counted += 1
        won += gain > 0
        if boost:
            as_traded = result.as_traded(r)
            traded += gain if as_traded is None else as_traded[1]
    if not counted:
        return None
    return Month(net, counted, won, traded if boost else None, days[-1], slip or None)


def real(day: date, root: Path | None = None) -> Month | None:
    """The account's real month from the contract notes, up to the day before `day` (the notes of
    `day` itself are read at 00:00); None before `MONTH_FROM` or with no day in the store yet."""
    from ..realised import views

    start = month_start(day)
    if start is None:
        return None
    rows = [
        r
        for r in views.days(root or data_dir(), start=start, end=day)["days"]
        if r.get("profit") is not None
    ]
    if not rows:
        return None
    profits = [float(r["profit"]) for r in rows]
    return Month(
        sum(profits),
        len(profits),
        sum(p > 0 for p in profits),
        through=date.fromisoformat(str(rows[-1]["day"])),
    )
