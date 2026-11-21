"""What the day's entry reads at run time: each index's days to the nearest listed expiry
(Fyers' public symbol master, the reference calendar as the fallback). The 09:15 India VIX read
(Fyers, then Angel One) was removed on 2026-11-09: the entry now ranks with the evening's VIX
(`pick.evening_vix`)."""

from __future__ import annotations

import sys
from datetime import date
from functools import lru_cache

from ..data.reference.loader import default_reference_data
from ..fyers.symbols import download_master, parse_master
from ..legwise.anatomy import dte_for
from .dte import from_calendar_label
from .score import dte_label


@lru_cache(maxsize=8)
def listed_labels(day: date) -> dict[str, str]:
    """Days to the nearest listed expiry per index from Fyers' public symbol master (two multi-MB
    downloads), kept per session date for the process: the morning entry records Adaptive and T1
    in one process and the evening message asks for both lists' picks, so each pays once.
    Raises when the master cannot be read; only a read that succeeded is kept."""
    out = {}
    for key, segment, name in (("dte_n", "NSE_FO", "NIFTY"), ("dte_s", "BSE_FO", "SENSEX")):
        contracts = parse_master(download_master(segment), {name})
        upcoming = sorted(
            {c.expiry for c in contracts if c.option_type in ("CE", "PE") and c.expiry >= day}
        )
        if not upcoming:
            raise ValueError(f"no listed {name} expiry on or after {day}")
        out[key] = from_calendar_label(dte_label((upcoming[0] - day).days), day)
    return out


def listed_dte_labels(day: date) -> tuple[dict[str, str], str]:
    """Days to the nearest listed expiry per index, as the history's labels are built (from the
    contracts that trade), read from Fyers' public symbol master; the reference calendar when the
    master cannot be fetched. The calendar lags real expiries around holidays (BL-058 review)."""
    try:
        return dict(listed_labels(day)), "master"
    except Exception as error:  # noqa: BLE001
        print(
            f"listed-expiry DTE failed ({type(error).__name__}: {str(error)[:100]}); "
            "using the calendar",
            file=sys.stderr,
        )
        return calendar_dte_labels(day), "calendar"


def calendar_dte_labels(day: date) -> dict[str, str]:
    ref = default_reference_data()

    def label(underlying: str) -> str:
        calendar_days = dte_for(underlying, day, ref)
        return from_calendar_label(dte_label(calendar_days), day)

    return {"dte_n": label("NIFTY"), "dte_s": label("SENSEX")}
