"""Days to expiry as the rotation counts them: Monday-to-Friday dates, not calendar days (BL-109,
owner 2026-10-15). A Friday before a Monday expiry is 1, a Monday before a Tuesday expiry is 1.
Exchange holidays are not excluded.

The stored day file (`days.csv`) and the journal entries recorded before this change hold calendar
days. They are never rewritten: `store.read_days` and `entry_labels` convert on read, so nothing
can be converted twice and the recorded evidence stays as it was written."""

from __future__ import annotations

from datetime import date, timedelta

#: written into every journal entry recorded under this definition
DTE_BASIS = "weekdays"
#: what an entry without the field was recorded under
LEGACY_BASIS = "calendar"


def weekdays_after(day: date, calendar_days: int) -> int:
    """Monday-to-Friday dates in `(day, day + calendar_days]`."""
    return sum(1 for k in range(1, calendar_days + 1) if (day + timedelta(days=k)).weekday() < 5)


def weekdays_between(day: date, expiry: date) -> int:
    return weekdays_after(day, (expiry - day).days)


def from_calendar_label(label: object, day: date) -> str:
    """A stored calendar-day label ('0'..'6') on the weekday basis; '7+' and 'unknown' are kept."""
    text = str(label)
    return str(weekdays_after(day, int(text))) if text.isdigit() else text


def entry_basis(entry: dict) -> str:
    """What the journal entry's labels count: `weekdays`, or `calendar` for an entry recorded before
    BL-109 (no `dte_basis` field)."""
    return str(entry.get("dte_basis") or LEGACY_BASIS)


def recorded_labels(entry: dict) -> dict[str, str]:
    """{'NIFTY': ..., 'SENSEX': ...} exactly as the entry holds them (on `entry_basis`)."""
    recorded = entry.get("dte") or {}
    return {index: str(recorded.get(index, "unknown")) for index in ("NIFTY", "SENSEX")}


def entry_labels(entry: dict) -> dict[str, str]:
    """{'NIFTY': ..., 'SENSEX': ...} of a journal entry on the weekday basis, whatever it was
    recorded under."""
    recorded = entry.get("dte") or {}
    day = date.fromisoformat(str(entry["day"]))
    basis = entry.get("dte_basis") or LEGACY_BASIS
    out: dict[str, str] = {}
    for index in ("NIFTY", "SENSEX"):
        label = recorded.get(index, "unknown")
        out[index] = str(label) if basis == DTE_BASIS else from_calendar_label(label, day)
    return out
