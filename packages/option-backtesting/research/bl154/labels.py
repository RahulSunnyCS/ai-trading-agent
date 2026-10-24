"""BL-154: the two opening labels (Phase 0), per index, from the lake's 1-minute index bars.

    gap(d)        = ln(open(d) / previous close) / ATR%(d), signed
    prev-range(d) = (high - low of the previous session) / previous close / ATR%(d)
    ATR%(d)       = mean true range of the 14 sessions before d / previous close

A day's band (lo / mid / hi) is its value against the 1/3 and 2/3 quantiles of the same quantity
over the 252 sessions before it. Everything is known by the 09:16 pick (the open is the 09:15 bar's).
A session with fewer than MIN_BARS one-minute bars (a Muhurat evening, a torn file) is not a session.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

ATR_N = 14
BAND_N = 252
MIN_BARS = 300
INDICES = ("NIFTY", "SENSEX")


def daily_ohlc(root: Path, symbol: str) -> pd.DataFrame:
    """One row per weekday session from the 09:15-15:29 bars (pre-open bars excluded): open
    (09:15 bar), high, low, close (last bar), bars."""
    glob = f"{root}/lake/bars_1m/asset=index/symbol={symbol}/date=*/*.parquet"
    con = duckdb.connect()
    con.execute("SET TimeZone='Asia/Kolkata'")
    df = con.execute(
        f"""
        SELECT CAST(date AS DATE) AS day,
               arg_min(open, ts) AS open, max(high) AS high, min(low) AS low,
               arg_max(close, ts) AS close, count(*) AS bars
        FROM read_parquet('{glob}', hive_partitioning = true)
        WHERE strftime(ts, '%H:%M') BETWEEN '09:15' AND '15:29'
        GROUP BY 1 ORDER BY 1
        """
    ).df()
    df["day"] = pd.to_datetime(df["day"]).dt.date
    df = df[(df["bars"] >= MIN_BARS) & df["day"].map(lambda d: d.weekday() < 5)]
    return df.reset_index(drop=True)


def raw_values(ohlc: pd.DataFrame) -> pd.DataFrame:
    """gap and prev-range for each session from its predecessors (no band yet)."""
    o, h, low, c = (ohlc[k].to_numpy(float) for k in ("open", "high", "low", "close"))
    prev_c = np.r_[np.nan, c[:-1]]
    tr = np.maximum(h, prev_c) - np.minimum(low, prev_c)  # true range of each session
    tr[0] = h[0] - low[0]
    # mean TR of the ATR_N sessions BEFORE d (rows d-ATR_N .. d-1)
    atr = pd.Series(tr).rolling(ATR_N).mean().shift(1).to_numpy()
    atr_pct = atr / prev_c
    gap = np.log(o / prev_c) / atr_pct
    prev_range = np.r_[np.nan, (h - low)[:-1]] / prev_c / atr_pct
    return pd.DataFrame({"day": ohlc["day"], "gap": gap, "prev_range": prev_range})


def bands(values: np.ndarray) -> np.ndarray:
    """lo / mid / hi of each value against the tercile cut-offs of the BAND_N values before it;
    'unknown' without a full history."""
    out = np.full(len(values), "unknown", dtype=object)
    for i in range(len(values)):
        past = values[max(0, i - BAND_N) : i]
        past = past[np.isfinite(past)]
        if len(past) < BAND_N or not np.isfinite(values[i]):
            continue
        q1, q2 = np.quantile(past, [1 / 3, 2 / 3])
        out[i] = "lo" if values[i] <= q1 else "mid" if values[i] <= q2 else "hi"
    return out


def opening_labels(root: Path) -> dict[str, dict[date, tuple[str, str]]]:
    """{index: {day: (gap band, prev-range band)}}."""
    out = {}
    for sym in INDICES:
        v = raw_values(daily_ohlc(root, sym))
        g, r = bands(v["gap"].to_numpy()), bands(v["prev_range"].to_numpy())
        out[sym] = {d: (g[i], r[i]) for i, d in enumerate(v["day"])}
    return out
