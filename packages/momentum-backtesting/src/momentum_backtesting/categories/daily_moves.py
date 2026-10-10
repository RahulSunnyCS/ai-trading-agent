"""Daily moves for the daily stop-loss (BL-054 lever L4).

`engine.Config.stop_granularity="daily"` walks a holding day by day between two Friday closes.
It needs, for every engine column, three daily tables on one trading-date index:

  move      close / prevclose - 1, with `prevclose` divided by the confirmed share-count
            factor on a confirmed split or bonus day (stock_actions.confirmed_factors, the
            same factors the weekly price series uses), so that day reads about 0, not -50%.
            A fall still under review is left as a real fall, as in the weekly series.
  open_gap  open / prevclose - 1: where the next morning opens against the previous close.
  locked    the stock could not be sold that day: no bar at all (suspended), or it opened and
            closed at its lower circuit band edge (nobody to sell to all day). Known only in
            hindsight, like `circuit_exposure.lock_masks`; conservative on purpose.

A missing bar reads as move 0, open_gap 0 and locked.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

from ..db_read import data_version, open_catalog, stock_bars
from ..stock_actions import confirmed_factors
from .circuit_exposure import _BANDS

_cache: dict[tuple, DailyMoves] = {}


@dataclass
class DailyMoves:
    move: pd.DataFrame
    open_gap: pd.DataFrame
    locked: pd.DataFrame

    @property
    def dates(self) -> pd.DatetimeIndex:
        return pd.DatetimeIndex(self.move.index)

    def days_between(self, after: pd.Timestamp, until: pd.Timestamp) -> list[pd.Timestamp]:
        """Trading dates d with after < d <= until."""
        dates = self.dates
        lo = dates.searchsorted(pd.Timestamp(after), side="right")
        hi = dates.searchsorted(pd.Timestamp(until), side="right")
        return list(dates[lo:hi])

    def next_day(self, day: pd.Timestamp) -> pd.Timestamp | None:
        dates = self.dates
        i = dates.searchsorted(pd.Timestamp(day), side="right")
        return dates[i] if i < len(dates) else None


def _at_lower_edge(ratio: pd.DataFrame) -> pd.DataFrame:
    hit = pd.DataFrame(False, index=ratio.index, columns=ratio.columns)
    for lo, hi in _BANDS:
        hit |= ((-ratio).ge(lo) & (-ratio).le(hi)).fillna(False)
    return hit


def daily_moves(
    column_to_base: dict[str, str], start: str, end: str, *, root: Path | None = None
) -> DailyMoves:
    symbols = sorted(set(column_to_base.values()))
    # The result is built per engine column, so the mapping is part of the key: the same symbols
    # under other column names (a `legacy` vs `verified` series break, `SYM` vs `SYM#2`) must not
    # get another run's columns.
    cache_key = (
        data_version(root),
        tuple(symbols),
        tuple(sorted(column_to_base.items())),
        str(start),
        str(end),
    )
    hit = _cache.get(cache_key)
    if hit is not None:
        return hit
    first = (pd.Timestamp(start) - pd.Timedelta(days=60)).date()
    last = pd.Timestamp(end).date()
    sql = """
    select i.symbol, b.date, b.open, b.close, b.prevclose
    from bars_1d_stock b join instruments i using (instrument_id)
    where i.symbol in (select unnest(?)) and b.series = 'EQ' and b.date between ? and ?"""
    with stock_bars(root) as con:
        frame = con.execute(sql, [symbols, first, last]).df()
    frame["date"] = pd.to_datetime(frame["date"])
    with open_catalog(root, read_only=True) as con:
        factors = confirmed_factors(con, symbols)
    divisor = pd.Series(1.0, index=pd.MultiIndex.from_frame(frame[["symbol", "date"]]))
    raw = (frame["close"] / frame["prevclose"].where(frame["prevclose"] > 0)).to_numpy()
    raw = pd.Series(raw, index=divisor.index)
    for symbol, events in factors.items():
        for ex_date, factor in events:
            at = (symbol, ex_date)
            if not (factor and factor > 0 and at in divisor.index):
                continue
            # Only an unadjusted prevclose shows the factor's jump: apply it when the day's raw
            # close/prevclose is nearer (in log terms) to 1/factor than to 1, so a source row
            # that is already adjusted is not divided twice into a phantom move.
            ratio = raw.loc[at]
            ratio = float(ratio.iloc[0]) if isinstance(ratio, pd.Series) else float(ratio)
            if ratio > 0 and abs(np.log(ratio * factor)) < abs(np.log(ratio)):
                divisor[at] = factor
    prev = (frame["prevclose"] / divisor.to_numpy()).where(frame["prevclose"] > 0)
    frame["move"] = frame["close"] / prev - 1
    frame["gap"] = frame["open"] / prev - 1

    def wide(field: str) -> pd.DataFrame:
        return frame.pivot_table(index="date", columns="symbol", values=field, aggfunc="last")

    move, gap = wide("move"), wide("gap")
    dates = move.index.sort_values()
    move, gap = move.reindex(dates), gap.reindex(dates)
    locked = _at_lower_edge(move) & _at_lower_edge(gap) | move.isna()
    columns = list(column_to_base)
    by_symbol = {"move": move, "gap": gap, "locked": locked}

    def per_column(table: pd.DataFrame, fill) -> pd.DataFrame:
        out = pd.DataFrame(
            {col: table.get(base, np.nan) for col, base in column_to_base.items()},
            index=dates,
            columns=columns,
        )
        return out.fillna(fill)

    result = DailyMoves(
        move=per_column(by_symbol["move"], 0.0),
        open_gap=per_column(by_symbol["gap"], 0.0),
        locked=per_column(by_symbol["locked"].astype(float), 1.0).astype(bool),
    )
    if len(_cache) > 3:
        _cache.clear()
    _cache[cache_key] = result
    return result
