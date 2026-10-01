"""
"Day anatomy" — what shape did the INDEX take inside each part of the session?

For each day and each intraday segment (the cuts are caller-chosen, default
10:30 and 13:30 -> open / mid / close) this measures, from the index's 1-minute
bars and India VIX alone:

- ret_pct            net move over the segment
- range_pct          high-low range over the segment
- er                 Kaufman efficiency ratio: |net move| / sum of |1-minute moves|.
                     ~1 is a straight line, ~0 is churn. (A pure random walk
                     scores about sqrt(2 / (pi * n_bars)) — roughly 0.06-0.09 for
                     these segments — which is why TREND_ER below is well above it.)
- implied_pct        the 1-sigma move VIX implies for a segment that long:
                     VIX/100 * sqrt(minutes / (252 * 375)) * 100
- range_over_implied range_pct / (implied_pct * sqrt(8/pi)) — the segment's
                     high-low range against the range a random walk with VIX's
                     volatility is EXPECTED to cover (E[range] = sqrt(8/pi) * sigma
                     ~ 1.6 sigma, which is why plain range / sigma would read 1.6
                     when realised == implied). So ~1.0 means realised vol matched
                     what VIX priced, below 1 is the premium seller's day, above 1
                     the buyer's. Normalising by VIX keeps the labels meaningful in
                     calm and stressed years alike; a fixed "% range" threshold
                     would call every day of a high-vol year a trend.

and labels the segment QUIET / CHOP / TREND_UP / TREND_DOWN.

This is DESCRIPTIVE: a day's own anatomy is only known after the fact. To use it
for anything actionable it must be lagged by a day (the same point-in-time rule
features/regime.py follows) — the dashboard labels the two uses separately.

It is deliberately separate from apps/server's T-33 regime tagger (a whole-day
label from straddle snapshots, in Postgres): different concept, different stack.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from trading_data import lake

from ..data.reference.loader import ReferenceData, default_reference_data
from .market import N_MINUTES, Series, _load_bars, minute_label

DEFAULT_CUTS: tuple[str, ...] = ("10:30", "13:30")

#: A segment whose range is under this fraction of the VIX-implied expected range
#: (i.e. realised vol well under what was priced in) is QUIET. A first-guess constant:
#: calibrate it against the label shares over the backfilled history before trusting it.
QUIET_RANGE_OVER_IMPLIED = 0.6
#: Above QUIET, an efficiency ratio at/above this is a TREND, below it is CHOP.
TREND_ER = 0.15
THRESHOLDS = {"quiet_range_over_implied": QUIET_RANGE_OVER_IMPLIED, "trend_er": TREND_ER}

#: NSE moved NIFTY's weekly expiry to Tuesdays on 1 Sep 2025. The reference
#: expiry_calendar.csv carries the CURRENT weekday back to 2018, so a days-to-
#: expiry derived from it is wrong for any earlier day (NIFTY expired on
#: Thursdays) — it is only emitted from this date on, and `None` before.
DTE_RELIABLE_FROM = date(2025, 9, 1)

_TRADING_MINUTES_PER_YEAR = 252 * 375
#: E[high - low] of Brownian motion over one sigma-unit of time.
_EXPECTED_RANGE_PER_SIGMA = math.sqrt(8 / math.pi)


def parse_cuts(cuts: Sequence[str]) -> list[int]:
    """'10:30' -> minute index. Strictly increasing and strictly inside the session."""
    from .market import minute_index

    try:
        out = [minute_index(c) for c in cuts]
    except (ValueError, AttributeError) as error:
        raise ValueError(f"cuts must be HH:MM times, got {list(cuts)!r}") from error
    if any(not 0 < m < N_MINUTES for m in out):
        raise ValueError("cuts must fall inside the session (09:16-15:29)")
    if any(b <= a for a, b in zip(out, out[1:], strict=False)):
        raise ValueError("cuts must be strictly increasing")
    if len(out) > 4:
        raise ValueError("at most 4 cuts (5 segments)")
    return out


def segment_bounds(cuts: Sequence[int]) -> list[tuple[int, int]]:
    edges = [0, *cuts, N_MINUTES]
    return list(zip(edges, edges[1:], strict=False))


@dataclass(frozen=True)
class Segment:
    start: str
    end: str
    ret_pct: float
    range_pct: float
    er: float
    rv_ann_pct: float | None
    implied_pct: float | None
    range_over_implied: float | None
    label: str

    def as_json(self) -> dict:
        return {
            "start": self.start,
            "end": self.end,
            "ret_pct": _r(self.ret_pct),
            "range_pct": _r(self.range_pct),
            "er": _r(self.er),
            "rv_ann_pct": _r(self.rv_ann_pct),
            "implied_pct": _r(self.implied_pct),
            "range_over_implied": _r(self.range_over_implied),
            "label": self.label,
        }


def _r(value: float | None, digits: int = 3) -> float | None:
    return None if value is None else round(value, digits)


def label_segment(er: float, ret_pct: float, range_over_implied: float | None) -> str:
    if range_over_implied is None:
        return "UNKNOWN"  # no VIX that day: refuse to guess a threshold
    if range_over_implied < QUIET_RANGE_OVER_IMPLIED:
        return "QUIET"
    if er >= TREND_ER:
        return "TREND_UP" if ret_pct > 0 else "TREND_DOWN"
    return "CHOP"


def segment_metrics(spot: Series, vix: Series | None, start: int, end: int) -> Segment | None:
    """Metrics over minutes [start, end). None if the index has no bars there."""
    opens, highs, lows, closes = spot.open, spot.high, spot.low, spot.close
    first = opens[start]
    last = closes[end - 1]
    if first is None or last is None or first <= 0:
        return None
    hi = max((h for h in highs[start:end] if h is not None), default=None)
    lo = min((v for v in lows[start:end] if v is not None), default=None)
    if hi is None or lo is None:
        return None

    path = 0.0
    returns: list[float] = []
    prev = first
    for c in closes[start:end]:
        if c is None:
            continue
        path += abs(c - prev)
        if prev > 0 and c > 0:
            returns.append(math.log(c / prev))
        prev = c
    net = last - first
    er = abs(net) / path if path > 0 else 0.0

    ret_pct = net / first * 100
    range_pct = (hi - lo) / first * 100
    rv = None
    if len(returns) > 2:
        mean = sum(returns) / len(returns)
        var = sum((x - mean) ** 2 for x in returns) / (len(returns) - 1)
        rv = math.sqrt(var * _TRADING_MINUTES_PER_YEAR) * 100

    vix_open = vix.open[start] if vix is not None else None
    implied = None
    if vix_open is not None and vix_open > 0:
        implied = vix_open / 100 * math.sqrt((end - start) / _TRADING_MINUTES_PER_YEAR) * 100
    ratio = range_pct / (implied * _EXPECTED_RANGE_PER_SIGMA) if implied else None
    return Segment(
        start=minute_label(start),
        end=minute_label(end),
        ret_pct=ret_pct,
        range_pct=range_pct,
        er=er,
        rv_ann_pct=rv,
        implied_pct=implied,
        range_over_implied=ratio,
        label=label_segment(er, ret_pct, ratio),
    )


def dte_for(underlying: str, day: date, reference: ReferenceData | None = None) -> int | None:
    """Calendar days to the current expiry, or None where the reference calendar
    cannot be trusted (see DTE_RELIABLE_FROM)."""
    if day < DTE_RELIABLE_FROM:
        return None
    reference = reference or default_reference_data()
    try:
        return (reference.current_expiry(underlying, day) - day).days
    except ValueError:
        return None


def day_anatomy(
    day: date,
    spot: Series,
    vix: Series | None,
    cuts: Sequence[int],
    prev_close: float | None = None,
    dte: int | None = None,
) -> dict:
    segments = [segment_metrics(spot, vix, a, b) for a, b in segment_bounds(cuts)]
    whole = segment_metrics(spot, vix, 0, N_MINUTES)
    open_px = spot.open[0]
    gap = (open_px - prev_close) / prev_close * 100 if open_px is not None and prev_close else None
    vix_open = vix.open[0] if vix is not None else None
    return {
        "day": day.isoformat(),
        "weekday": day.strftime("%a"),
        "gap_pct": _r(gap),
        "vix_open": _r(vix_open, 2),
        "dte": dte,
        "is_expiry": dte == 0 if dte is not None else None,
        "whole": whole.as_json() if whole else None,
        "segments": [s.as_json() if s else None for s in segments],
    }


# ---------------------------------------------------------------------------
# Loading many days (index + VIX only — no option data needed)
# ---------------------------------------------------------------------------

_cache: dict[tuple[str, int], tuple[Series, Series | None]] = {}


def _load_cached(root: Path, underlying: str, day: date) -> tuple[Series, Series | None] | None:
    spot_path = lake.bars_1m_path(root, "index", underlying, day)
    if not spot_path.exists():
        return None
    vix_path = lake.bars_1m_path(root, "index", "INDIAVIX", day)
    # mtime in the key: a re-fetched day replaces its file, and must replace its cache entry
    stamp = spot_path.stat().st_mtime_ns + (vix_path.stat().st_mtime_ns if vix_path.exists() else 0)
    key = (f"{spot_path}", stamp)
    hit = _cache.get(key)
    if hit is not None:
        return hit
    spot = _load_bars(spot_path)
    if spot is None:
        return None
    loaded = (spot, _load_bars(vix_path))
    if len(_cache) > 6000:
        _cache.clear()
    _cache[key] = loaded
    return loaded


def index_days(root: Path, underlying: str) -> list[date]:
    return lake.available_days(root, "index", underlying)


def anatomy_range(
    root: Path,
    underlying: str,
    start: date | None,
    end: date | None,
    cuts: Sequence[int],
    reference: ReferenceData | None = None,
) -> list[dict]:
    """Anatomy for every collected index day in [start, end], oldest first. The
    gap uses the previous COLLECTED day's close, so a hole in the history gives
    a gap measured across the hole rather than a made-up zero."""
    reference = reference or default_reference_data()
    out: list[dict] = []
    prev_close: float | None = None
    for day in index_days(root, underlying):
        loaded = _load_cached(root, underlying, day)
        if loaded is None:
            continue
        spot, vix = loaded
        if (start is None or day >= start) and (end is None or day <= end):
            out.append(
                day_anatomy(day, spot, vix, cuts, prev_close, dte_for(underlying, day, reference))
            )
        last = spot.close[N_MINUTES - 1]
        prev_close = last if last is not None else prev_close
    return out


def anatomy_day(
    root: Path,
    underlying: str,
    day: date,
    cuts: Sequence[int],
    reference: ReferenceData | None = None,
) -> dict | None:
    """One day's anatomy without walking the whole history: loads that day and the
    previous collected one (for the gap). None if the index isn't collected for it."""
    days = index_days(root, underlying)
    if day not in days:
        return None
    loaded = _load_cached(root, underlying, day)
    if loaded is None:
        return None
    i = days.index(day)
    prev_close = None
    if i > 0:
        prev = _load_cached(root, underlying, days[i - 1])
        prev_close = prev[0].close[N_MINUTES - 1] if prev else None
    spot, vix = loaded
    return day_anatomy(day, spot, vix, cuts, prev_close, dte_for(underlying, day, reference))
