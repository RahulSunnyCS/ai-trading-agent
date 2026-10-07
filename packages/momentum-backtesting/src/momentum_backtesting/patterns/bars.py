"""Daily OHLCV for pattern detection, adjusted causally, plus the weekly view of it.

`bars_1d_stock` holds raw exchange bars: a split or bonus shows up as a price drop. The
package's confirmed share factors (`stock_actions.confirmed_factors`, the same ones
`categories/prices.py` back-adjusts closes with) are applied *forward* here: every bar on or
after an ex-date is multiplied by the factor, i.e. put on the pre-event scale. A bar's adjusted
value then depends only on events up to its own date, so data cut at any Friday gives the same
adjusted bars up to that Friday (no look-ahead by construction). Every pattern measure is a
ratio inside its window, so the scale itself never matters; `scale` keeps the cumulative factor
so a price can be shown as it traded on the day.

A bar is `bad` when it is not trustworthy for shape-reading: the day after a gap of more than
`MAX_GAP_DAYS` market days, a one-day move beyond `MAX_UNEXPLAINED_MOVE` that no confirmed
factor explains (an unconfirmed corporate action, or a data error), or (addendum 2) a wick more
than `max_wick` beyond the bar's own open and close (a bad print). Detectors refuse a window
that contains one.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from . import guard

MAX_GAP_DAYS = 5
MAX_UNEXPLAINED_MOVE = 0.25
COLUMNS = ("date", "symbol", "open", "high", "low", "close", "volume")


def friday(dates: pd.Series | pd.DatetimeIndex) -> pd.DatetimeIndex:
    """The Friday label of each date's week (Monday-Sunday), as every weekly frame here uses."""
    idx = pd.DatetimeIndex(dates)
    return (idx - pd.to_timedelta(idx.weekday, unit="D") + pd.Timedelta(days=4)).normalize()


def adjust(
    daily: pd.DataFrame, factors: dict[str, list[tuple[pd.Timestamp, float]]]
) -> pd.DataFrame:
    """Forward-adjust `daily` (COLUMNS, any order) by confirmed share factors and flag bad bars.

    Returns the frame sorted by symbol then date with `scale` (the cumulative factor applied:
    adjusted price = traded price x scale) and `bad`."""
    frame = daily.loc[:, list(COLUMNS)].sort_values(["symbol", "date"]).reset_index(drop=True)
    frame["date"] = pd.to_datetime(frame["date"])
    market_days = pd.DatetimeIndex(np.sort(frame["date"].unique()))
    position = market_days.get_indexer(frame["date"])
    scale = np.ones(len(frame))
    explained = np.zeros(len(frame), dtype=bool)
    dates = frame["date"].to_numpy()
    for symbol, rows in frame.groupby("symbol", sort=False).indices.items():
        for ex_date, factor in factors.get(symbol, ()):
            on_after = rows[dates[rows] >= np.datetime64(ex_date)]
            scale[on_after] *= factor
            if len(on_after):
                explained[on_after[0]] = True
    for column in ("open", "high", "low", "close"):
        frame[column] = frame[column].to_numpy(dtype=float) * scale
    frame["volume"] = frame["volume"].to_numpy(dtype=float) / scale
    frame["scale"] = scale

    same = frame["symbol"].to_numpy()[1:] == frame["symbol"].to_numpy()[:-1]
    first = np.r_[True, ~same]
    gap = np.r_[False, (np.diff(position) > MAX_GAP_DAYS + 1) & same]
    close = frame["close"].to_numpy()
    move = np.r_[np.nan, close[1:] / close[:-1] - 1]
    jump = (np.abs(move) > MAX_UNEXPLAINED_MOVE) & ~first & ~explained
    frame["bad"] = gap | jump | _wicks(frame)
    return frame


def load_daily(
    symbols: list[str],
    *,
    through: str | pd.Timestamp,
    since: str | pd.Timestamp = "2011-01-01",
    allow_holdout: bool = False,
    root: Path | None = None,
) -> pd.DataFrame:
    """Adjusted daily bars for `symbols` from the shared database, never past `through`
    (which `guard` checks against the sealed hold-out)."""
    from trading_data.db import connect, data_root

    from .. import db_read, stock_actions

    cut = guard(through, allow_holdout=allow_holdout)
    root = root or data_root()
    with connect(root, read_only=True) as con:
        raw = con.execute(
            "SELECT b.date, i.symbol, b.open, b.high, b.low, b.close, b.volume "
            "FROM bars_1d_stock b JOIN instruments i USING (instrument_id) "
            "WHERE i.symbol IN (SELECT unnest(?)) AND b.date BETWEEN ? AND ? "
            "ORDER BY i.symbol, b.date",
            [sorted(set(symbols)), pd.Timestamp(since).date(), cut.date()],
        ).df()
        factors = {}
        if db_read._has_table(con, "stock_action_candidates"):
            factors = stock_actions.confirmed_factors(con, sorted(set(symbols)))
    # A factor whose ex-date is after the cut is unknowable at the cut and touches no loaded bar.
    return adjust(raw, factors)


@dataclass(frozen=True)
class SymbolBars:
    """One symbol's adjusted daily bars as arrays, and the week each Friday closes."""

    symbol: str
    dates: np.ndarray  # datetime64[ns]
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    volume: np.ndarray
    scale: np.ndarray
    bad: np.ndarray
    week_end: np.ndarray  # index of the last daily bar of each week
    fridays: pd.DatetimeIndex  # the label of each of those weeks

    @classmethod
    def from_frame(cls, symbol: str, frame: pd.DataFrame) -> SymbolBars:
        dates = frame["date"].to_numpy()
        labels = friday(frame["date"])
        last = np.r_[labels[1:] != labels[:-1], True]
        return cls(
            symbol=symbol,
            dates=dates,
            open=frame["open"].to_numpy(dtype=float),
            high=frame["high"].to_numpy(dtype=float),
            low=frame["low"].to_numpy(dtype=float),
            close=frame["close"].to_numpy(dtype=float),
            volume=frame["volume"].to_numpy(dtype=float),
            scale=frame["scale"].to_numpy(dtype=float),
            bad=frame["bad"].to_numpy(dtype=bool),
            week_end=np.flatnonzero(last),
            fridays=labels[last],
        )

    def weekly(self) -> Weekly:
        """Weekly high / low / close / volume, and whether the week holds a bad bar."""
        ends = self.week_end
        starts = np.r_[0, ends[:-1] + 1]
        high = np.maximum.reduceat(self.high, starts)
        low = np.minimum.reduceat(self.low, starts)
        volume = np.add.reduceat(self.volume, starts)
        bad = np.maximum.reduceat(self.bad.astype(np.int8), starts).astype(bool)
        return Weekly(
            high=high, low=low, close=self.close[ends], volume=volume, bad=bad, start=starts
        )


@dataclass(frozen=True)
class Weekly:
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    volume: np.ndarray
    bad: np.ndarray
    start: np.ndarray  # index of each week's first daily bar


def split_symbols(frame: pd.DataFrame) -> dict[str, SymbolBars]:
    return {
        symbol: SymbolBars.from_frame(symbol, frame.iloc[rows])
        for symbol, rows in frame.groupby("symbol", sort=False).indices.items()
    }


def _wicks(frame: pd.DataFrame) -> np.ndarray:
    """A low far below (or a high far above) the bar's own open and close: a bad print. Off
    unless the criteria set `bad_bar_wick.max_wick`."""
    from . import criteria

    limit = criteria().get("bad_bar_wick", {}).get("max_wick")
    if limit is None:
        return np.zeros(len(frame), dtype=bool)
    body_lo = np.minimum(frame["open"].to_numpy(), frame["close"].to_numpy())
    body_hi = np.maximum(frame["open"].to_numpy(), frame["close"].to_numpy())
    return (frame["low"].to_numpy() < body_lo * (1 - limit)) | (
        frame["high"].to_numpy() > body_hi * (1 + limit)
    )
