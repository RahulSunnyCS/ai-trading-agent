"""Fill prices for a Monday run of a stock-based dataset: the open (BL-036 Phase 2, BL-010 E13)
or the close (BL-176) of the first session after the signal Friday.

A weekly run fills at Friday's close. The owner's trade is Friday signal, Monday buy, so the
price an order decided on Friday W really gets is the open of the first session after W. The
engine already takes a separate fill table (`run_backtest(trade_prices=...)`, the ETF dataset's
`execution="mon_open"`): row W holds the price a trade decided on W fills at, and every buy, sell
and holding is valued on it. This builds that table for the dataset's own columns:

  stock columns   the weekly (split-adjusted) close of W times one plus the first session's
                  `open_gap` (open / prior close) for the open, or its `move` (close / prior
                  close) for the close; the prior close is adjusted for a split or bonus on that
                  day (`categories/daily_moves.py`). A session with no bar reads as 0 in both, so
                  a suspended stock fills at the Friday close, which is the only price it has.
  other columns   the index, ETF or fund: its `daily/<name>.csv` Monday open or close
                  (`trade_prices.fills`; a series with no open uses that day's close). A column
                  with no such file fills at W's close when a next session exists.

A week with no session within `MAX_GAP_DAYS` after it has no fill (NaN): the engine leaves the
newest signal week out of a Monday run until Monday has happened.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd

from .categories import daily_moves
from .config import DATA_DIR
from .trade_prices import MAX_GAP_DAYS, build_trade_prices


@dataclass
class MondayFills:
    prices: pd.DataFrame  # signal week x column, same columns as the weekly table
    #: columns that fill at the signal close because no Monday price exists for them
    at_signal_close: list[str] = field(default_factory=list)


#: The Monday fills this module builds, and the daily-moves table each one reads for stocks.
SESSION_FIELD = {"mon_open": "open_gap", "mon_close": "move"}


def build(
    prices: pd.DataFrame,
    column_to_base: dict[str, str],
    *,
    execution: str = "mon_open",
    data_dir: Path | None = None,
    root: Path | None = None,
) -> MondayFills:
    """The Monday table for the weekly table `prices` (Friday-labelled rows): the first session's
    open (`execution="mon_open"`) or close (`"mon_close"`). Stock columns are the keys of
    `column_to_base`; every other column is priced from its daily file."""
    if execution not in SESSION_FIELD:
        raise ValueError(f"no Monday fill {execution!r}; choose one of {sorted(SESSION_FIELD)}")
    data_dir = data_dir or DATA_DIR
    weeks = prices.index
    stock_cols = [c for c in prices.columns if c in column_to_base]
    other = [c for c in prices.columns if c not in column_to_base]
    moves = daily_moves.daily_moves(
        {c: column_to_base[c] for c in stock_cols},
        str(weeks[0].date()),
        str((weeks[-1] + pd.Timedelta(days=MAX_GAP_DAYS + 7)).date()),
        root=root,
    )
    sessions: list[pd.Timestamp | None] = []
    for week in weeks:
        day = moves.next_day(week)
        sessions.append(day if day is not None and (day - week).days <= MAX_GAP_DAYS else None)
    has_session = pd.Series([d is not None for d in sessions], index=weeks)
    out = pd.DataFrame(index=weeks, columns=prices.columns, dtype="float64")
    if stock_cols:
        # One lookup per week, then one multiply: the first session's gap or move, by column.
        gaps = getattr(moves, SESSION_FIELD[execution]).reindex(
            pd.DatetimeIndex([d if d is not None else pd.NaT for d in sessions])
        )
        gaps.index = weeks
        out[stock_cols] = prices[stock_cols] * (1.0 + gaps[stock_cols])

    at_close = []
    files = [c for c in other if (data_dir / "daily" / f"{c}.csv").exists()]
    if files:
        built = build_trade_prices(prices[files], "index", execution, data_dir=data_dir)
        if built is not None:
            for col in files:
                out[col] = built.prices[col]
    for col in other:
        if col in files:
            continue
        at_close.append(col)
        out[col] = prices[col].where(has_session)
    return MondayFills(prices=out, at_signal_close=at_close)
