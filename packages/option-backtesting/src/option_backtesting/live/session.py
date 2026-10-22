"""One trading day as the Live page draws it: spot, India VIX, the ATM strike and two straddles.

The page reads this and nothing else. Today the only source is a collected lake day, played back
(`source.kind == "replay"`). When the live capture service (BL-117 Phase 2) writes
`TRADING_DATA_ROOT/live/<day>/`, a live reader returns the same shape for the day so far, and
the page needs no change. Nothing here writes a file, places an order or recommends one.

Two straddles, both on the nearest listed weekly expiry, both CE close + PE close of that minute:

- **rolling**: the ATM of each minute's spot, so it re-strikes as the index moves (what the old
  Live tab and the frozen signal engine call the ATM straddle);
- **fixed**: the strike that was ATM at the 09:15 open, held all day (what a seller of the
  morning straddle holds).

A minute with no bar of its own is `None` (a gap in the line), never a carried or invented value:
a strike that was not collected, a leg that has not traded yet or did not trade in that minute,
and likewise for spot and India VIX. (`market.load_day` forward-fills each series for the
legwise engine; `_load` blanks those minutes again.) Days to expiry count weekdays (BL-109).
"""

from __future__ import annotations

import statistics
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any

import pyarrow.parquet as pq
from trading_data import lake

from ..data.reference.loader import ReferenceData, default_reference_data
from ..legwise import market
from ..legwise.market import (
    N_MINUTES,
    SESSION_START_MIN,
    DayData,
    Series,
    pick_expiry,
)
from ..rotation import dte

UNDERLYINGS = ("NIFTY", "SENSEX")
#: sessions the "range so far" is compared with (BL-110's baseline: the last 20 sessions)
RANGE_BASELINE_SESSIONS = 20
#: days offered in the replay picker
RECENT_DAYS = 60
IST = timezone(timedelta(hours=5, minutes=30))


class LiveSessionError(ValueError):
    """The day cannot be drawn; the message says why and is shown as it is."""


def recent_days(root: Path, underlying: str, limit: int = RECENT_DAYS) -> list[date]:
    """Collected days with option data, newest first."""
    _check_underlying(underlying)
    return sorted(market.available_days(root, underlying), reverse=True)[:limit]


def live_status(root: Path, day: date) -> dict[str, Any]:
    """Whether a live capture exists for `day`. There is no capture service yet (BL-117 Phase 2),
    so this is always unavailable; the reason is what the page shows."""
    return {
        "available": False,
        "reason": (
            "No live feed is running, so the page replays a session the evening run collected. "
            "Live capture is not built yet."
        ),
    }


def build_session(
    root: Path,
    underlying: str,
    day: date | None = None,
    reference: ReferenceData | None = None,
) -> dict[str, Any]:
    """The day's series on the 1-minute grid, trimmed to the last minute that has data.

    `day` None = the newest collected day. Raises `LiveSessionError` when the day has no data."""
    _check_underlying(underlying)
    days = market.available_days(root, underlying)
    if not days:
        raise LiveSessionError(f"no collected {underlying} days under {root}")
    chosen = day or max(days)
    if chosen not in days:
        raise LiveSessionError(f"no {underlying} data for {chosen.isoformat()}")
    reference = reference or default_reference_data()
    data = _load(root, underlying, chosen)
    last = _last_minute(root, underlying, chosen)
    step = float(reference.strike_step(underlying, chosen))
    expiry = pick_expiry(data, "weekly")
    if expiry is None:
        raise LiveSessionError(f"no listed {underlying} expiry on or after {chosen.isoformat()}")
    n = last + 1
    return {
        "underlying": underlying,
        "day": chosen.isoformat(),
        "source": {"kind": "replay", "note": "A collected session, played back from the lake."},
        "live": live_status(root, chosen),
        "expiry": expiry.isoformat(),
        "dte_weekdays": dte.weekdays_between(chosen, expiry),
        "strike_step": step,
        "last_minute": last,
        "minutes": [_epoch(chosen, m) for m in range(n)],
        "spot": {
            "open": data.spot.open[0],
            "close": _col(data.spot.close, n),
            "high": _col(data.spot.high, n),
            "low": _col(data.spot.low, n),
        },
        "vix": _col(data.vix.close, n) if data.vix is not None else None,
        **_straddles(data, expiry, step, n),
        "range": _range_context(root, underlying, chosen, data, n),
        "notes": list(data.notes),
    }


def _check_underlying(underlying: str) -> None:
    if underlying not in UNDERLYINGS:
        raise LiveSessionError(f"underlying must be one of {', '.join(UNDERLYINGS)}")


@lru_cache(maxsize=8)
def _load(root: Path, underlying: str, day: date) -> DayData:
    """The day as collected: a minute with no bar is None in every series.

    `market.load_day` forward-fills each series after its first bar (what the legwise engine
    wants), so the minutes that had no bar of their own are blanked again here. A collected day
    never changes once the evening run has written it, so replays are cached."""
    data = market.load_day(root, underlying, day)
    _blank_unbarred(data.spot, _bar_minutes(lake.bars_1m_path(root, "index", underlying, day)))
    if data.vix is not None:
        vix_path = lake.bars_1m_path(root, "index", "INDIAVIX", day)
        _blank_unbarred(data.vix, _bar_minutes(vix_path))
    legs = _leg_minutes(lake.bars_1m_path(root, "option", underlying, day))
    for key, series in data.chain.items():
        _blank_unbarred(series, legs.get(key, set()))
    return data


def _bar_minutes(path: Path) -> set[int]:
    """The grid minutes a 1-minute file has a bar for."""
    table = pq.read_table(path, columns=["ts"])
    return {m for m in market._minutes(table) if 0 <= m < N_MINUTES}


def _leg_minutes(path: Path) -> dict[tuple[date, float, str], set[int]]:
    """The grid minutes each contract of an option file has a bar for."""
    table = pq.read_table(path, columns=["ts", "expiry", "strike", "option_type"])
    keys = zip(
        table.column("expiry").to_pylist(),
        table.column("strike").to_pylist(),
        table.column("option_type").to_pylist(),
        strict=True,
    )
    out: dict[tuple[date, float, str], set[int]] = {}
    for key, m in zip(keys, market._minutes(table), strict=True):
        if 0 <= m < N_MINUTES:
            out.setdefault(key, set()).add(m)
    return out


def _blank_unbarred(series: Series, minutes: set[int]) -> None:
    for m in range(N_MINUTES):
        if m not in minutes:
            series.open[m] = series.high[m] = series.low[m] = series.close[m] = None


def _last_minute(root: Path, underlying: str, day: date) -> int:
    """The last grid minute with a real index bar."""
    minutes = _bar_minutes(lake.bars_1m_path(root, "index", underlying, day))
    if not minutes:
        raise LiveSessionError(f"the {underlying} index file for {day.isoformat()} has no bars")
    return max(minutes)


def _epoch(day: date, minute: int) -> int:
    start = datetime(day.year, day.month, day.day, tzinfo=IST) + timedelta(
        minutes=SESSION_START_MIN + minute
    )
    return int(start.timestamp())


def _col(values: list[float | None], n: int) -> list[float | None]:
    return [None if v is None else round(float(v), 2) for v in values[:n]]


def _atm(price: float, step: float) -> float:
    return round(price / step) * step


def _leg(data: DayData, expiry: date, strike: float, side: str) -> Series | None:
    return data.chain.get((expiry, strike, side))


def _sum(ce: float | None, pe: float | None) -> float | None:
    return None if ce is None or pe is None else round(ce + pe, 2)


def _straddles(data: DayData, expiry: date, step: float, n: int) -> dict[str, Any]:
    atm: list[float | None] = []
    rolling_ce: list[float | None] = []
    rolling_pe: list[float | None] = []
    for m in range(n):
        price = data.spot.close[m]
        if price is None:
            atm.append(None)
            rolling_ce.append(None)
            rolling_pe.append(None)
            continue
        strike = _atm(price, step)
        ce, pe = _leg(data, expiry, strike, "CE"), _leg(data, expiry, strike, "PE")
        atm.append(strike)
        rolling_ce.append(None if ce is None else ce.close[m])
        rolling_pe.append(None if pe is None else pe.close[m])

    open_price = data.spot.open[0]
    fixed_strike = None if open_price is None else _atm(open_price, step)
    fce = None if fixed_strike is None else _leg(data, expiry, fixed_strike, "CE")
    fpe = None if fixed_strike is None else _leg(data, expiry, fixed_strike, "PE")
    fixed_ce = _col(fce.close, n) if fce is not None else [None] * n
    fixed_pe = _col(fpe.close, n) if fpe is not None else [None] * n
    open_value = _sum(fce.open[0], fpe.open[0]) if fce is not None and fpe is not None else None
    return {
        "atm": atm,
        "rolling": {
            "ce": _col(rolling_ce, n),
            "pe": _col(rolling_pe, n),
            "straddle": [_sum(c, p) for c, p in zip(rolling_ce, rolling_pe, strict=True)],
        },
        "fixed": {
            "strike": fixed_strike,
            "ce": fixed_ce,
            "pe": fixed_pe,
            "straddle": [_sum(c, p) for c, p in zip(fixed_ce, fixed_pe, strict=True)],
            "open_value": open_value,
        },
    }


def _day_range(series_high: list[float | None], series_low: list[float | None]) -> float | None:
    highs = [v for v in series_high if v is not None]
    lows = [v for v in series_low if v is not None]
    return round(max(highs) - min(lows), 2) if highs and lows else None


def _range_context(root: Path, underlying: str, day: date, data: DayData, n: int) -> dict[str, Any]:
    """The median full-session range of the last 20 sessions, so the page can say how the range
    drawn so far sits against it (the page works out "so far" itself from the high / low series
    up to the minute shown). Descriptive (BL-110); nothing trades on it."""
    earlier = [d for d in market.available_days(root, underlying) if d < day]
    ranges: list[float] = []
    for d in earlier[-RANGE_BASELINE_SESSIONS:]:
        bars = market._load_bars(lake.bars_1m_path(root, "index", underlying, d))
        full = None if bars is None else _day_range(bars.high, bars.low)
        if full is not None:
            ranges.append(full)
    return {
        "median_sessions": len(ranges),
        "median_full_session": round(statistics.median(ranges), 2) if ranges else None,
        "full_session": _day_range(data.spot.high[:n], data.spot.low[:n]),
    }


__all__ = [
    "LiveSessionError",
    "UNDERLYINGS",
    "build_session",
    "live_status",
    "recent_days",
]
