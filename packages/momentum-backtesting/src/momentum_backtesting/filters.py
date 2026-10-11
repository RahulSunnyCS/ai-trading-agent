"""BL-050: the seven per-stock filter features, weekly and point in time.

Every function takes Friday-labelled weekly tables (weeks x engine column) and returns one,
using only rows up to each week. Definitions are the ones committed in
`search_spaces/bl050_criteria.json`; this module never restates a threshold the criteria
file does not name.

Tilts return a value where higher is better (`v1_turnover_expansion`, `v2_accumulation`,
`m2_residual_sum`, `t1_trend_quality`). Gates return a boolean table where True means "may not
be bought this week" (`v3_quiet_or_building_blocked`, `r1_relative_strength_blocked`,
`m1_overextended_blocked`); a week with too little data never blocks.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

from .db_read import stock_bars


def daily_turnover(
    column_to_base: dict[str, str], start: str, end: str, *, root: Path | None = None
) -> pd.DataFrame:
    """Trading date x engine column: rupee turnover of the EQ series (0 never stands in for a
    missing bar; a missing bar is NaN)."""
    symbols = sorted(set(column_to_base.values()))
    sql = """
    select i.symbol, b.date, b.turnover
    from bars_1d_stock b join instruments i using (instrument_id)
    where i.symbol in (select unnest(?)) and b.series = 'EQ' and b.date between ? and ?"""
    with stock_bars(root) as con:
        frame = con.execute(
            sql, [symbols, pd.Timestamp(start).date(), pd.Timestamp(end).date()]
        ).df()
    frame["date"] = pd.to_datetime(frame["date"])
    wide = frame.pivot_table(index="date", columns="symbol", values="turnover", aggfunc="sum")
    wide = wide.where(wide > 0)
    return pd.DataFrame(
        {col: wide.get(base, np.nan) for col, base in column_to_base.items()},
        index=wide.index,
    )


def _at_weeks(daily: pd.DataFrame, weeks: pd.DatetimeIndex) -> pd.DataFrame:
    """The last daily row on or before each week label."""
    return daily.reindex(daily.index.union(weeks)).ffill().reindex(weeks)


def weekly_turnover(daily: pd.DataFrame, weeks: pd.DatetimeIndex) -> pd.DataFrame:
    """Sum of daily turnover in each Friday-labelled week (NaN when the stock did not trade)."""
    summed = daily.resample("W-FRI").sum(min_count=1)
    return summed.reindex(weeks)


def v1_turnover_expansion(daily: pd.DataFrame, weeks: pd.DatetimeIndex) -> pd.DataFrame:
    """Median daily turnover over the last 4 weeks (20 sessions) / over the last 26 (130)."""
    short = daily.rolling(20, min_periods=15).median()
    long = daily.rolling(130, min_periods=100).median()
    return _at_weeks(short / long, weeks)


def v2_accumulation(weekly_turn: pd.DataFrame, prices: pd.DataFrame) -> pd.DataFrame:
    """Up-week turnover / down-week turnover over 13 weeks. A zero denominator reads as that
    week's 95th percentile (all-up weeks are strong accumulation, not infinity)."""
    change = prices.pct_change()
    turn = weekly_turn.reindex_like(prices)
    up = turn.where(change > 0, 0.0).rolling(13, min_periods=13).sum()
    down = turn.where(change < 0, 0.0).rolling(13, min_periods=13).sum()
    ratio = up / down.where(down > 0)
    all_up = (down == 0) & (up > 0)
    cap = ratio.quantile(0.95, axis=1)
    filler = pd.DataFrame(
        np.repeat(cap.to_numpy()[:, None], ratio.shape[1], axis=1),
        index=ratio.index,
        columns=ratio.columns,
    )
    return ratio.where(~all_up, filler)


def v3_quiet_or_building_blocked(weekly_turn: pd.DataFrame) -> pd.DataFrame:
    """True = blocked: last week's turnover is above the median of the 26 weeks before it, and
    turnover did not rise in each of the last 3 weeks."""
    w0 = weekly_turn
    prior_median = weekly_turn.shift(1).rolling(26, min_periods=20).median()
    quiet = w0 <= prior_median
    building = (w0 > w0.shift(1)) & (w0.shift(1) > w0.shift(2)) & (w0.shift(2) > w0.shift(3))
    known = w0.notna() & prior_median.notna()
    return (known & ~(quiet | building)).astype(bool)


def r1_relative_strength_blocked(prices: pd.DataFrame, nifty500: pd.Series) -> pd.DataFrame:
    """True = blocked: the 26-week return does not beat Nifty 500 TRI's 26-week return."""
    own = prices / prices.shift(26) - 1
    bench = nifty500.reindex(prices.index).ffill()
    hurdle = bench / bench.shift(26) - 1
    return (own.le(hurdle, axis=0) & own.notna() & hurdle.notna().to_numpy()[:, None]).astype(bool)


def m1_overextended_blocked(prices: pd.DataFrame, universe: pd.DataFrame) -> pd.DataFrame:
    """True = blocked: close / 10-week average close in the top 5% of that week's universe
    (`universe`: weeks x column booleans, the point-in-time names ranked that week)."""
    stretch = prices / prices.rolling(10, min_periods=10).mean()
    inside = stretch.where(universe.reindex_like(prices).fillna(False).astype(bool))
    cut = inside.quantile(0.95, axis=1)
    return inside.ge(cut, axis=0).fillna(False).astype(bool)


def m2_residual_sum(prices: pd.DataFrame, nifty500: pd.Series) -> pd.DataFrame:
    """Sum of residuals over weeks t-29..t-4 from a trailing 52-week regression (with intercept)
    of weekly returns on Nifty 500 TRI's; not divided by their standard deviation."""
    from .categories.residual import residual_scores

    return residual_scores(prices, nifty500, {}, standardise=False)


def t1_trend_quality(prices: pd.DataFrame, weeks: int = 26) -> pd.DataFrame:
    """Annualised slope of log weekly close over `weeks` x R^2 of that straight-line fit."""
    y = np.log(prices.where(prices > 0))
    t = pd.Series(np.arange(len(prices), dtype=float), index=prices.index)
    tt = pd.DataFrame(
        np.repeat(t.to_numpy()[:, None], y.shape[1], axis=1), index=y.index, columns=y.columns
    ).where(y.notna())
    n = y.notna().astype(float).rolling(weeks, min_periods=weeks).sum()
    sx = tt.rolling(weeks, min_periods=weeks).sum()
    sy = y.rolling(weeks, min_periods=weeks).sum()
    sxx = (tt * tt).rolling(weeks, min_periods=weeks).sum()
    syy = (y * y).rolling(weeks, min_periods=weeks).sum()
    sxy = (tt * y).rolling(weeks, min_periods=weeks).sum()
    cov = sxy - sx * sy / n
    vx = sxx - sx * sx / n
    vy = syy - sy * sy / n
    slope = cov / vx
    r2 = (cov * cov) / (vx * vy)
    return (slope * 52) * r2.where(vy > 0)
