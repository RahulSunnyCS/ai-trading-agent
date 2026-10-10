"""What the 09:16 pick can know: the 09:15 India VIX open (read live from Fyers, because the
lake only has it after the evening collection) and each index's days to expiry from the
reference calendar."""

from __future__ import annotations

import sys
import time
from collections.abc import Callable
from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from ..data.reference.loader import default_reference_data
from ..fyers.auth import FyersCredentialsError, resolve_credentials
from ..fyers.client import FyersClient
from ..fyers.daily import VIX_SYMBOL
from ..fyers.symbols import download_master, parse_master
from ..legwise.anatomy import dte_for
from .score import dte_label

IST = ZoneInfo("Asia/Kolkata")


def _fyers_attempt(day: date, client: FyersClient | None = None) -> float | None:
    """One read of the 09:15 bar from Fyers: the open, or None when the bar is not served yet.
    Raises FyersCredentialsError when there is no usable token (not worth polling) and lets
    network / API errors through (the caller treats them as transient)."""
    client = client or FyersClient(resolve_credentials())
    first = int(
        datetime(day.year, day.month, day.day, 9, 15, tzinfo=IST).astimezone(UTC).timestamp()
    )
    for candle in client.minute_candles(VIX_SYMBOL, day):
        if candle.epoch == first:
            return float(candle.open)
    return None


def vix_open_live(day: date, client: FyersClient | None = None) -> float | None:
    """Open of today's 09:15 India VIX bar from Fyers, or None for any reason it cannot be read."""
    try:
        return _fyers_attempt(day, client)
    except Exception as error:  # noqa: BLE001 - the caller only needs "not available"
        print(f"Fyers VIX read failed: {type(error).__name__}: {str(error)[:160]}", file=sys.stderr)
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


def vix_open_with_source(
    day: date,
    wait_s: float = 40.0,
    poll_s: float = 5.0,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
) -> tuple[float | None, str]:
    """(value, source). Fyers is polled for up to `wait_s` seconds (the 09:15 bar is served a few
    seconds after 09:16:00); no usable token skips the polling at once. Angel One is tried once
    after that."""
    deadline = monotonic() + wait_s
    while True:
        try:
            value = _fyers_attempt(day)
        except FyersCredentialsError as error:
            print(f"Fyers: {str(error)[:120]}", file=sys.stderr)
            break
        except Exception as error:  # noqa: BLE001 - network / API hiccup: retry until the deadline
            print(
                f"Fyers VIX read failed: {type(error).__name__}: {str(error)[:120]}",
                file=sys.stderr,
            )
            value = None
        if value is not None:
            return value, "fyers"
        if monotonic() >= deadline:
            break
        sleep(poll_s)
    value = vix_open_angel(day)
    return (value, "angelone") if value is not None else (None, "")


def listed_dte_labels(day: date) -> tuple[dict[str, str], str]:
    """Days to the nearest listed expiry per index, as the history's labels are built (from the
    contracts that trade), read from Fyers' public symbol master; the reference calendar when the
    master cannot be fetched. The calendar lags real expiries around holidays (BL-058 review)."""
    try:
        out = {}
        for key, segment, name in (("dte_n", "NSE_FO", "NIFTY"), ("dte_s", "BSE_FO", "SENSEX")):
            contracts = parse_master(download_master(segment), {name})
            upcoming = sorted(
                {c.expiry for c in contracts if c.option_type in ("CE", "PE") and c.expiry >= day}
            )
            if not upcoming:
                raise ValueError(f"no listed {name} expiry on or after {day}")
            out[key] = dte_label((upcoming[0] - day).days)
        return out, "master"
    except Exception as error:  # noqa: BLE001
        print(
            f"listed-expiry DTE failed ({type(error).__name__}: {str(error)[:100]}); "
            "using the calendar",
            file=sys.stderr,
        )
        return calendar_dte_labels(day), "calendar"


def calendar_dte_labels(day: date) -> dict[str, str]:
    ref = default_reference_data()
    return {
        "dte_n": dte_label(dte_for("NIFTY", day, ref)),
        "dte_s": dte_label(dte_for("SENSEX", day, ref)),
    }
