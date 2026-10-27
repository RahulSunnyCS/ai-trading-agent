"""The lake's view of a day and of each trip (read-only; blank where the lake has no bars).

- `day_context(root, day)`: India VIX at the open and its percentile among the previous 252
  sessions' opens; per index traded (NIFTY, SENSEX, ...) the gap from the previous close, the
  day's range as a % of the open, and whether its weekly expires that day.
- `trip_extremes(root, trip)`: for a closed trip with fill times, the contract's 1-minute bars
  from its entry minute to its exit minute: the worst point against the position (MAE) and the
  best in its favour (MFE), in rupees for the trip's quantity, and the spot at entry with the
  strike's distance from it. Stock options and days the lake lacks give blanks.
"""

from __future__ import annotations

import csv
from datetime import date, time
from functools import lru_cache
from pathlib import Path

import pyarrow.parquet as pq

from .trips import Trip

REFERENCE = Path(__file__).resolve().parent.parent / "data" / "reference"
VIX = "INDIAVIX"
VIX_LOOKBACK = 252


def _path(root: Path, asset: str, key: str, name: str, day: date) -> Path:
    return (
        root
        / "lake"
        / "bars_1m"
        / f"asset={asset}"
        / f"{key}={name}"
        / f"date={day}"
        / ("data.parquet")
    )


@lru_cache(maxsize=64)
def _index_bars(root: Path, name: str, day: date) -> list[tuple[time, float, float, float, float]]:
    path = _path(root, "index", "symbol", name, day)
    if not path.exists():
        return []
    table = pq.read_table(path, columns=["ts", "open", "high", "low", "close"]).to_pylist()
    return sorted((r["ts"].time(), r["open"], r["high"], r["low"], r["close"]) for r in table)


def _index_days(root: Path, name: str) -> list[date]:
    base = root / "lake" / "bars_1m" / "asset=index" / f"symbol={name}"
    if not base.exists():
        return []
    out = []
    for p in base.iterdir():
        if p.name.startswith("date="):
            try:
                out.append(date.fromisoformat(p.name[5:]))
            except ValueError:
                continue
    return sorted(out)


@lru_cache(maxsize=1)
def _expiries() -> frozenset[tuple[str, date]]:
    out = set()
    with (REFERENCE / "expiries_observed.csv").open(encoding="utf-8") as f:
        for row in csv.DictReader(f):
            try:
                out.add((row["underlying"], date.fromisoformat(row["expiry"])))
            except (KeyError, ValueError):
                continue
    return frozenset(out)


def day_context(root: Path, day: date, underlyings: tuple[str, ...] = ("NIFTY", "SENSEX")) -> dict:
    vix_days = [d for d in _index_days(root, VIX) if d <= day]
    vix_open = None
    vix_pct = None
    if vix_days and vix_days[-1] == day:
        bars = _index_bars(root, VIX, day)
        vix_open = bars[0][1] if bars else None
        history = []
        for d in vix_days[-VIX_LOOKBACK - 1 : -1]:
            b = _index_bars(root, VIX, d)
            if b:
                history.append(b[0][1])
        if vix_open is not None and history:
            vix_pct = round(sum(1 for v in history if v < vix_open) * 100 / len(history), 1)
    indices = {}
    for name in underlyings:
        bars = _index_bars(root, name, day)
        if not bars:
            indices[name] = None
            continue
        earlier = [d for d in _index_days(root, name) if d < day]
        prev = _index_bars(root, name, earlier[-1]) if earlier else []
        prev_close = prev[-1][4] if prev else None
        o = bars[0][1]
        hi = max(b[2] for b in bars)
        lo = min(b[3] for b in bars)
        indices[name] = {
            "open": o,
            "close": bars[-1][4],
            "gap_pct": round((o - prev_close) * 100 / prev_close, 2) if prev_close else None,
            "range_pct": round((hi - lo) * 100 / o, 2) if o else None,
            "expiry_day": (name, day) in _expiries(),
        }
    return {"day": day.isoformat(), "vix_open": vix_open, "vix_pct": vix_pct, "indices": indices}


@lru_cache(maxsize=32)
def _option_bars(root: Path, underlying: str, day: date):
    path = _path(root, "option", "underlying", underlying, day)
    if not path.exists():
        return None
    return pq.read_table(
        path, columns=["ts", "high", "low", "close", "expiry", "strike", "option_type"]
    )


def _hhmm(text: str) -> time:
    h, m, *_ = (int(x) for x in text.split(":"))
    return time(h, m)


def trip_extremes(root: Path, trip: Trip) -> dict:
    blank = {"mae": None, "mfe": None, "spot_at_entry": None, "strike_from_spot": None}
    if (
        trip.status != "closed"
        or not trip.entry_time
        or not trip.exit_time
        or trip.instrument != "OPTIDX"
        or trip.direction is None
        or trip.entry_price is None
    ):
        return blank
    entry, exit_ = _hhmm(trip.entry_time), _hhmm(trip.exit_time)
    spot = None
    for t, _o, _h, _l, c in _index_bars(root, trip.underlying, trip.day):
        if t <= entry:
            spot = c
    out = dict(blank)
    if spot is not None and trip.strike is not None:
        out["spot_at_entry"] = spot
        out["strike_from_spot"] = round(trip.strike - spot, 2)
    table = _option_bars(root, trip.underlying, trip.day)
    if table is None:
        return out
    highs, lows = [], []
    for r in table.to_pylist():
        if (
            r["expiry"] != trip.expiry
            or r["strike"] != trip.strike
            or r["option_type"] != trip.kind
        ):
            continue
        t = r["ts"].time()
        if entry <= time(t.hour, t.minute) <= exit_:
            highs.append(r["high"])
            lows.append(r["low"])
    if not highs:
        return out
    hi, lo, price = max(highs), min(lows), trip.entry_price
    if trip.direction == "short":
        out["mae"] = round(-(hi - price) * trip.qty, 2) if hi > price else 0.0
        out["mfe"] = round((price - lo) * trip.qty, 2) if lo < price else 0.0
    else:
        out["mae"] = round(-(price - lo) * trip.qty, 2) if lo < price else 0.0
        out["mfe"] = round((hi - price) * trip.qty, 2) if hi > price else 0.0
    return out
