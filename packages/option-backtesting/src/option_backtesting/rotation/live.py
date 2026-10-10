"""What the 09:16 pick can know: the 09:15 India VIX open (read live from Fyers, because the
lake only has it after the evening collection) and each index's days to expiry from the
reference calendar."""

from __future__ import annotations

from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from ..data.reference.loader import default_reference_data
from ..fyers.auth import FyersCredentialsError, resolve_credentials
from ..fyers.client import FyersClient
from ..fyers.daily import VIX_SYMBOL
from ..legwise.anatomy import dte_for
from .score import dte_label

IST = ZoneInfo("Asia/Kolkata")


def vix_open_live(day: date, client: FyersClient | None = None) -> float | None:
    """Open of today's 09:15 India VIX bar, or None when unreadable (no token, no bar yet)."""
    try:
        client = client or FyersClient(resolve_credentials())
    except FyersCredentialsError:
        return None
    first = int(
        datetime(day.year, day.month, day.day, 9, 15, tzinfo=IST).astimezone(UTC).timestamp()
    )
    for candle in client.minute_candles(VIX_SYMBOL, day):
        if candle.epoch == first:
            return float(candle.open)
    return None


def calendar_dte_labels(day: date) -> dict[str, str]:
    ref = default_reference_data()
    return {
        "dte_n": dte_label(dte_for("NIFTY", day, ref)),
        "dte_s": dte_label(dte_for("SENSEX", day, ref)),
    }
