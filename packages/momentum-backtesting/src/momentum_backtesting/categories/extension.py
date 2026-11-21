"""How far each stock's close sits above its 200-day EMA, per week (BL-233, research).

`engine.Config.extension_exit` sells or halves a holding whose close is more than that much above
its daily EMA. The table here is that number, close / EMA - 1, for every engine column:

  - the close is a split- and bonus-adjusted daily level built from `daily_moves` (the same
    confirmed factors the weekly price series uses), so a split does not read as a crash;
  - the EMA is `ewm(span=200, adjust=False)`, causal; a stock needs `span` trading days of
    history from its first bar before it has a value;
  - each week reads the last trading day on or before that week's date.

A column with no daily stock bars (gold, silver, debt, cash) is all NaN, and NaN never acts.
The engine shifts the table by `signal_delay` with the ranks.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from ..db_read import data_version
from . import daily_moves

_cache: dict[tuple, pd.DataFrame] = {}


def from_moves(move: pd.DataFrame, has_bar: pd.DataFrame, span: int = 200) -> pd.DataFrame:
    """Daily close / EMA - 1 from daily moves. `has_bar` marks days the stock traded; the level
    starts at a stock's first such day, and the EMA needs `span` days from there."""
    started = has_bar.cummax()
    level = (1 + move.where(started, 0.0)).cumprod().where(started)
    ema = level.ewm(span=span, adjust=False, min_periods=span).mean()
    return level / ema - 1


def weekly(daily: pd.DataFrame, weeks: pd.DatetimeIndex) -> pd.DataFrame:
    """The last daily value on or before each week (never a later day)."""
    daily = daily.sort_index()
    at = daily.index.searchsorted(weeks, side="right") - 1
    out = daily.to_numpy()[np.clip(at, 0, None)]
    out[at < 0] = np.nan
    return pd.DataFrame(out, index=weeks, columns=daily.columns)


def extension_table(
    columns: list[str], weeks: pd.DatetimeIndex, *, span: int = 200, root: Path | None = None
) -> pd.DataFrame:
    """Week x column extension for the engine. Columns are engine columns (`SYM` or `SYM#2`)."""
    key = (data_version(root), tuple(columns), tuple(weeks), span)
    hit = _cache.get(key)
    if hit is not None:
        return hit
    # Two years before the first week, so the EMA is warm when the run starts.
    start = (weeks[0] - pd.Timedelta(days=730)).date()
    moves = daily_moves.daily_moves(
        {col: col.split("#", 1)[0] for col in columns}, str(start), str(weeks[-1].date()), root=root
    )
    # A missing bar reads as locked in DailyMoves; a lower-circuit day also does, and that only
    # delays a stock's first day if it opened its listing locked at the lower band.
    table = weekly(from_moves(moves.move, ~moves.locked, span), pd.DatetimeIndex(weeks))
    if len(_cache) > 3:
        _cache.clear()
    _cache[key] = table
    return table
