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

import pyarrow.compute as pc
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


def _stamp(path: Path) -> tuple[int, int] | None:
    """(mtime, size) of a lake file: the caches below are keyed on it, so a repaired or
    back-filled day is read again."""
    try:
        st = path.stat()
    except FileNotFoundError:
        return None
    return st.st_mtime_ns, st.st_size


def _index_bars(root: Path, name: str, day: date) -> list[tuple[time, float, float, float, float]]:
    path = _path(root, "index", "symbol", name, day)
    return _index_bars_at(path, _stamp(path))


@lru_cache(maxsize=256)
def _index_bars_at(path: Path, stamp) -> list[tuple[time, float, float, float, float]]:
    if stamp is None:
        return []
    table = pq.read_table(path, columns=["ts", "open", "high", "low", "close"]).to_pylist()
    return sorted((r["ts"].time(), r["open"], r["high"], r["low"], r["close"]) for r in table)


def _vix_open(root: Path, day: date) -> float | None:
    path = _path(root, "index", "symbol", VIX, day)
    return _first_open(path, _stamp(path))


@lru_cache(maxsize=4096)
def _first_open(path: Path, stamp) -> float | None:
    """A day's first bar's open, read from that bar alone (the 252-day VIX history)."""
    if stamp is None:
        return None
    table = pq.read_table(path, columns=["ts", "open"])
    if table.num_rows == 0:
        return None
    i = pc.index(table["ts"], pc.min(table["ts"])).as_py()
    return table["open"][i].as_py()


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
        vix_open = _vix_open(root, day)
        history = [
            v for d in vix_days[-VIX_LOOKBACK - 1 : -1] if (v := _vix_open(root, d)) is not None
        ]
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


def _contract_bars(root: Path, trip: Trip) -> list[tuple[time, float, float]]:
    """The trip's contract's 1-minute bars on its day: (minute, high, low)."""
    path = _path(root, "option", "underlying", trip.underlying, trip.day)
    return _contract_bars_at(path, _stamp(path), trip.expiry, trip.strike, trip.kind)


@lru_cache(maxsize=512)
def _contract_bars_at(path: Path, stamp, expiry, strike, kind) -> list[tuple[time, float, float]]:
    if stamp is None or expiry is None or strike is None or kind is None:
        return []
    table = pq.read_table(path, columns=["ts", "high", "low", "expiry", "strike", "option_type"])
    mask = pc.and_(
        pc.and_(pc.equal(table["expiry"], expiry), pc.equal(table["strike"], strike)),
        pc.equal(table["option_type"], kind),
    )
    rows = table.filter(mask).to_pylist()
    return sorted((time(r["ts"].hour, r["ts"].minute), r["high"], r["low"]) for r in rows)


def _hhmm(text: str) -> time:
    h, m, *_ = (int(x) for x in text.split(":"))
    return time(h, m)


def trip_extremes(root: Path, trip: Trip) -> dict:
    """MAE / MFE for a trip opened and closed on one day with fill times. The entry price is the
    fills' price before brokerage; the whole quantity is counted from the first entry minute."""
    blank = {"mae": None, "mfe": None, "spot_at_entry": None, "strike_from_spot": None}
    if (
        trip.status != "closed"
        or trip.entry_day != trip.day
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
    bars = [(h, lo) for t, h, lo in _contract_bars(root, trip) if entry <= t <= exit_]
    if not bars:
        return out
    hi, lo, price = max(b[0] for b in bars), min(b[1] for b in bars), trip.entry_price
    if trip.direction == "short":
        out["mae"] = round(-(hi - price) * trip.qty, 2) if hi > price else 0.0
        out["mfe"] = round((price - lo) * trip.qty, 2) if lo < price else 0.0
    else:
        out["mae"] = round(-(price - lo) * trip.qty, 2) if lo < price else 0.0
        out["mfe"] = round((hi - price) * trip.qty, 2) if hi > price else 0.0
    return out
