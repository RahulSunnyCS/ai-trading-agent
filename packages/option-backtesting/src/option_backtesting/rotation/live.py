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


def vix_open_angel(day: date) -> float | None:
    """The same quantity from Angel One, which logs in unattended (client code, PIN, TOTP): the
    fallback for a morning with no Fyers login. None when its module or credentials are missing or
    any step fails (the reason goes to stderr, scrubbed by that module)."""
    try:
        from ..angelone.auth import load_credentials, login
        from ..angelone.client import AngelClient
        from ..angelone.symbols import build_targets, download_master
    except ImportError:
        return None
    try:
        client = AngelClient(login(load_credentials()))
        client.targets = build_targets(download_master(), [], {VIX_SYMBOL: "INDIAVIX"})
        first = int(
            datetime(day.year, day.month, day.day, 9, 15, tzinfo=IST).astimezone(UTC).timestamp()
        )
        for candle in client.minute_candles(VIX_SYMBOL, day):
            if candle.epoch == first:
                return float(candle.open)
    except Exception as error:  # noqa: BLE001 - a fallback must never raise into the pick
        import sys

        print(
            f"Angel One VIX fallback failed: {type(error).__name__}: {str(error)[:160]}",
            file=sys.stderr,
        )
    return None


def vix_open_with_source(day: date) -> tuple[float | None, str]:
    """(value, source): Fyers first, Angel One when Fyers has no token or no bar."""
    value = vix_open_live(day)
    if value is not None:
        return value, "fyers"
    value = vix_open_angel(day)
    return (value, "angelone") if value is not None else (None, "")


def calendar_dte_labels(day: date) -> dict[str, str]:
    ref = default_reference_data()
    return {
        "dte_n": dte_label(dte_for("NIFTY", day, ref)),
        "dte_s": dte_label(dte_for("SENSEX", day, ref)),
    }
