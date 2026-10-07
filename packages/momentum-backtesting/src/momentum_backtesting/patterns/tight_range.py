"""Tight range / volatility contraction: a stock in an uptrend trading in a narrow band.

At each week close (weekly bars from the adjusted daily ones):

- uptrend: close above its `above_ma_weeks`-week average and at least `min_above_52w_low` above
  the 52-week low;
- for each window N in `windows_weeks`: the N-week range (highest high - lowest low) / close is
  at most `max_range[N]`, and at most `max_range_vs_own_median` x the median of the stock's own
  N-week range over the previous `own_median_lookback_weeks` weeks (a contraction, not just a
  quiet stock); no bad bar in the window.

The base is the qualifying window that is tightest relative to its limit; the pivot is its
highest high. The volume dry-up (10-day vs 50-day average volume) is recorded, and required only
when the criteria say so.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from . import detector_params
from .bars import SymbolBars
from .common import Base

PATTERN = "tight_range"


def scan(bars: SymbolBars, params: dict | None = None) -> list[Base | None]:
    p = params or detector_params(PATTERN)
    w = bars.weekly()
    high, low, close = (pd.Series(a) for a in (w.high, w.low, w.close))
    bad = pd.Series(w.bad.astype(float))
    lookback = p["own_median_lookback_weeks"]
    up = p["uptrend"]
    uptrend = (close > close.rolling(up["above_ma_weeks"]).mean()) & (
        close >= (1 + up["min_above_52w_low"]) * low.rolling(52).min()
    )
    best_rel = np.full(len(close), np.inf)
    best_n = np.zeros(len(close), dtype=int)
    best = {}
    for n in p["windows_weeks"]:
        top = high.rolling(n).max()
        bottom = low.rolling(n).min()
        width = (top - bottom) / close
        own = width.rolling(lookback, min_periods=int(lookback * 0.8)).median().shift(1)
        limit = p["max_range"][str(n)]
        ok = (
            uptrend
            & (width <= limit)
            & (width <= p["max_range_vs_own_median"] * own)
            & (bad.rolling(n).max() == 0)
        ).to_numpy()
        rel = (width / limit).to_numpy()
        better = ok & (rel < best_rel)
        best_rel[better] = rel[better]
        best_n[better] = n
        best[n] = (top.to_numpy(), width.to_numpy(), own.to_numpy())

    days = pd.Series(bars.volume)
    vd = p["volume_dry_up"]
    ratio = days.rolling(vd["short_days"]).mean() / days.rolling(vd["long_days"]).mean()
    dry = ratio.to_numpy()[bars.week_end]

    out: list[Base | None] = [None] * len(close)
    for k in np.flatnonzero(best_n):
        n = int(best_n[k])
        if vd["required"] and not dry[k] < vd["max_ratio"]:
            continue
        top, width, own = best[n]
        out[k] = Base(
            pivot=float(top[k]),
            start=int(w.start[k - n + 1]),
            end=int(bars.week_end[k]),
            geometry={
                "weeks": n,
                "range": round(float(width[k]), 4),
                "range_vs_own_median": round(float(width[k] / own[k]), 3),
                "volume_10d_vs_50d": round(float(dry[k]), 3) if np.isfinite(dry[k]) else None,
            },
        )
    return out
