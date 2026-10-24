"""BL-155: the morning type at 11:00 and the charges model. Rules: backlog/BL-155-stop-by-morning-type.md,
Phase 0 (2026-10-22); every constant below is from there.

R = (highest high - lowest low of the bars stamped 09:15 .. 10:59) / the 09:15 open, divided by the
mean of the same over the previous 20 sessions. Quiet R <= 0.80, wide R >= 1.25, normal between.
A bar stamped m covers m .. m + 1, so the bar stamped 10:59 is complete at 11:00.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

OPEN_MIN = 9 * 60 + 15
CHECK_MIN = 11 * 60
LOOKBACK = 20
QUIET, WIDE = 0.80, 1.25

# BL-063's charges model (research/bl063/charges.py) at BL-096's ₹20 an order.
BROKERAGE_PER_ORDER = 20.0
STT_SELL = [("2000-01-01", 0.0010), ("2026-04-01", 0.0015)]  # options sell side, on premium
EXCHANGE = {"NIFTY": 0.0003503, "SENSEX": 0.000325}  # NSE / BSE, both sides
SEBI, IPFT_NSE, STAMP_BUY, GST = 0.000001, 0.000005, 0.00003, 0.18


def minute_bars(index: str, start: str = "2021-10-01") -> pd.DataFrame:
    """The index's 1-minute bars from the lake: day, minute of the day (IST), open, high, low."""
    import duckdb

    from option_backtesting.fyers.daily import data_dir

    c = duckdb.connect()
    return c.execute(
        f"""select date::varchar AS "day", ((epoch(ts) + 19800)::BIGINT % 86400) / 60 m, open, high, low
            from read_parquet('{data_dir() / "lake"}/bars_1m/asset=index/symbol={index}/**/*.parquet',
                              hive_partitioning=true)
            where date >= '{start}' order by 1, 2"""
    ).df()


def morning_types(bars: pd.DataFrame) -> pd.DataFrame:
    """One row per session with a 09:15 bar: rsf (range so far / open), R and the type. Reads only
    bars stamped before 11:00 and, for R, the 20 earlier sessions."""
    b = bars[(bars.m >= OPEN_MIN) & (bars.m < CHECK_MIN)]
    first = b.groupby("day").m.min()
    b = b[b.day.isin(first[first == OPEN_MIN].index)]
    g = b.groupby("day")
    out = pd.DataFrame(
        {
            "open": b[b.m == OPEN_MIN].set_index("day").open,
            "hi": g.high.max(),
            "lo": g.low.min(),
        }
    ).sort_index()
    out["rsf"] = (out.hi - out.lo) / out.open
    out["base"] = out.rsf.shift(1).rolling(LOOKBACK, min_periods=LOOKBACK).mean()
    out["R"] = out.rsf / out.base
    out["type"] = np.select([out.R <= QUIET, out.R >= WIDE], ["quiet", "wide"], "normal")
    out.loc[out.R.isna(), "type"] = None
    return out.reset_index()[["day", "rsf", "R", "type"]]


def stt_rate(day: str) -> float:
    return [rate for start, rate in STT_SELL if day >= start][-1]


def short_leg_charges(index: str, day: str, qty: int, entry: float, exit_: float) -> float:
    """₹ charges of one short leg, one lot: entry order + exit order."""
    sell, buy = entry * qty, exit_ * qty
    both = sell + buy
    brokerage = 2 * BROKERAGE_PER_ORDER
    exch = EXCHANGE[index] * both
    sebi = SEBI * both
    ipft = IPFT_NSE * both if index == "NIFTY" else 0.0
    gst = GST * (brokerage + exch + sebi + ipft)
    return brokerage + stt_rate(day) * sell + exch + sebi + ipft + STAMP_BUY * buy + gst
