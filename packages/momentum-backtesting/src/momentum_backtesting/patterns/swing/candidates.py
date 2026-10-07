"""BL-043 Phase 1: entry candidates at every daily close (bl043_criteria.json `patterns`,
`entries`, `universe`).

For each symbol and session d, using bars up to d only:

- a tight range or flag base is checked at d's close, with daily-window equivalents of BL-042's
  weekly rules (N weeks = 5N sessions, a year = 260);
- **pullback**: the base holds at d and the close is more than 5% below its pivot;
- **breakout**: a base held at d-1 and d closes above that base's pivot on volume at least 1.5x
  the 50-session average before d.

A candidate also records what the simulator and the score need: the pivot, the base's low (the
flag's low for a flag), ATR(14), whether the close is above its 50-session average, the
quality grade, and a base id (the first session of the unbroken run of days the base held) so
that a base is traded at most once. Fills happen at the next session's open, in the simulator.
"""

from __future__ import annotations

import json
import os
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import pandas as pd

from .. import detector_params
from ..bars import SymbolBars, split_symbols
from ..common import average_volume
from ..flag import flag_at
from ..quality import grade
from . import criteria

NEAR_PIVOT = 0.05
BREAKOUT_VOLUME = 1.5
COLUMNS = (
    "symbol", "date", "pattern", "entry", "base_id", "pivot", "base_low", "atr", "close",
    "scale", "above_50dma", "quality", "geometry",
)  # fmt: skip


def _context(bars: SymbolBars) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(uptrend, near_high, tight-range uptrend) per session, daily forms of BL-042's rules."""
    spec = criteria()["patterns"]["daily_equivalents"]
    week, year = spec["week"], spec["year"]
    close, high, low = (pd.Series(a) for a in (bars.close, bars.high, bars.low))
    tr = detector_params("tight_range")
    above = close > close.rolling(tr["uptrend"]["above_ma_weeks"] * week).mean()
    near = (
        close
        >= tr["near_high"]["min_close_vs_52w_high"]
        * high.rolling(year, min_periods=year // 2).max()
    )
    off_low = close >= (1 + tr["uptrend"]["min_above_52w_low"]) * low.rolling(year).min()
    return above.to_numpy(), near.to_numpy(), (above & near & off_low).to_numpy()


def _tight_range(bars: SymbolBars, setting: np.ndarray) -> dict[str, np.ndarray]:
    """Per session: does a tight range hold at this close, and its pivot / start / low / parts."""
    p = detector_params("tight_range")
    spec = criteria()["patterns"]["daily_equivalents"]
    week, year = spec["week"], spec["year"]
    close, high, low = (pd.Series(a) for a in (bars.close, bars.high, bars.low))
    bad = pd.Series(bars.bad.astype(float))
    n = len(close)
    best_rel = np.full(n, np.inf)
    out = {k: np.full(n, np.nan) for k in ("pivot", "start", "low", "weeks", "range", "rel")}
    for weeks in p["windows_weeks"]:
        span = weeks * week
        top, bottom = high.rolling(span).max(), low.rolling(span).min()
        width = (top - bottom) / close
        own = width.rolling(year, min_periods=int(year * 0.8)).median().shift(1)
        limit = p["max_range"][str(weeks)]
        ok = (
            setting
            & (width <= limit).to_numpy()
            & (width <= p["max_range_vs_own_median"] * own).to_numpy()
            & (bad.rolling(span).max() == 0).to_numpy()
        )
        rel = (width / limit).to_numpy()
        better = ok & (rel < best_rel)
        best_rel[better] = rel[better]
        idx = np.arange(n)
        out["pivot"][better] = top.to_numpy()[better]
        out["start"][better] = (idx - span + 1)[better]
        out["low"][better] = bottom.to_numpy()[better]
        out["weeks"][better] = weeks
        out["range"][better] = width.to_numpy()[better]
        out["rel"][better] = (width / own).to_numpy()[better]
    vol = pd.Series(bars.volume)
    out["dry"] = (vol.rolling(10).mean() / vol.rolling(50).mean()).to_numpy()
    out["valid"] = np.isfinite(best_rel)
    return out


def _runs(valid: np.ndarray) -> np.ndarray:
    """For each session, the index of the first session of its unbroken run of valid days."""
    out = np.full(len(valid), -1)
    start = -1
    for i, v in enumerate(valid):
        if v:
            start = i if start < 0 else start
            out[i] = start
        else:
            start = -1
    return out


def _atr(bars: SymbolBars, days: int = 14) -> np.ndarray:
    prev = np.r_[np.nan, bars.close[:-1]]
    tr = np.nanmax(
        np.vstack([bars.high - bars.low, np.abs(bars.high - prev), np.abs(bars.low - prev)]),
        axis=0,
    )
    return pd.Series(tr).rolling(days).mean().to_numpy()


def scan_symbol(bars: SymbolBars, members: dict[int, set[str]] | None) -> list[dict]:
    uni = criteria()["universe"]["tradable_on_signal_day"]
    above, near, tight_setting = _context(bars)
    flag_setting = above & near
    n = len(bars.close)
    close = bars.close
    raw_close = close / bars.scale
    turnover = pd.Series(close * bars.volume).rolling(60).median().to_numpy()
    ok_day = (raw_close >= uni["min_close_rs"]) & (
        turnover >= uni["min_median_turnover_cr_60d"] * 1e7
    )
    years = pd.DatetimeIndex(bars.dates).year
    if members is not None:
        ok_day &= np.array([bars.symbol in members.get(int(y), ()) for y in years])
    # no bad bar in the ATR window (14 true ranges reach back 15 sessions)
    ok_day &= pd.Series(bars.bad.astype(float)).rolling(15, min_periods=1).max().to_numpy() == 0
    avg = average_volume(bars.volume)
    atr = _atr(bars)
    dma50 = pd.Series(close).rolling(50).mean().to_numpy()

    tight = _tight_range(bars, tight_setting)
    fp = detector_params("flag")
    flag = {k: np.full(n, np.nan) for k in ("pivot", "start", "low")}
    flag_geo: dict[int, dict] = {}
    for i in np.flatnonzero(flag_setting):
        found = flag_at(bars, int(i), fp)
        if found:
            base, flag_low = found
            flag["pivot"][i], flag["start"][i], flag["low"][i] = base.pivot, base.start, flag_low
            flag_geo[i] = base.geometry
    flag["valid"] = np.isfinite(flag["pivot"])

    run_day = np.datetime_as_string(bars.dates, unit="D")
    rows: list[dict] = []
    for pattern, base in (("tight_range", tight), ("flag", flag)):
        runs = _runs(base["valid"])
        for d in np.flatnonzero(ok_day):
            for entry, at in (("pullback", d), ("breakout", d - 1)):
                if at < 0 or not base["valid"][at]:
                    continue
                pivot = base["pivot"][at]
                if entry == "pullback" and not close[d] < pivot * (1 - NEAR_PIVOT):
                    continue
                if entry == "breakout":
                    surge = bars.volume[d] >= BREAKOUT_VOLUME * avg[d]
                    if bars.bad[d] or not (close[d] > pivot and surge):
                        continue
                if pattern == "tight_range":
                    geometry = {
                        "weeks": int(base["weeks"][at]),
                        "range": round(float(base["range"][at]), 4),
                        "range_vs_own_median": round(float(base["rel"][at]), 3),
                        "volume_10d_vs_50d": round(float(base["dry"][at]), 3)
                        if np.isfinite(base["dry"][at])
                        else None,
                    }
                else:
                    geometry = flag_geo[at]
                rows.append(
                    {
                        "symbol": bars.symbol,
                        "date": pd.Timestamp(bars.dates[d]),
                        "pattern": pattern,
                        "entry": entry,
                        "base_id": f"{bars.symbol}|{pattern}|{run_day[runs[at]]}",
                        "pivot": float(pivot),
                        "base_low": float(base["low"][at]),
                        "atr": float(atr[d]),
                        "close": float(close[d]),
                        "scale": float(bars.scale[d]),
                        "above_50dma": bool(close[d] > dma50[d]),
                        "quality": grade(pattern, geometry),
                        "geometry": json.dumps(geometry, sort_keys=True),
                    }
                )
    return rows


def _chunk(args) -> list[dict]:
    chunk, members = args
    out: list[dict] = []
    for bars in chunk:
        out.extend(scan_symbol(bars, members))
    return out


def scan(
    daily: pd.DataFrame,
    members: dict[int, set[str]] | None = None,
    *,
    since: str | pd.Timestamp | None = None,
    workers: int | None = None,
) -> pd.DataFrame:
    """Every candidate in `daily` (bars.adjust output). `members` (year -> symbols) restricts
    to the point-in-time universe; None = every symbol."""
    symbols = list(split_symbols(daily).values())
    workers = workers if workers is not None else min(8, os.cpu_count() or 1)
    if workers <= 1 or len(symbols) < 20:
        rows = _chunk((symbols, members))
    else:
        parts = [symbols[i :: workers * 4] for i in range(workers * 4)]
        with ProcessPoolExecutor(workers) as pool:
            rows = [r for part in pool.map(_chunk, [(c, members) for c in parts]) for r in part]
    frame = pd.DataFrame(rows, columns=list(COLUMNS))
    for column in ("symbol", "pattern", "entry", "base_id", "geometry"):
        frame[column] = frame[column].astype(object)
    frame["date"] = pd.to_datetime(frame["date"]).astype("datetime64[ns]")
    for column in ("pivot", "base_low", "atr", "close", "scale", "quality"):
        frame[column] = frame[column].astype(float)
    frame["above_50dma"] = frame["above_50dma"].astype(bool)
    if since is not None:
        frame = frame[frame["date"] >= pd.Timestamp(since)]
    return frame.sort_values(["date", "symbol", "pattern", "entry"]).reset_index(drop=True)
