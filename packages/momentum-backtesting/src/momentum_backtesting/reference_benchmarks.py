"""Dividend-inclusive comparison lines shown alongside every backtest's own benchmark.

The engine's `benchmark` is a column of the dataset being ranked (ETF mode's "Nifty 50"), and
which flavour of return it carries depends on `track`: index mode prices it on the Fyers
`-INDEX` series (price-return, no dividends), ETF mode on NIFTYBEES (whose NAV keeps
dividends). Neither tells you what a passive investor would really have earned, nor whether
the strategy beats the obvious off-the-shelf momentum product. These two lines answer that:

- Nifty 50 TRI: the honest passive alternative (measured 2017-2026: about 1.3 points a year
  above the price index; TODO 3.9.23).
- Nifty200 Momentum 30 TRI: a buyable factor index (an ETF tracks it). Back-calculated by NSE
  before 2020-08-11 - a backtest of the index methodology, not live history.

Both come from `data/stocks/benchmarks_weekly.csv` (`mbt stocks fetch`, niftyindices.com),
or the shared database's `momentum_prices` once those rows are migrated there. When neither
exists the comparisons are simply absent - never an error, since every dataset can run
without them.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from . import metrics
from .config import DATA_DIR
from .stocks.ui_data import NIFTY50_TRI, NIFTY200_MOMENTUM30_TRI

REFERENCES = (NIFTY50_TRI, NIFTY200_MOMENTUM30_TRI)
#: First live (not back-calculated) week of the Nifty200 Momentum 30 index.
MOMENTUM30_LIVE_FROM = pd.Timestamp("2020-08-11")

_CSV_COLUMNS = {"nifty50_tri": NIFTY50_TRI, "nifty200_momentum30_tri": NIFTY200_MOMENTUM30_TRI}


def _from_db() -> pd.DataFrame | None:
    from . import db_read  # noqa: PLC0415 (db_read imports trading_data; keep it lazy)

    if db_read.catalog_mtime() is None:
        return None
    from trading_data.db import connect, data_root  # noqa: PLC0415

    with connect(data_root(), read_only=True) as con:
        # Migration 004 moved these TRIs from `momentum_prices` to `stock_weekly_series`. A
        # read-only connect never migrates, so a catalog last opened for writing before 004 has
        # no such table: that, or no matching rows, means "not in the database" -> the CSV.
        if not db_read._has_table(con, "stock_weekly_series"):
            return None
        rows = con.execute(
            "SELECT week, series, close FROM stock_weekly_series "
            "WHERE series IN (SELECT unnest(?)) ORDER BY week",
            [list(REFERENCES)],
        ).fetchall()
    return db_read._pivot_weekly(rows, "close") if rows else None


def load_references(data_dir: Path | None = None) -> pd.DataFrame:
    """Weekly closes for REFERENCES (Friday-labelled, like every other weekly frame): the
    shared database first, then `<data_dir>/stocks/benchmarks_weekly.csv`. Empty frame when no
    source has them."""
    frame = _from_db()
    if frame is None:
        path = (data_dir or DATA_DIR) / "stocks" / "benchmarks_weekly.csv"
        if not path.exists():
            return pd.DataFrame(columns=list(REFERENCES), dtype=float)
        raw = pd.read_csv(path, index_col=0, parse_dates=True)
        frame = raw[[c for c in _CSV_COLUMNS if c in raw]].rename(columns=_CSV_COLUMNS)
    return frame[[c for c in REFERENCES if c in frame]].sort_index()


def aligned(reference: pd.Series, span: pd.DatetimeIndex) -> pd.Series | None:
    """`reference` on the backtest's weeks, rebased to 1.0 at the first week. A week the
    reference lacks (a holiday-shortened week labelled differently) carries the previous close
    forward one week at most. None when it does not cover the first or last week - a partial
    line would make its CAGR meaningless."""
    s = reference.dropna()
    if s.empty or s.index[0] > span[0]:
        return None
    s = s.reindex(s.index.union(span)).ffill(limit=1).reindex(span)
    if pd.isna(s.iloc[0]) or pd.isna(s.iloc[-1]):
        return None
    return s.ffill() / s.iloc[0]


def compare(equity: pd.Series, references: pd.DataFrame) -> list[dict]:
    """One entry per reference that covers the whole backtest: its rebased curve and the
    strategy's CAGR edge over it."""
    out = []
    if references is None or references.empty or len(equity) < 2:
        return out
    strategy_cagr = metrics.cagr(equity)
    for name in REFERENCES:
        if name not in references:
            continue
        line = aligned(references[name], equity.index)
        if line is None:
            continue
        ref_cagr = metrics.cagr(line)
        depth, _, _ = metrics.max_drawdown(line)
        note = None
        if name == NIFTY200_MOMENTUM30_TRI and equity.index[0] < MOMENTUM30_LIVE_FROM:
            note = "Back-calculated by NSE before 11 Aug 2020"
        out.append(
            {
                "name": name,
                "curve": line,
                "cagr": ref_cagr,
                "excess_cagr": strategy_cagr - ref_cagr,
                "max_drawdown": depth,
                "note": note,
            }
        )
    return out
